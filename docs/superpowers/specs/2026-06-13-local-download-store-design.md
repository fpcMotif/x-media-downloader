# Durable Local Download Store — Design Spec

**Date:** 2026-06-13
**Status:** Superseded by ADR-0010 and the 2026-07-18 lifecycle design
**Branch:** `claude/elegant-franklin-g4ofol` (PR #3, with `main` merged in)
**Related:** ADR-0005 (state persistence split — ephemeral vs durable), ADR-0008 (pure reducers, injected time), ADR-0009 (Convex Cloud Sync — **reused/untouched**), ADR-0002 (fire-and-track queue). A **new ADR** will record this decision during the doc pass (next free number `0010` on this branch).

> Historical proposal. Its corruption-to-empty and unversioned-storage text is
> not the current contract. ADR-0010 now requires a strict v2 envelope,
> quarantined corruption, and explicit erase recovery.

## 1. Purpose

X Media Downloader is **local-first with no telemetry by default**, yet it keeps
**no durable local record of what you've downloaded**. The popup's download
Monitor is a _Snapshot_ derived from `session:metrics`, which is ephemeral by
design — it resets on service-worker recycle and on browser restart (ADR-0005).
The only durable history that exists is **remote**: the opt-in Convex Cloud Sync
mirrors download-state metadata into the user's deployment (`media_state`).

This feature adds the missing piece: a **durable local download store** — the local-first record of every download (the **original media link** + **download status** + provenance + timestamps) — and **reconciles it with the existing Convex mirror** so the two are the same view of the same data, one fed from the cloud-optional path and one always local.

## 2. Core insight — the local store is `media_state`'s local twin

The existing Convex backend already materializes a per-request view (`backend/convex/schema.ts`):

```
media_state: { requestId, deviceId, lastKind: queued|completed|failed, at, media?: {platform,postId,author,type,url,ext,index} }
```

This is exactly the shape a local download history needs. So:

> The local download store is the **local-first counterpart of `media_state`** — same `requestId` key, same `queued → completed/failed` status, same media provenance (incl. `url`, the original link). A single canonical outcome path in the background feeds **both** the local store (always-on) and the Convex outbox (opt-in mirror), so they **never diverge**.

No Convex/backend change is required. The reconciliation is achieved on the client by deriving both the local record and the Sync Event from the same `(MediaItem, outcome, at)` inputs, sharing the `SyncMediaMeta` payload type and the `requestId` key.

## 3. Decisions to confirm at approval

| Question            | Proposed default                                                                                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Storage target      | **Local store only** for the new history; Convex sync untouched (reused as the opt-in mirror).                                                                                                                                                    |
| Always-on vs opt-in | **Opt-in toggle `downloadHistoryEnabled`, default off** (matches Cloud Sync / Quick Grab posture). When on, downloads are recorded locally; a **Clear history** action (separate from Clear monitor) is available. When off, nothing is recorded. |
| Backend change      | **None.** Reuse `media_state`'s shape; don't modify `backend/`.                                                                                                                                                                                   |
| Source of truth     | **Local store is authoritative locally**; Convex `media_state` is its opt-in remote mirror.                                                                                                                                                       |

## 4. Domain language (additions to `CONTEXT.md`, grill pass)

- **Download Record** — one durable, local record of a Save Request's outcome: `requestId`, `mediaKey`, the original media `url` (link), `filename`, `status` (`queued`/`completed`/`failed`), provenance (`platform`, `postId`, `author`, `type`, `ext`, `index`), `bytesReceived?`, `bytesTotal?`, `queuedAt`, `finishedAt?`. The local-first twin of a Convex `media_state` row.
- **Download Store / History** — the durable, bounded collection of Download Records in `storage.local`, keyed by `requestId`. Survives SW recycle and browser restart (unlike the Monitor Snapshot).

Boundary (what it is NOT): the **Monitor / Snapshot** stays ephemeral and live (throughput/ETA/active counts). The **Download Store** is durable, terminal-state history. They are distinct.

## 5. Pure core — `src/core/history/` (no I/O, injected time)

- **`record.ts`** — Effect `Schema` for `DownloadRecord` (reusing `SyncMediaMeta` from `core/sync/events` for the media payload so the shape matches `media_state` by construction) + `DownloadStatus` literal `queued|completed|failed`. Builder `recordFromMediaItem(item, at)` (queued) and `applyOutcome(record, kind, at, bytes?)`.
- **`store.ts`** — pure reducer over `DownloadStore`: `upsert` by
  `requestId`, ring-cap at 500, monotonic terminal transitions, and strict
  persisted-state classification. See the superseding ADR for the v2 envelope
  and corruption quarantine.

Pattern parity: this mirrors `core/sync/outbox.ts` and `core/download/metrics.ts` — pure, injected time, no Effect runtime, no I/O.

## 6. Local storage model (`storage.local`)

- `local:downloadHistory` — the durable `DownloadStore`, bounded (default 500), deduped by the versioned, platform-aware `requestId`, newest-first. Sidecar requests use their own globally unique artifact IDs and are **excluded** because they have no `MediaItem`, identical to how the Convex mirror excludes them.

## 7. Background wiring — one canonical outcome path

At the exact points that already call `recordSync(...)` in `background.ts`:

- **queued** (in `handleDownload`, where `queuedEvent` is built): also `upsert` a `queued` Download Record (carrying the original `url`).
- **terminal** (the `completed`/`failed` reconciliation in `handleDownload` and the `onChanged` handler, where `outcomeEvent` is built): also `applyTransition` to the Download Record.

A small refactor extracts the shared derivation so the **Download Record and the Sync Event are produced from the same `(item/requestId, kind, at)` inputs** — guaranteeing local/Convex agreement. The local store write is a serialized read-modify-write (the existing `withOutbox`-style chain) so interleaved SW events can't lose an update. The local write is gated by **`downloadHistoryEnabled`** (default off); the Convex enqueue stays independently gated by `cloudSyncEnabled`. The two toggles are orthogonal — either, both, or neither.

## 8. Popup UI

A new **"Download history"** `<Section>` (durable), distinct from the live **Download monitor**. It carries the **"Keep download history"** toggle (`downloadHistoryEnabled`, default off). When on, it lists recent Download Records grouped by `author`/`postId`, each showing platform, status, the original link, filename, and time — read from `local:downloadHistory` via a background message (e.g. `HistoryRequest` → records) — plus a **"Clear history"** action kept visually separate from **Clear monitor** (PRODUCT.md: separate safe resets from destructive ones; clearing history does not cancel active downloads or delete files). Uses existing `xmd-*` components.

## 9. Error handling / edge cases

- SW recycle / browser restart ⇒ history survives (it's `local:`, not `session:`); the Monitor Snapshot legitimately resets.
- Duplicate outcome deltas (e.g. repeated `onChanged`) ⇒ idempotent `upsert`/`applyTransition` by `requestId`; status monotonic.
- Sidecar `.json` requests ⇒ excluded (no `MediaItem`).
- Corrupt stored value ⇒ quarantined; explicit erase is recovery.
- Cap exceeded ⇒ oldest evicted (ring); newest-first preserved.
- Cloud Sync off ⇒ local history still recorded (it does not depend on the cloud).

## 10. Testing strategy (red-green order)

1. `record.ts` — schema round-trip; `recordFromMediaItem` carries url/provenance; `applyOutcome` sets status + finishedAt; unknown keys dropped.
2. `store.ts` — `upsert` dedupes by requestId; cap ring-evicts oldest;
   `applyTransition` is monotonic; strict decode separates absence, migration,
   current v2, and corruption.
3. Settings — `downloadHistoryEnabled` default off; corrupt-value recovery; watch delivers changes.
4. Background — the shared derivation feeds both local record and Sync Event from the same inputs; sidecar excluded; local write gated by `downloadHistoryEnabled`, Convex enqueue independently gated by `cloudSyncEnabled`; reconciliation (local status == media_state lastKind by construction). Tested via an extracted pure helper.
5. Popup — `HistoryRequest` returns records; toggle gates recording; grouping/format helpers; Clear history clears the store but not active downloads.

## 11. Out of scope

- Retry-from-history / re-download actions (a natural follow-up).
- Any change to `backend/` or the Convex schema/functions.
- Cross-device sync of history (it's local; Convex remains the optional remote mirror).
- Persisting the live Monitor accumulator across SW recycle (separate ADR-0008 follow-up).

## 12. Sequencing

- **Step 0 — DONE:** `main` merged into PR #3's branch; `bun run check` (180 tests) + `bun run build` green.
- **Next (on approval):** implementation plan → `/tdd` builds §5 → §7 → §8 in red-green order → `/grill-with-docs` updates `CONTEXT.md` (Download Record / Download Store) and writes the new ADR.
