# Implementation Plan — Cloud Destinations (byte-transfer layer on the Convex control plane)

- **ADRs:** [0011 local-first privacy](../../adr/0011-local-first-cloud-sync-privacy-model.md) ·
  [0012 Convex catalog + sync seam](../../adr/0012-convex-link-catalog-and-sync-seam.md) ·
  [0013 server-side cloud destinations](../../adr/0013-server-side-cloud-destinations.md)
- **Spec:** [2026-06-14-convex-cloud-backup-design.md](../../superpowers/specs/2026-06-14-convex-cloud-backup-design.md)
- **Date:** 2026-06-14
- **Branch:** `feat/cloud-targets-sync`
- **Approach:** Test-first (red→green→refactor) per task. Pure reducers with injected timestamps
  (metrics/history precedent, ADR-0008/0010); effectful seams behind fetch-injected ports (aria2
  precedent, ADR-0006; the existing `src/core/sync/convex.ts` port). Effect **v4** idioms only
  (`.claude/skills/effect-v4`). Convex code is plain TS.

> ⚠️ **Builds on shipped work.** Phase 1 of the cloud story — the **opt-in metadata mirror**
> (`SyncEvent` + Outbox + `media_state`, "Convex = metadata only, **never bytes**") — already exists
> on `claude/elegant-franklin-g4ofol` ([ADR-0009](../../adr/0009-convex-cloud-control-plane.md),
> [ADR-0010](../../adr/0010-durable-local-download-history.md), `src/core/sync/{events,outbox,convex}.ts`,
> plan `2026-06-11-convex-control-plane-plan/` + its `handoff-phase-2-3.md`). **This plan is that
> handoff's Phase 2–3, hardened.** It does **not** re-build the mirror; it extends it with cloud
> destinations. Task A0 reconciles the two schemas before any new code lands.

> ⚠️ **Grounding (re-verify before building).** Convex (docs.convex.dev, 2026-06): HTTP API
> `POST /api/mutation|/api/query` envelope; HTTP actions ≤20 MiB; **scheduled mutations**
> exactly-once/auto-retried, **scheduled actions** at-most-once/not-retried; per-mutation ≤16 MiB /
> ≤16k docs / ≤1,000 scheduled fns; user-code 1 s; **auth does not propagate to scheduled fns**
> (pass ids explicitly); action memory V8 64 MiB / Node 512 MiB; action wall-clock 10 min. Provider
> facts: S3+R2 share SigV4; Dropbox 50-user cap until Production approval; Google Photos
> `photoslibrary.appendonly` + likely CASA assessment; iCloud has no server upload API.

## Context

The metadata mirror gives us a durable, deduped ledger of grabbed media (the user's
*"sync the links into Convex"*). This plan adds the **byte-transfer layer**: copying the actual
media into the user's own cloud (R2/S3 → Dropbox → Google Photos), orchestrated server-side by
Convex so provider secrets never touch the extension. **Bytes never transit Convex** (ADR-0009,
reaffirmed): Convex mints presigned/resumable upload targets and verifies completion; the extension
(which holds the live X session `video.twimg.com` needs) streams CDN→cloud directly. iCloud is
documented-only (no API). The local download path is untouched; everything here is opt-in,
off-by-default, behind layered consent (ADR-0011).

### Reconciliation decisions to settle in Task A0 (flagged, not pre-decided)

1. **Schema unification.** Spec uses `catalogItems`/`syncItems`; shipped mirror uses
   `sync_events`/`media_state` + the deterministic-`eventId` Outbox. **Recommendation:** keep the
   shipped `media_state` as the catalog/URL-cache (it is the "link sync" already), and add
   `cloudConnections` + `uploadJobs` *alongside* it — do **not** introduce a parallel `catalogItems`.
   `syncItems` becomes "ensure `media_state` row + enqueue `uploadJobs`."
2. **Transport.** Reuse the shipped minimal fetch port (`src/core/sync/convex.ts`, no convex npm dep,
   no WebSocket in the SW) and just add `query`/`action`-trigger methods — rather than introducing
   `ConvexHttpClient`. The popup may use a reactive client (page context) for live status.
3. **Byte path consistency.** The spec's "photos pipe *through* a Convex action" contradicts the
   shipped "never bytes through Convex." **Recommendation:** drop the pipe special-case — **all
   media presign + stream from the extension**; Convex only signs + verifies. One path, consistent
   with ADR-0009, zero Convex egress. (Confirm with user; the spec's §9-Resolved already chose
   provider-as-durable / no Convex byte storage.)

## Execution Plan

