# X Media Downloader backend

## At a glance

The extension's optional Convex backend stores metadata and durable upload state.
A separately authorized, default-off experiment can stream Cloud-only Google Drive uploads through a Node action.
Ordinary browser uploads, Dropbox, and metadata mirroring remain unchanged.

## Deployment

The backend is a separate Bun package:

```sh
cd backend
bun install --frozen-lockfile
bun run typecheck
bun run test
```

Identify and approve the deployment before running `bunx convex dev --once` or `bunx convex deploy`.
Those commands mutate a deployment; local tests do not authorize a production rollout.

Public functions fail closed without `SYNC_SHARED_SECRET` and a matching request secret.
A discoverable deployment URL is not an authorization capability.
No private environment values belong in logs, artifacts, or committed files.

## Metadata services

- `sync:recordEvents` accepts idempotent state events.
- `sync:recentEvents` exposes an authenticated, paginated ledger.
- `uploads:recordUploadJobs` mirrors browser upload state; it cannot authorize server execution.
- Capture functions maintain the separately enabled text capture mirror.

## Experimental server uploads

`relay:submit` atomically persists a metadata-only Server UploadJob and schedules internal execution.
`relay:status` exposes authenticated status without Drive sessions or credentials.
`relay:budget` exposes the daily usage tally committed atomically with new acceptance.
`relay:control` applies admission, master-switch, and disconnect state.
`relay:retry` respects the persisted lifetime and failure limits.
`relayWorker:probe` performs authenticated source-size admission without browser source requests.
Internal claims, checkpoints, authorization checks, and scheduled actions are not public upload APIs.

Drive OAuth credentials are provisioned explicitly in deployment environment variables.
They are never copied from extension settings.
Media bytes travel through bounded Node streams, not Convex documents, storage, arguments, or results.

See [setup](../docs/cloud-upload-setup.md), [ADR-0013](../docs/adr/0013-client-side-cloud-byte-upload.md), and [experiment evidence](../docs/experiments/convex-drive-relay.md).
Live provider verification is incomplete until credentials and an approved test folder are available.
