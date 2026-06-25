# x-media-downloader backend — Convex control plane

The opt-in Cloud Sync target for the extension (ADR-0009). It stores
**metadata only**: append-only `sync_events` plus the materialized
`media_state` cache. Media bytes never transit this deployment.

## Deploy

```sh
cd backend
bun install
bunx convex dev        # first run: creates/links a deployment, pushes schema
# or, for production:
bunx convex deploy
```

The deployment URL (`https://<name>.convex.cloud`) goes into the extension
popup under **Cloud sync to Convex → Convex deployment URL**. The popup's
"Grant access" button then requests the runtime host permission.

## Required shared secret

Writes fail closed: a `*.convex.cloud` URL is discoverable and is **not** a
write capability, so `recordEvents` rejects every insert unless the deployment
has a secret configured **and** the caller presents a matching one. Set it on
the deployment:

```sh
bunx convex env set SYNC_SHARED_SECRET <value>
```

and paste the same value into the popup's **Sync secret** field. Until both
sides are set, the extension records nothing (the outbox stays empty rather
than filling with undeliverable events).

## Shape

- `sync:recordEvents` — idempotent batch ingest (skips already-seen
  `eventId`s), called by the extension outbox via `POST /api/mutation`.
- `sync:recentEvents` — newest-first cursor-paginated ledger for future
  dashboard/popup views (`POST /api/query`).

Both reads and writes **fail closed** on the shared `secret` (ADR-0009
hardening): the `recentEvents` / `recentUploadJobs` queries require it too, so a
discoverable `*.convex.cloud` URL never exposes the ledger to an unauthenticated
caller.

Phase 2 (durable export jobs via Workflow/Workpool) and Phase 3 (provider
byte layer) build on these tables — see
`docs/plans/2026-06-11-convex-control-plane-plan/handoff-phase-2-3.md`.
