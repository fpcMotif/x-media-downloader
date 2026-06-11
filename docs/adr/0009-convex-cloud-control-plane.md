# ADR-0009 — Convex as an opt-in cloud control plane (metadata only, never bytes)

- **Status:** Accepted (2026-06-11)

## Context

Users want durable, cross-session/cross-device visibility into what was grabbed
(a URL/state cache, a job ledger that survives browser close) and, later, cloud
export of selections to S3/Drive/Photos/Dropbox. Two constraints shape any
remote backend here:

- **Product promise:** v1 is local-only ("Local-only · no tracking", ADR-0005:
  captures are sensitive and session-scoped; no persistent history). A remote
  backend must be **opt-in** and must never receive captures, auth headers, or
  media bytes.
- **Convex platform facts** (verified against docs.convex.dev, 2026-06):
  HTTP actions cap request/response at 20 MiB; actions are at-most-once and not
  auto-retried; **scheduled mutations are exactly-once with automatic retries**;
  a mutation may write ≤16 MiB / ≤16,000 docs and schedule ≤1,000 functions;
  query/mutation user code is capped at 1 s. Convex is a strong reactive
  metadata + durable scheduling platform and a poor 1k–10k-file byte pipe.

## Decision

Convex becomes a **sidecar control plane**, three-layered:

1. **Local execution layer (unchanged):** browser/aria2 own all media bytes
   (ADR-0002/0003/0006). Default behavior is byte-for-byte what it is today.
2. **Metadata/orchestration layer (new, opt-in):** the background SW mirrors
   append-only **Sync Events** (`queued` / `completed` / `failed`, metadata
   only) into Convex through a local **Outbox**:
   - Events carry a deterministic `eventId` (`device/request/kind`) so server
     writes are **idempotent**; re-sending a batch is harmless.
   - The Outbox persists to `storage.local`, drains FIFO in batches of ≤64 via
     `POST {deployment}/api/mutation` (`sync:recordEvents`), and backs off
     exponentially on failure. Downloads never block on, or fail because of,
     the cloud.
   - Transport is a minimal `fetch`-based port over Convex's public HTTP API
     (the `makeAria2RpcPort` pattern) — **no convex npm dependency, no
     WebSocket client** in the MV3 worker.
3. **Byte-transfer layer (future, Phase 3):** provider-native resumable/
   multipart uploads (S3, Drive, Photos, Dropbox). Bytes never transit Convex.

Privacy/permissions posture:

- Default **off** (`cloudSyncEnabled: false`). The `https://*.convex.cloud/*`
  origin is an **optional** host permission requested at runtime on enable
  (aria2-localhost precedent). The popup footer says "Cloud sync on · metadata
  only" while enabled — the "Local-only" claim is never shown untruthfully.
- Mirrored data is CDN URLs + tweet/handle/type provenance only. Sidecar
  `data:` URLs, captures, and auth material are structurally excluded by the
  `SyncEvent` schema. Disabling sync clears the Outbox.
- An optional shared secret (Convex env var `SYNC_SHARED_SECRET`) gates the
  public mutation.

## Consequences

- Local-only default mode is untouched; cloud mode gains a durable,
  device-tagged ledger and URL/state cache that survives browser restarts.
- Idempotent events + at-least-once draining give exact-once *effects* without
  distributed transactions; append-only rows avoid Convex hot-document write
  conflicts.
- Prolonged offline beyond the Outbox cap (2,000 events) drops oldest metadata
  — acceptable; bytes were already safe on disk.
- The Convex backend lives in `backend/` as a separate package; the extension
  bundle and root typecheck do not depend on it.

## Alternatives considered

- **Convex JS client (`ConvexClient`/`ConvexHttpClient`) in the SW** — adds a
  dependency and (for the reactive client) a WebSocket whose lifetime fights SW
  recycling; the raw HTTP API needs ~40 lines.
- **Convex as the byte pipe** (HTTP actions / file storage relay) — 20 MiB
  action cap, at-most-once actions, storage+egress billing; wrong primitive
  for 1k–10k PNG/MP4 transfers.
- **Mirroring whole queue/metrics blobs** — overwrites one hot document per
  tick (write conflicts, no audit trail); append-only events chosen instead.
- **Mandatory cloud backend** — breaks the product's local-only promise.
