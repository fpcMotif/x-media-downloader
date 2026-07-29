# ADR-0010 — Durable local download history (local-first, reconciled with Cloud Sync)

- **Status:** Accepted (2026-06-14); persistence contract amended (2026-07-28)

## Context

The extension is local-first, yet it keeps **no durable local record of what was
downloaded**. The popup's download Monitor is a **Snapshot** derived from
`session:metrics`, which is ephemeral by design — it resets on service-worker
recycle and on browser restart (ADR-0005, ADR-0008). The only durable history
is **remote and opt-in**: Cloud Sync mirrors download-state metadata into the
user's own Convex deployment as the `media_state` view (ADR-0009).

This leaves a gap: a privacy-first user who never enables Cloud Sync gets **no
history at all**, even though "keep Downloads organized" is a stated product
goal (PRODUCT.md) and the whole pitch is local-first. Durable history that
_requires_ the cloud contradicts the local-first posture.

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
4. **Pure core (`core/history`), one durable owner.** `DownloadRecord` and the
   versioned v3 `DownloadStore` stay pure: exact bounded decode, dedupe by
   `requestId`, immutable queue order, ring-cap, first-terminal-wins, and a
   bounded terminal-projection reset fence. Absence creates empty state. Exact v2
   and unversioned deployed shapes migrate. Corrupt bytes are quarantined: normal
   reads and writes fail without replacement. The background serializes record,
   read, migration, and erase on one lane. **Clear history** is the only explicit
   recovery and stays separate from **Clear monitor** (PRODUCT.md).
5. **No backend change.** `media_state` is reused conceptually as the remote
   twin; `backend/` is untouched.

## Consequences

- Users who keep cloud features off get durable download history for the first time; it survives
  SW recycle and browser restart, unlike the ephemeral Snapshot.
- Local ↔ cloud consistency is **structural** (one `syncMediaFromItem` source),
  so a future refactor cannot silently diverge them.
- No new install-time permissions. Sidecar `.json` requests (no backing Media
  Item) are excluded, exactly as the Convex mirror excludes them.
- Storage is bounded (ring-evict at 500 records); the oldest drop under
  sustained use — acceptable, the bytes are already on disk.
- Clear snapshots stable terminal-pending Transfer Registry projection ids.
  Replay after a partial sink failure cannot restore erased rows. This identity
  fence survives restart and does not trust wall time.
- Corrupt durable bytes remain available for diagnosis. They cannot silently
  become an empty history or be overwritten by a normal record.
- Three state views now coexist with clear, distinct lifetimes: the ephemeral
  live **Snapshot**, the durable local **Download History**, and the opt-in
  remote `media_state`.

## Alternatives considered

- **Remote-only history** (PR #1 Cloudflare D1 / ADR-0009 `media_state`) — needs
  an opt-in cloud; a user who keeps cloud features off gets nothing. Kept as the optional mirror,
  rejected as the _sole_ mechanism.
- **Reuse the ephemeral Monitor Snapshot** — it's session-scoped and resets on
  SW recycle (ADR-0005); the wrong lifetime for durable history.
- **A second, independent derivation for the local record** — risks local/cloud
  drift; rejected in favour of the shared `syncMediaFromItem` source.
- **Always-on local history** — chose opt-in/default-off to match the cautious
  posture of Cloud Sync and Quick Grab and to keep installs free of surprise
  persistence.
