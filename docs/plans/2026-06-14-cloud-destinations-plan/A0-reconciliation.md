# A0 — Reconciliation brief (read before any Phase-A code)

Settles the three open reconciliations in `_index.md` against the **actually-shipped** Phase-1
mirror, and corrects path/identity assumptions the spec/ADRs got wrong. Grounded by reading
`main:backend/convex/schema.ts` + `sync.ts` (mirror landed on `main` @ `bbdad24`).

## 0. Prerequisite (blocking)

`feat/convex-cloud-destinations` is based off **pre-mirror main (`c3be490`)** and has **no
`backend/`, no `src/core/sync/`, no `src/core/history/`**. **Rebase/merge it onto `main` (`bbdad24`)
first** — otherwise there is nothing to build the byte layer on. Confirm the backend toolchain
(`backend/` is its own bun package with its own `convex` dev) after rebase.

## 1. Backend lives in `backend/convex/`, NOT top-level `convex/`

The spec, ADR-0012/0013, and `_index.md` all say `convex/*`. **Wrong** — the shipped backend is a
separate bun package at **`backend/convex/`** ([schema.ts](../../../backend/convex/schema.ts),
[sync.ts](../../../backend/convex/sync.ts)). Add `cloudConnections` + `uploadJobs` **there**, beside
the existing `sync_events` / `media_state`. Treat every `convex/...` path in the design docs as
`backend/convex/...`.

## 2. Schema — extend `media_state`, do NOT add a 2nd catalog table

Shipped today (device-scoped, no auth):

```ts
sync_events { eventId, kind('queued'|'completed'|'failed'), requestId, deviceId, at, media? }
              .index by_event_id .index by_at
media_state { requestId, deviceId, lastKind, at, media? }     // ← THIS is the catalog/URL cache
              .index by_device_request .index by_at
```

`media_state` already **is** the link catalog the user asked for. `uploadJobs` keys off its
`requestId` (not a new `mediaId`). Add two tables only:

```ts
cloudConnections {
  owner: string,                 // deviceId today; userId after Auth (§3) — keep one field, migrate value
  provider: 'r2'|'s3'|'dropbox'|'google_photos',
  label, enabled: boolean, status: 'active'|'needs_reauth'|'revoked',
  s3Config?: { endpoint?, region, bucket, prefix?, credentialRef?, sealedAccessKeyId?, sealedSecretAccessKey? },
  oauth?:    { sealedRefreshToken, sealedAccessToken?, accessTokenExpiresAt?, accountEmail? },
  createdAt, updatedAt,
}.index by_owner_provider .index by_owner

uploadJobs {
  owner, requestId,              // FK → media_state.requestId
  connectionId, provider,
  status: 'pending'|'uploading'|'succeeded'|'failed'|'dead'|'skipped',
  attempts, nextAttemptAt?, lastError?,
  remoteKey?, remoteUrl?, bytesUploaded?, contentLength?,
  sealedPresignedPost?, presignExpiresAt?,
  idempotencyKey,                // hash(owner + connectionId + requestId)
  createdAt, updatedAt,
}.index by_idempotency .index by_owner_status .index by_status_nextAttempt
```

Secrets (`sealed*`) never read by a public query; `_creationTime` never in an index.

## 3. Identity — shipped is `deviceId` + shared secret; Auth is a MIGRATION (decision)

The mirror is `deviceId`-scoped and gated by `SYNC_SHARED_SECRET` (`recordEvents` arg). There is **no
`userId` and no Convex Auth** yet. ADR-0012 says "Convex Auth day one" — so that is a *migration*
(`deviceId`→`userId`), not greenfield.

- **Option A (matches ADR-0012 literally):** wire Convex Auth now; `owner = userId`; migrate
  `media_state`. Required if the deployment is ever shared/multi-user.
- **Option B (self-host slice):** keep `owner = deviceId` + shared secret for the S3/R2 slice, defer
  Auth until **before** the first OAuth provider.

**Resolved → Option B (default; user can flip to A).** Rationale: the product is a personal,
local-first, single-user extension; `cloudConvexUrl` is the user's own self-pasted deployment (no
vendor default, ADR-0011); S3/R2 keys are user-pasted (not OAuth tokens), so ADR-0013's "real auth
before storing cloud **OAuth** tokens" is not yet triggered; Option B ships the first vertical slice
with the least friction. **Switch to Option A** the moment the deployment becomes shared/multi-user
**or** before the Dropbox/Google OAuth phase (whichever comes first) — `owner` stays one field so the
value migrates `deviceId`→`userId` without a schema change. **Regardless of A/B, code-enforce** that
no `oauth` connection row is ever created under a `device` owner.

## 4. Transport — reuse the fetch port, add a query + trigger

Reuse [`src/core/sync/convex.ts`](../../../src/core/sync/convex.ts) (fetch over `POST /api/mutation`,
no convex npm dep, no WebSocket — correct for the MV3 SW). Add a `query` method (`POST /api/query`
for job status) and an enqueue trigger (`cloud:enqueueUploads` mutation; `runJob` via scheduled
internal action). The popup (page context) may use a reactive client for live status; the SW must
not. New extension code goes in a **new `src/core/cloud/` module** (destination adapters, UploadJob
state machine, `url-guard.ts`) to avoid colliding with the shipped `src/core/sync/`.

## 5. Byte path — presign EVERYTHING (decided 2026-06-14)

No `pipe` special-case (supersedes spec §5.1). For all media: Convex mints a **presigned POST** with
policy conditions (pinned `Content-Type`, `content-length-range`, single server-chosen key under a
per-owner prefix); the extension streams CDN→cloud **in the background SW only**; Convex marks
`succeeded` **only after `HeadObject`** confirms key+size; `confirmUpload` from the extension is a
hint, not the authority. Bytes never transit Convex — consistent with ADR-0009. The SSRF guard
(`src/core/cloud/url-guard.ts`) gates every fetched URL (`media.url` and any preview).

## Net effect on the plan

Phase A tasks are unchanged in intent; only the **paths** (`backend/convex/`, `src/core/cloud/`),
the **catalog** (`media_state`, not `catalogItems`), and the **identity decision** (§3) change.
Phase B–D and the shipping gates (Dropbox approval, Google CASA) stand.
