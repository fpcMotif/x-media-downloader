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

## Optional shared secret

Without a secret, the deployment URL is the only capability gating writes.
To require one, set an environment variable on the deployment:

```sh
bunx convex env set SYNC_SHARED_SECRET <value>
```

and paste the same value into the popup's **Sync secret** field.

## Shape

- `sync:recordEvents` — idempotent batch ingest (skips already-seen
  `eventId`s), called by the extension outbox via `POST /api/mutation`.
- `sync:recentEvents` — newest-first cursor-paginated ledger for future
  dashboard/popup views (`POST /api/query`).

Phase 2 (durable export jobs via Workflow/Workpool) and Phase 3 (provider
byte layer) build on these tables — see
`docs/plans/2026-06-11-convex-control-plane-plan/handoff-phase-2-3.md`.
