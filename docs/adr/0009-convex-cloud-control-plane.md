# ADR-0009 — Opt-in Convex control plane with a separate Drive relay experiment

Convex is an optional metadata control plane, not a dependency of ordinary browser downloads.
An explicit, default-off experiment also permits Cloud-only Google Drive transfers through the user's deployment.
The experiment is implemented but lacks live provider verification; production suitability is not established.

## Decision

Default local downloads, browser cloud uploads, Dropbox, and metadata mirroring retain their existing execution paths.
Cloud Sync mirrors deterministic, append-only Sync Events through a durable local Outbox.
Its payload excludes media bytes, captures, cookies, and provider credentials.
ADR-0018 separately authorizes the opt-in text capture mirror.

Public metadata reads and writes require the configured `SYNC_SHARED_SECRET` and a matching caller secret.
The deployment URL alone grants no access.
The extension uses Convex's HTTP API rather than a persistent WebSocket client.
Host access remains an optional browser permission.

The Drive relay is a distinct authorization boundary, described in [ADR-0013](0013-client-side-cloud-byte-upload.md).
Authenticated submission atomically persists a Server UploadJob and schedules an internal Node action.
Best-effort `upload_jobs` mirror writes cannot create, claim, or authorize Server UploadJobs.
Provider credentials are provisioned separately on the deployment, never copied from extension settings.
Media bytes stream between approved public sources and Drive, never through Convex documents or function arguments.

Disabling the experiment stops new acceptance without removing accepted job status.
The master upload switch stops further requests at the next chunk/request boundary.
Disconnect invalidates backend authorization, including previously accepted jobs.
Existing Cloud Sync remains metadata-only regardless of this separate experiment.

## Constraints and alternatives

HTTP action request/response limits do not establish limits on outbound streaming from Node actions.
A full-buffer memory estimate therefore cannot prove that streaming video is impossible.
The current Convex documentation specifies a ten-minute action timeout and 512 MB Node memory allowance.
Actual transfer feasibility, memory overhead, source access, and costs require measurement.

The implementation uses one globally leased worker, bounded chunks, transactional checkpoints, and bounded retries.
A lost action invocation recovers through a scheduled lease watchdog.
The worker's deadline is shorter than the platform deadline; its lease outlasts that platform deadline.
These choices prevent a replacement worker from overlapping a still-running predecessor.

A mandatory cloud backend remains rejected because it would change the default privacy and availability contract.
Temporary Convex file storage remains unnecessary; it would add storage and egress costs without proving streaming feasibility.
The browser remains the default byte path until the experiment produces acceptable live evidence.

## Evidence

Backend tests cover authenticated acceptance, duplicate submission, fencing, controls, bounded transfer, and ambiguous completion reconciliation.
Extension tests cover metadata-only queue submission, exclusive ownership, and history recovery after reopening.
Mocks establish those contracts, not provider feasibility.
See [setup and experiment evidence](../cloud-upload-setup.md) for prerequisites and the incomplete live-verification boundary.
