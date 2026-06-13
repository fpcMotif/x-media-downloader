# Task 007: Shared outcome derivation + local persist wiring — test

**Type:** test
**depends-on:** ["004", "006"]
**Files:**
- `src/core/history/wiring.test.ts` (create — tests the extracted pure helper)

## Objective
Write failing (Red) tests for an **extracted pure helper** that (a) derives a `DownloadRecord` from the same `(MediaItem, filename, at)` inputs the background uses to build a `queuedEvent` — proving local/Convex reconciliation by construction — and (b) folds queued/terminal actions into a `DownloadStore` while respecting the `downloadHistoryEnabled` toggle and excluding sidecar requests. The helper is pure so the background SW stays thin and testable. OUT of scope: touching `background.ts`, real storage, real fetch.

## Contract (signatures & types ONLY)
```ts
import type { DownloadStore } from './store'
import type { DownloadRecord } from './record'
import type { MediaItem, Settings } from '../schema'
import type { SyncEvent } from '../sync/events'

// Reconciliation witness: the record's media must equal the queued Sync Event's media.
export function queuedRecord(item: MediaItem, filename: string, at: number): DownloadRecord

// Pure fold over the store for a queued or terminal action, gated by settings.
export type HistoryAction =
  | { kind: 'queued'; item: MediaItem; filename: string; at: number }
  | { kind: 'completed' | 'failed'; requestId: string; at: number; bytes?: { received: number; total: number } }

export function planHistory(store: DownloadStore, settings: Settings, action: HistoryAction): DownloadStore

// Whether a Save Request id corresponds to a real Media Item (false for sidecar `<id>.json`).
export function isMirrorableRequest(requestId: string, hasMediaItem: boolean): boolean
```

## BDD Scenarios
```gherkin
Scenario: The local record reconciles with the queued Sync Event (same media)
  Given a MediaItem and timestamp `at`
  When queuedRecord(item, filename, at) and queuedEvent(item, deviceId, at) are built
  Then queuedRecord(...).media deep-equals queuedEvent(...).media (tweetId, handle, type, url, ext, index)
  And both key on the same requestId (item.id)

Scenario: planHistory records a queued action when the toggle is on
  Given settings.downloadHistoryEnabled = true and an empty store
  When planHistory(store, settings, { kind: "queued", item, filename, at })
  Then the store has one queued record for item.id

Scenario: planHistory is a no-op when the toggle is off
  Given settings.downloadHistoryEnabled = false
  When planHistory(store, settings, any action)
  Then the store is returned unchanged

Scenario: planHistory applies a terminal transition (monotonic)
  Given a store with a queued record for R and the toggle on
  When planHistory(store, settings, { kind: "completed", requestId: R, at: t2 })
  Then R becomes "completed" with finishedAt t2

Scenario: Sidecar requests are excluded
  Given a Save Request id ending in ".json" with no backing MediaItem
  When isMirrorableRequest(id, false) is evaluated
  Then it is false (no record is written), matching how the Convex mirror excludes sidecars

Scenario: Toggles are orthogonal
  Given downloadHistoryEnabled and cloudSyncEnabled set independently
  Then planHistory depends only on downloadHistoryEnabled (the Convex enqueue path is unaffected by it)
```

## Steps
1. Create `wiring.test.ts` importing the helper from `./wiring` (does not exist → Red), plus `queuedEvent` from `../sync/events` for the reconciliation assertion and `recordFromMediaItem`/store helpers.
2. Assert the reconciliation witness (record.media == queuedEvent.media) — this is the heart of the "reconcile with Convex" requirement.
3. Cover toggle-on, toggle-off, terminal transition, sidecar exclusion, orthogonality, with injected timestamps.

## Verification
- `bun run test src/core/history/wiring.test.ts` — **fails (Red)** until `src/core/history/wiring.ts` exists.

## Notes
- This keeps SW-specific code out of the unit test: the background (task 008) only orchestrates storage reads/writes around this pure helper.
- `queuedEvent` is the existing builder in `core/sync/events.ts`; do not modify it.
