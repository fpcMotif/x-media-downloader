# ADR-0010 — Durable local download history (local-first, reconciled with Cloud Sync)

- **Status:** Accepted (2026-06-14)

## Context

The extension is local-only, yet it keeps **no durable local record of what was
downloaded**. The popup's download Monitor is a **Snapshot** derived from
`session:metrics`, which is ephemeral by design — it resets on service-worker
recycle and on browser restart (ADR-0005, ADR-0008). The only durable history
is **remote and opt-in**: Cloud Sync mirrors download-state metadata into the
user's own Convex deployment as the `media_state` view (ADR-0009).

This leaves a gap: a privacy-first user who never enables Cloud Sync gets **no
history at all**, even though "keep Downloads organized" is a stated product
goal (PRODUCT.md) and the whole pitch is local-first. Durable history that
*requires* the cloud contradicts the local-only promise.

## Decision

Add a durable, **local** **Download History** in `storage.local` — a bounded
collection of **Download Records** keyed by the Save Request id — as the
local-first counterpart of Convex's `media_state`.

1. **Same shape as the remote twin.** A Download Record carries the same key
   (`requestId`), the same `queued → completed/failed` status, and the same
   `SyncMediaMeta` provenance (incl. the original media `url`) as a `media_state`
   row. The local store is `media_state`'s local-first twin, not a new model.
2. **Single derivation — reconciliation by construction.** The background builds
   the Download Record and the Sync Event from the **same** `(Media Item /
   requestId, kind, at)` inputs via the shared `syncMediaFromItem`. The local
   record, the Sync Event, and (when enabled) `media_state` therefore agree by
   construction — not via a parallel code path that could drift.
3. **Two orthogonal toggles.** Local recording is gated by
   `downloadHistoryEnabled` (default **off**); the Convex mirror is gated
   independently by `cloudSyncEnabled`. Either, both, or neither — the local
   write never depends on the cloud and vice versa.
4. **Pure core (`core/history`), thin wiring.** `DownloadRecord` (schema) +
   `DownloadStore` (pure reducer: upsert/dedupe by `requestId`, ring-cap,
   **monotonic** status so a terminal record never regresses to `queued`,
   decode-to-empty on corruption) — injected time, no I/O (ADR-0008 precedent).
   The background does serialized read-modify-write like the Outbox; the popup
   reads it via a `HistoryRequest` message. **Clear history** is a safe reset,
   kept separate from **Clear monitor** (PRODUCT.md).
5. **No backend change.** `media_state` is reused conceptually as the remote
   twin; `backend/` is untouched.

## Consequences

- Local-only users get durable download history for the first time; it survives
  SW recycle and browser restart, unlike the ephemeral Snapshot.
- Local ↔ cloud consistency is **structural** (one `syncMediaFromItem` source),
  so a future refactor cannot silently diverge them.
- No new install-time permissions. Sidecar `.json` requests (no backing Media
  Item) are excluded, exactly as the Convex mirror excludes them.
- Storage is bounded (ring-evict at 500 records); the oldest drop under
  sustained use — acceptable, the bytes are already on disk.
- Three state views now coexist with clear, distinct lifetimes: the ephemeral
  live **Snapshot**, the durable local **Download History**, and the opt-in
  remote `media_state`.

## Alternatives considered

- **Remote-only history** (PR #1 Cloudflare D1 / ADR-0009 `media_state`) — needs
  an opt-in cloud; a local-only user gets nothing. Kept as the optional mirror,
  rejected as the *sole* mechanism.
- **Reuse the ephemeral Monitor Snapshot** — it's session-scoped and resets on
  SW recycle (ADR-0005); the wrong lifetime for durable history.
- **A second, independent derivation for the local record** — risks local/cloud
  drift; rejected in favour of the shared `syncMediaFromItem` source.
- **Always-on local history** — chose opt-in/default-off to match the cautious
  posture of Cloud Sync and Quick Grab and to keep installs free of surprise
  persistence.
