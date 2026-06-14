# ADR-0012 — Convex link catalog + extension sync seam

- **Status:** Proposed (2026-06-14)

## Context

There is no Convex code in the repo today (the plugin is installed, nothing wired). We need a
backend that holds a deduped catalog of grabbed media links + per-item upload status, and an
extension-side seam that feeds it without changing the local download path. Constraints that shape
the design (verified against docs.convex.dev/production/state/limits):

- Action wall-clock **10 min**; action memory **V8 64 MiB / Node 512 MiB**; function args/returns
  **16 MiB** (Node action args **5 MiB**); single document **1 MiB**; schedule fan-out 1000/mutation.
- An MV3 service worker is ephemeral (killed ~30 s idle), has no DOM, and cannot hold a live
  WebSocket reliably — so the reactive `ConvexReactClient` is wrong for the SW.
- Effect v4 lives in the extension; Convex code is plain TypeScript (`convex/values` validators).

## Decision

- **Schema (all rows `userId`-scoped):**
  - `users` — keyed by JWT `subject` (`by_subject`); not a hand-rolled session store.
  - `catalogItems` — one row per synced `MediaItem`, **deduped by `(userId, mediaId)`**; mirrors the
    `MediaItem` fields plus `firstSyncedAt`/`lastSeenAt`/`sourceCheckedAt`/`sourceGone`. Indexes
    `by_user_media`, `by_user_tweet`, `by_user`. (No index includes `_creationTime` — reserved.)
  - `cloudConnections` — per-user provider config + **AES-GCM-sealed** tokens/keys
    (`CRED_ENC_KEY`); never read by any public query.
  - `uploadJobs` — one row per `(catalogItem, connection)`, **deduped by `idempotencyKey`**, with
    `status`/`mode`/`attempts`/`nextAttemptAt` and indexes `by_idempotency`, `by_item_conn`,
    `by_user_status`, `by_status_nextAttempt` (retry sweep). Bytes never live in a row.
- **One extension-facing write:** `syncItems(items, connectionIds?)` — idempotent catalog upsert +
  enqueue one job per enabled connection (reuse/resurrect by `idempotencyKey`, never insert a
  duplicate). Reads (`myCatalog`/`myJobs`/`catalogSummary`) are paginated, never `.collect()`.
- **Function-kind discipline:** public mutations/queries never read or return a secret; twimg fetch,
  provider uploads, presign signing, and token refresh happen only in `"use node"` actions;
  status transitions are `internalMutation`s; secret reads are `internalQuery` invoked only from
  actions.
- **Idempotency, three guards + a lease:** one job per `idempotencyKey`; `runJob` early-returns on
  `succeeded`/`dead` **and** takes a short compare-and-set `running` lease (closes the
  sweeper/re-sync double-fire window); provider-level dedupe (`S3 IfNoneMatch:"*"`, Dropbox
  autorename, Google upload-token).
- **Retry:** a 1-min cron sweeps due `failed` jobs (index-driven `by_status_nextAttempt`, bounded
  batch) with exponential backoff + jitter; `MAX_ATTEMPTS ≈ 5` → `dead` (terminal).
- **Extension seam (Effect v4):** a `SyncService` (`Context.Service` + `Layer.succeed`, mirroring
  `SettingsService`) wraps a `ConvexHttpClient` for fire-and-forget writes from the SW; the popup
  (a real page context) holds a short-lived `ConvexReactClient` for live status. Writes flow
  through a durable `local:sync-queue` so an SW recycle never loses a sync. The sync trigger fires
  on **download-complete** (`downloads.onChanged` terminal `complete`) — the moment bytes are known
  to be on disk — and/or on-demand; **never** on passive capture. The local download path is
  unchanged and the seam is fail-closed when sync is off.
- **Auth (tiered, see ADR-0011/0011):** `users.subject` keying makes a Tier-1→Tier-2 upgrade a
  schema no-op.

## Consequences

- Re-grabbing the same media is a cheap no-op write; the catalog is a clean source of truth for
  status without duplicating rows.
- Status is **popup-driven (poll/reactive-while-open), not pushed** to the page — the SW cannot
  reliably push to an open overlay. The badge ends at `saved`/`syncing` and reconciles lazily via
  `local:sync-mirror`.
- A new top-level `convex/` directory and a new `src/core/sync/` module are introduced; the
  Effect↔plain-TS boundary stays clean (a `toMediaItemInput` adapter bridges the two type systems).
- New runtime capability "talk to my Convex deployment" is a **runtime-requested
  `optional_host_permissions`** for `*.convex.cloud` / `*.convex.site`, mirroring the aria2/offscreen
  opt-in — not a static broad grant.

## Alternatives considered

- **Reactive `ConvexReactClient` in the SW** — rejected: SW death + no DOM make a held subscription
  unreliable; `ConvexHttpClient` per-write is the correct fit.
- **Server→extension push for live badge status** — rejected: no reliable MV3 channel without a
  held connection; lazy reconciliation via storage mirror instead.
- **Store media bytes in a `catalogItems` row** — impossible (1 MiB doc limit) and undesirable;
  bytes go to provider storage (or optionally Convex file storage as a separate durable copy, per
  ADR-0013 §open).
- **No offline buffer (direct write on the hot path)** — rejected: an SW recycle mid-write would
  silently drop syncs; the durable queue is the honest fix for the hand-off blind spot.
