# ADR-0020 — Shared durable storage RMW and autonomous Sync wake

- **Status:** Accepted (2026-07-16)
- **Builds on:** [ADR-0009](0009-convex-cloud-control-plane.md),
  [ADR-0013](0013-client-side-cloud-byte-upload.md), and
  [ADR-0017](0017-fetchservice-layer-and-cloud-runtime.md).

## Context

Sync Outbox, Capture Outbox, and Cloud Upload each persist a separate ledger.
Their batch, retry, failure, claim, and wake rules differ. Their storage risk is
the same: interleaved read-modify-write steps can lose an update.

Sync also had durable backoff state but no durable wake. A suspended service
worker could leave pending events idle until boot or a new download.

## Decision

Share one `DurableStore` interface and `runSerializedRmw` helper. Each shell keeps
its own ledger and drain loop.

Add a `sync-outbox-drain` browser alarm. Sync schedules it at the stored backoff
deadline, clears it when no delayed work remains, and drains through its existing
serial queue when the alarm fires.

Cap each Capture mirror mutation at 64 records. This is far below Convex's
16 MiB argument and 16,000-document transaction limits.

Promise orchestration stays outside Effect. Cloud Upload fencing and alarm logic
stay unchanged. Capture gets no new backoff or wake policy.

## Consequences

- Storage updates are serialized through one tested helper.
- Sync retries after service-worker suspension without a new download.
- Sync still stops on failure. Upload still continues. Capture stays best-effort.
- The three storage keys and schemas remain separate.