```yaml
phases:
  - id: A   # Foundation & reconciliation (no external review)
    tasks:
      - id: "A0"
        subject: "Reconcile schemas: keep media_state, add cloudConnections+uploadJobs; settle byte path (decision doc)"
        slug: "reconcile"
        type: "design+impl"
        depends-on: []
      - id: "A1"
        subject: "Convex schema — cloudConnections (sealed creds) + uploadJobs (idempotencyKey, backoff) + indexes (test→impl)"
        slug: "schema"
        type: "test+impl"
        depends-on: ["A0"]
      - id: "A2"
        subject: "Convex Auth (day one) + requireUser; users keyed by JWT subject; gate connects to non-device issuer (test→impl)"
        slug: "auth"
        type: "test+impl"
        depends-on: ["A0"]
      - id: "A3"
        subject: "AES-GCM seal/open (CRED_ENC_KEY) + per-user object-key derivation/sanitizer (test→impl)"
        slug: "crypto-keys"
        type: "test+impl"
        depends-on: ["A1"]
      - id: "A4"
        subject: "SSRF guard — exact-host allow-list (pbs/video.twimg), per-hop redirect revalidation, RFC-1918 block; validates url AND previewUrl (test→impl)"
        slug: "ssrf-guard"
        type: "test+impl"
        depends-on: []
      - id: "A5"
        subject: "Settings additions — cloudSyncEnabled/syncTrigger/cloudConvexUrl(no default)/defaultDestinationIds (test→impl)"
        slug: "settings"
        type: "test+impl"
        depends-on: []
      - id: "A6"
        subject: "Destination adapter contract + UploadJob state machine (pure reducer: queued→fetching/uploading→succeeded/failed/dead, lease) (test→impl)"
        slug: "destination-seam"
        type: "test+impl"
        depends-on: ["A1"]
  - id: B   # S3/R2 vertical slice (no external review — ship first)
    tasks:
      - id: "B1"
        subject: "S3/R2 adapter — one SigV4 path; presigned POST with content-type + content-length-range + fixed server key (test→impl)"
        slug: "s3r2-adapter"
        type: "test+impl"
        depends-on: ["A3", "A6"]
      - id: "B2"
        subject: "runJob action (use node): mint presign → extension streams → HeadObject verify before succeeded; confirmUpload is a hint only (test→impl)"
        slug: "runjob"
        type: "test+impl"
        depends-on: ["B1", "A4"]
      - id: "B3"
        subject: "Extension upload streaming in background SW only (never content script); runtime optional_host_permissions at connect (test→impl)"
        slug: "stream-upload"
        type: "test+impl"
        depends-on: ["B2"]
      - id: "B4"
        subject: "Durability — @convex-dev/workpool bound concurrency + @convex-dev/workflow for multi-step upload; cron retry sweep + backoff (test→impl)"
        slug: "durable-jobs"
        type: "test+impl"
        depends-on: ["B2"]
      - id: "B5"
        subject: "Options page (options_ui) — connect S3/R2 (keys form), per-destination enable, per-destination consent gate copy (impl)"
        slug: "options-page"
        type: "impl"
        depends-on: ["A2", "A5"]
      - id: "B6"
        subject: "Popup status line + badge syncing/synced (best-effort, popup-driven via local:sync-mirror) + disclosure gate (impl)"
        slug: "popup-status"
        type: "impl"
        depends-on: ["A5", "B2"]
      - id: "B7"
        subject: "Disconnect & wipe — revoke-then-delete, revoke-failed surfacing, 'files remain in your cloud' dialog copy (test→impl)"
        slug: "wipe"
        type: "test+impl"
        depends-on: ["B5"]
  - id: C   # Dropbox (light external review — start approval in parallel)
    tasks:
      - id: "C1"
        subject: "OAuth Pattern B — startOAuth mutation + httpAction /oauth/dropbox/callback; seal refresh token server-side (test→impl)"
        slug: "dropbox-oauth"
        type: "test+impl"
        depends-on: ["A2", "A3"]
      - id: "C2"
        subject: "Dropbox adapter — App-folder scope, upload session for >150MB, token refresh (test→impl)"
        slug: "dropbox-adapter"
        type: "test+impl"
        depends-on: ["C1", "A6"]
      - id: "C3"
        subject: "Kick off Dropbox Production approval (50-user cap) the day OAuth works — external dependency"
        slug: "dropbox-approval"
        type: "ops"
        depends-on: ["C1"]
  - id: D   # Google Photos (demand-gated; CASA prerequisite)
    tasks:
      - id: "D0"
        subject: "PREREQUISITE gate — publish privacy policy + verify domain + approve CASA budget before any Photos code"
        slug: "gphotos-prereq"
        type: "ops"
        depends-on: []
      - id: "D1"
        subject: "Google Photos adapter — appendonly, upload token → mediaItems:batchCreate (≤50/call); Pattern B OAuth (test→impl)"
        slug: "gphotos-adapter"
        type: "test+impl"
        depends-on: ["D0", "C1", "A6"]
      - id: "D2"
        subject: "Library view (reactive myCatalog/myJobs) + backfill of cataloged history (honest sourceGone, never fake save) (impl)"
        slug: "library-backfill"
        type: "impl"
        depends-on: ["B6"]
  # DROPPED: iCloud — no server upload API (ADR-0013 §7). No adapter, no UI row.
```

