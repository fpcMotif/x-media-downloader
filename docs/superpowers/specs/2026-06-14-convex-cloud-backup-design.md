# Media Backup — Convex catalog + cloud mirrors

**Status:** Design approved (brainstorming) · **Date:** 2026-06-14 · **Next:** Phase-0 prototype → implementation plan

## Goal

Defend grabbed X/Twitter media against link-rot. X's original media URLs (`twimg.com` `name=orig`, video MP4 variants) expire or get deleted. This feature captures every grabbed media item's **original link + metadata** into Convex, stores the **actual bytes** as a primary durable copy in Convex file storage, and optionally **mirrors** the bytes out to the user's own cloud accounts.

This is a new backend integration: there is no Convex code in the repo today (the plugin is installed, nothing wired). It layers on top of the existing download pipeline without replacing it.

## Locked decisions

| Decision | Choice |
|---|---|
| Primary purpose | Durable backup against link-rot |
| Convex role | Source of truth: link/metadata catalog **+** media bytes in Convex file storage (primary durable copy) |
| Default durable store | **Convex storage only.** No app-managed bucket. |
| Cloud providers | R2, S3, Dropbox, Google Photos, iCloud(CloudKit) — **all bring-your-own-account, per-user** |
| Identity | Convex Auth sign-in (cross-device, multi-user) |
| Trigger | **Flexible:** auto-on-download (toggleable) **+** on-demand "Back up" (per item / per tweet / back-up-all) |
| Byte path | **A** — extension fetches original bytes (it has the X session), hands them to Convex; cloud mirroring is server-side from Convex |
| iCloud | CloudKit container (server-to-server) — heaviest, Phase 3, experimental |

## Architecture

```
  ┌─────────────────────── EXTENSION ───────────────────────┐
  │  overlay/popup ──grab──▶ background SW                   │
  │                            │ 1. fetch original bytes     │
  │                            │    (reuses X session/perms) │
  │                            ▼                              │
  │                       ConvexHttpClient                    │
  │                         ├─ generateUploadUrl              │
  │                         ├─ upload bytes ───────────────┐  │
  │                         ├─ catalogAsset (link+meta+id) │  │
  │                         └─ requestMirror(providers[])  │  │
  └─────────────────────────────────────────────────────────┘  │
                                                                ▼
  ┌──────────────────────────── CONVEX ─────────────────────────┐
  │  tables: mediaAssets · mirrors · connections · (auth users)  │
  │  storage: original media bytes  ← primary durable copy       │
  │                                                              │
  │  action mirrorAsset ──fan-out──▶ R2 · S3 · Dropbox ·         │
  │     (per-user creds from `connections`)  Google Photos ·     │
  │                                          CloudKit            │
  └──────────────────────────────────────────────────────────────┘
                    ▲ reactive queries (live mirror status)
  popup "Library" / status view ◀──────────────────────────────┘
```

Convex is the source of truth and the guaranteed durable copy. Cloud providers are **secondary mirrors** fanned out server-side, so the browser never streams big uploads to five APIs — it does the single fetch it's already good at.

## Convex backend

All rows scoped by `userId` from Convex Auth.

**Tables**
- `mediaAssets` — natural key `(userId, mediaId)`. Fields: `mediaId`, `tweetId`, `handle`, `type` (photo|video|gif), `url` (original), `previewUrl?`, `ext`, `width?`, `height?`, `bitrate?`, `sourceTweetUrl`, `storageId?` (Convex file), `bytes?`, `capturedAt`. Indexes: `by_user_media (userId, mediaId)` (idempotency), `by_user_captured` (library feed).
- `mirrors` — one row per `(assetId, provider)`. Fields: `assetId`, `userId`, `provider`, `status` (pending|uploading|done|failed), `providerRef?`, `error?`, `updatedAt`. Indexes: `by_asset (assetId)`, `by_user_status (userId, status)` (retry sweeps).
- `connections` — per-user provider credentials. Fields: `userId`, `provider`, `kind` (bucket|oauth|cloudkit), `secretRef` (encrypted token / bucket creds / CloudKit key), `accountLabel`, `scopes?`, `createdAt`. Index: `by_user_provider (userId, provider)`.

