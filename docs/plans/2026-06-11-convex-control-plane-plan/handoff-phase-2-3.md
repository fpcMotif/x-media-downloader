# Handoff — Phases 2–3: durable export jobs + provider byte layer

Out of scope for the Phase-1 PR; this is the grounding a follow-up session
needs. Read ADR-0009 and `_index.md` first. All Convex facts below were
verified against docs.convex.dev (2026-06); re-verify before building.

## Phase 2 — durable cloud-export jobs (Convex side)

Goal: "export this Selection to <provider>" becomes a durable, resumable job
ledger in Convex. Bytes still do not transit Convex.

- **Model `job → batches → items`, never one giant operation.** Hard limits
  force this: one mutation writes ≤16 MiB / ≤16k docs and schedules ≤1,000
  functions; query/mutation user code ≤1 s. Create the job in one mutation,
  fan out batch rows from scheduled **internal mutations** (exactly-once,
  auto-retried). Never orchestrate from raw/scheduled **actions** — those are
  at-most-once and not retried.
- **Use the official components instead of hand-rolled actions:**
  - **Workflow** (`@convex-dev/workflow`) for the per-item provider sequence
    (create session → upload chunks → commit → verify → mark done) — durable
    execution, survives server restarts, explicit retries/delays.
  - **Workpool** (`@convex-dev/workpool`) to bound provider-call parallelism.
  - **Action Cache** (`@convex-dev/action-cache`) for URL re-resolution if
    expired CDN URLs must be re-derived.
- **Auth does not propagate to scheduled functions** — pass user/device ids
  explicitly as args. Gate public entry points with the existing
  `SYNC_SHARED_SECRET` pattern or Convex Auth.
- Persist provider resume state on the item row (session URI, upload id,
  committed ranges, destination object id) so retries never restart from byte 0.
- Extension side: reuse the Phase-1 Outbox to post `export_requested` events;
  add paginated status reads (`/api/query`) to the popup — the port in
  `src/core/sync/convex.ts` only needs a `query` method added.

## Phase 3 — provider byte layer (priority order)

1. **S3 first** — presigned URLs + multipart upload (parts retry/parallelize
   independently; AWS recommends multipart ≥100 MB; up to 10,000 parts).
   Industrial-strength target for 1k–10k items on unstable networks.
2. **Google Drive** — resumable upload sessions (recommended >5 MB; session
   URI valid ~1 week; resume via `Content-Range` + `308 Resume Incomplete`).
   Best consumer generic-file destination.
3. **Google Photos** — two-step (upload token → `mediaItems.batchCreate`,
   ≤50 items/call; upload bytes in parallel, batchCreate serially per user;
   200 MB photo / 20 GB video caps). Library destination only.
4. **Dropbox** — upload sessions for automation (single-request upload is the
   wrong primitive; published size ceilings are inconsistent — capability-test
   the chosen SDK). Saver button is a cheap manual path (≤100 public-URL
   files, 15-min window). Prefer App-Folder scope.
5. **iCloud/CloudKit** — deprioritized: CloudKit syncs an app's own data
   model; there is no generic "drop files into iCloud Drive" API peer.

Where bytes originate: re-fetch from the CDN URL cached in `media_state`
(public `pbs.twimg.com`/`video.twimg.com` URLs) either from the extension
(needs the optional twimg host permissions, ADR-0003 Fetched path) or from a
provider-direct transfer (e.g. Dropbox Saver pulls the URL itself). Never
upload through a Convex HTTP action (20 MiB cap).

## Open questions for the next session

- OAuth UX per provider inside an MV3 popup (`chrome.identity.launchWebAuthFlow`
  vs companion web app on the Convex deployment).
- Whether `media_state` should become the Phase-2 `url_cache` table as-is or
  split (current shape: latest state per request id, device-scoped).
- Self-hosted Convex deployments: the runtime origin grant only covers
  `https://*.convex.cloud/*` today; other origins need a manifest change.