## Task specs (highlights)

### A0 — Reconcile (`docs/` decision note + thin code)
Resolve the three reconciliation decisions above into a short ADR addendum or note; pick the
schema/transport/byte-path shape so B+ build on one model. **Acceptance:** a written decision; no
two competing catalog tables; the byte-path special-case settled (recommend presign-everything).

### A1 — Convex schema (`convex/schema.ts`)
`cloudConnections` (per-user provider config; `s3Config` non-secret + sealed keys; `oauth` sealed
refresh token; `status` active/needs_reauth/revoked) and `uploadJobs` (`(catalogItem|media_state,
connection)`, `status`/`mode`/`attempts`/`nextAttemptAt`, `idempotencyKey`, sealed presign).
Indexes `by_user_provider`, `by_idempotency`, `by_user_status`, `by_status_nextAttempt`. No
`_creationTime` in any index. **Bytes never in a row.** Secrets never read by a public query.

### A2 — Convex Auth
Real per-user identity from day one (spec §9-Resolved). `requireUser` upserts `users` by JWT
`subject`. **Code-enforce:** `connectS3`/`startOAuth` reject a `device`-issuer subject (no cloud
token under anonymous tier-1). **Acceptance:** unauthed `syncItems`/connect throws; connect under a
device JWT is refused.

### A4 — SSRF guard (`src/core/sync/url-guard.ts` + Convex `lib/urlGuard.ts`)
Single egress wrapper; every fetched URL passes `assertAllowedMediaUrl`: https-only, exact host in
{`pbs.twimg.com`,`video.twimg.com`}, no credentials, port 443, `redirect:"manual"` with the full
guard re-run on each `Location` (bounded hops), and RFC-1918/link-local/169.254/metadata-IP block.
Validate `url` **and** `previewUrl`. **Acceptance (vitest):** allows a real `pbs`/`video.twimg` URL,
rejects a redirect to a non-allowlisted host, rejects a 10.x/169.254 target.

### B1/B2/B3 — S3/R2 vertical slice (the integrity core)
**Presigned POST with policy conditions** (pinned `Content-Type`, `content-length-range`, single
server-chosen key under a per-user prefix) — never a bare PUT with a client key. The extension
streams **in the background SW only**. Convex marks `succeeded` only after an out-of-band
`HeadObject` confirms key+size; `confirmUpload` from the extension is a hint, not the authority
(closes the integrity hole + the hand-off blind spot). Runtime `optional_host_permissions` for the
specific bucket origin requested at connect (lead with R2 — stable enumerable host).

### B4 — Durability
Route enqueues through `@convex-dev/workpool` (bounded per-user parallelism, retries, observability)
and `@convex-dev/workflow` (durable multi-step provider sequence for Dropbox session / Google
two-phase). Cron `retry-failed-uploads` (1 min) sweeps `by_status_nextAttempt` due `failed` jobs on
exp-backoff+jitter; `MAX_ATTEMPTS≈5 → dead`. Idempotency: one job per `idempotencyKey` + `runJob`
early-return on succeeded/dead + a compare-and-set `running` lease + provider dedupe
(`IfNoneMatch:"*"`, Dropbox autorename, Google upload-token).

### C1 — OAuth Pattern B
Redirect URI = `https://<dep>.convex.site/oauth/:provider/callback`. `startOAuth` mints a `state`
nonce tied to the user; the popup opens the consent URL (`launchWebAuthFlow` or a tab); the
httpAction exchanges code→token with the server-held secret and **seals the refresh token** into
`cloudConnections` — it never touches the extension; no provider host permission needed for OAuth.

## Testing strategy

- **Vitest (pure units):** UploadJob state machine + lease; SSRF guard; object-key
  derivation/sanitizer; settings additions incl. corrupt-recovery defaults; the sync trigger reducer
  (download-complete → enqueue, never on passive capture).
- **Convex function tests:** `syncItems` idempotency (re-sync = no dup job), `requireUser`/connect
  gating (device issuer refused), retry sweeper selection, `HeadObject`-gated `succeeded`.
- **Manual gates before "done":** a real `ext_tw_video`/`ampl_video` URL through B2/B3 before
  claiming video works; the disclosure + per-destination consent gates; reduced-motion.
- **No change** to the existing passive/download/test surface; the local path stays green.

## Out of scope / deferred

- **iCloud** (ADR-0013 §7) — no server API; document-only, revisit as a Shortcuts hand-off after R2.
- **Google Drive** — the shipped handoff ranked it high; not in the user's destination set, defer.
- **Cross-tweet byte dedupe, sharing/public collections, scheduled re-verification of mirrors.**