**Functions**
- `generateUploadUrl` (mutation) — standard Convex upload handshake.
- `catalogAsset` (mutation) — idempotent upsert on `(userId, mediaId)`; records link/metadata + `storageId`. Returns `assetId`. Re-grab of the same media is a no-op write.
- `requestMirror` (mutation) — upsert `mirrors` rows (`pending`) for the chosen providers, then schedule `mirrorAsset`.
- `mirrorAsset` (action) — for each pending mirror: load the stored blob, call the provider adapter's `upload`, write `done`/`failed` + `providerRef`. Idempotent per `(assetId, provider)`.
- `listLibrary` / `assetStatus` (queries) — reactive feed + per-asset rollup for the popup.
- `connections.{connect,disconnect,list}` — manage per-user provider auth.

## Provider adapters

Single interface keeps the pipeline closed to provider churn:

```ts
interface DestinationAdapter {
  id: 'r2' | 's3' | 'dropbox' | 'gphotos' | 'cloudkit'
  kind: 'bucket' | 'oauth' | 'cloudkit'
  isConfigured(conn: Connection): boolean
  upload(blob: Blob, meta: AssetMeta, conn: Connection): Promise<{ providerRef: string }>
}
```

| Provider | Auth (per-user, in `connections`) | Notes | Phase |
|---|---|---|---|
| Cloudflare R2 | bucket: account id + access key/secret + bucket (S3 API) | One S3-compatible adapter covers R2 + S3 | 1 |
| AWS S3 | bucket: access key/secret + region + bucket | same adapter | 1 |
| Dropbox | oauth: token + refresh | `/files/upload` (or upload session for >150MB) | 2 |
| Google Photos | oauth: token + refresh | 2025 API restrictions: app can mostly manage only what it uploaded — acceptable here | 2 |
| Apple iCloud | cloudkit: server-to-server key + container | App's CloudKit container, **not** the user's iCloud Photos. Experimental. | 3 |

No provider creds in Convex env — everything is per-user. Backups are durable via Convex storage even with zero providers connected.

## Extension integration

- **Sign-in** (popup): Convex Auth; gates library + backup. Background SW and popup both get a `ConvexHttpClient` (writes) / `ConvexReactClient` (popup reactive status).
- **Auto hook**: in `src/entrypoints/background.ts` after a successful download (`downloads.onChanged` complete), if `autoBackupOnDownload` + signed in, run the backup orchestration for that item.
- **On-demand**: extend the existing per-media badge (`src/core/badge.ts` + overlay) with a backup affordance/state; add "Back up all" to the dock; show mirror status in the popup. Reuses the badge state machinery already built.
- **New module** `src/core/backup/` — Convex client wiring, the asset→catalog→mirror orchestration, and the trigger glue. Kept separate from `core/download/` (one clear purpose each).
- **Settings additions** (`src/core/schema/index.ts` `Settings`): `backupEnabled`, `autoBackupOnDownload`, `defaultMirrorProviders: string[]`. Plus a "Connections" panel in the popup for connect/disconnect.

## Sync state machine (per asset)

```
detected ──catalog──▶ cataloged ──upload──▶ stored        (durable in Convex)
                                              │
                                  per provider └──▶ pending ─▶ uploading ─▶ done
                                                                         └─▶ failed ─(retry)─▶ pending
```

Asset-level rollup status is derived from its `mirrors` rows. `stored` already means "safe from link-rot"; provider mirrors are best-effort extras. Failed mirrors retry independently (manual button + a `by_user_status` sweep later).

## Security / privacy

- Provider secrets live only in `connections`, encrypted at rest; never logged, never sent to the client after save (client sees `accountLabel` only).
- Convex Auth scopes every row by `userId`; no cross-user reads.
- The extension uploads bytes over HTTPS to Convex; original-URL fetch reuses existing host permissions, no new broad grants.

## Phasing

- **Phase 0 — prototype (throwaway):** model the data + state machine end-to-end with a fake in-memory provider. Validate that catalog → store → mirror, the trigger flexibility, and the per-asset rollup *feel right* before committing. (Built next via `/prototype`.)
- **Phase 1:** Convex Auth + `catalogAsset` + Convex storage upload + S3-compatible adapter (R2/S3, per-user creds) + auto/on-demand triggers + minimal status UI.
- **Phase 2:** Dropbox + Google Photos OAuth connectors + a real Library view.
- **Phase 3:** CloudKit/iCloud adapter + retry sweeps + backfill of pre-existing downloads.

## Out of scope (YAGNI for now)

- Server-side fetch of original URLs (byte path B) — revisit as an optimization for public images.
- Sharing/public collections.
- De-dup of identical bytes across tweets.
- Scheduled/background re-verification that mirrors still exist.
