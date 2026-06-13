# Task 001: DownloadRecord schema + builders — test

**Type:** test
**depends-on:** []
**Files:**
- `src/core/history/record.test.ts` (create)

## Objective
Write failing (Red) tests for the `DownloadRecord` Effect `Schema`, the `DownloadStatus` literal, and the two builders (`recordFromMediaItem`, `applyOutcome`). The record embeds the **same** media-provenance payload as a Sync Event (`SyncMediaMeta`) so it matches Convex's `media_state.media` by construction. OUT of scope: the store reducer (task 003), any wiring.

## Contract (signatures & types ONLY — no bodies)
```ts
import { Schema } from 'effect'
import type { MediaItem } from '../schema'
import { SyncMediaMeta } from '../sync/events'

export const DownloadStatus: Schema.Literals<['queued', 'completed', 'failed']>
export type DownloadStatus = typeof DownloadStatus.Type

export const DownloadRecord: Schema.Struct<{
  requestId: typeof Schema.String
  filename: typeof Schema.String
  status: typeof DownloadStatus
  media: typeof SyncMediaMeta            // { tweetId, handle, type, url, ext, index } — `url` is the original link
  bytesReceived: Schema.optional<typeof Schema.Number>
  bytesTotal: Schema.optional<typeof Schema.Number>
  queuedAt: typeof Schema.Number
  finishedAt: Schema.optional<typeof Schema.Number>
}>
export type DownloadRecord = typeof DownloadRecord.Type

export function recordFromMediaItem(item: MediaItem, filename: string, at: number): DownloadRecord
export function applyOutcome(
  record: DownloadRecord,
  kind: 'completed' | 'failed',
  at: number,
  bytes?: { received: number; total: number },
): DownloadRecord
```

## BDD Scenarios
```gherkin
Scenario: A queued record is built from a Media Item
  Given a MediaItem with id, tweetId, handle, type, url, ext, index
  And a relative filename and a timestamp `at`
  When recordFromMediaItem(item, filename, at) is called
  Then requestId equals item.id
  And media equals { tweetId, handle, type, url, ext, index } from the item (url is the original link)
  And status is "queued" and queuedAt equals `at` and finishedAt is absent

Scenario: An outcome is applied to a record
  Given a queued DownloadRecord
  When applyOutcome(record, "completed", t2, { received, total }) is called
  Then status becomes "completed", finishedAt equals t2, bytesReceived/bytesTotal are set
  And requestId, media, filename, queuedAt are unchanged

Scenario: A failed outcome
  Given a queued DownloadRecord
  When applyOutcome(record, "failed", t2) is called
  Then status becomes "failed" and finishedAt equals t2

Scenario: Decode is total and drops unknown keys
  Given a stored object with an extra unknown key alongside valid record fields
  When decoded with the DownloadRecord schema
  Then it decodes successfully and the unknown key is absent

Scenario: Malformed payload fails to decode
  Given an object missing `requestId` or with a non-literal `status`
  When decoded with the DownloadRecord schema
  Then decoding fails (caller handles the failure)
```

## Steps
1. Create the test file importing `DownloadRecord`, `DownloadStatus`, `recordFromMediaItem`, `applyOutcome` from `./record` (does not exist yet → Red).
2. Build a representative `MediaItem` fixture inline (matching the existing `MediaItem` schema fields).
3. Assert each scenario above with vitest, using `Schema.decodeUnknownSync`/`Schema.encodeSync` for round-trip and explicit timestamps (no real clock).

## Verification
- `bun run test src/core/history/record.test.ts` — tests **fail meaningfully (Red)** because `src/core/history/record.ts` does not yet exist.

## Notes
- Effect v4 (beta) `Schema`. Reuse `SyncMediaMeta` from `src/core/sync/events.ts` for the `media` field — this is what guarantees the record matches `media_state.media`. Confirm the exact `SyncMediaMeta` export name before importing.
- Inject `at`/`t2` as plain numbers; never call a real clock in core.
- Mirror the existing `core/sync/events.test.ts` style.
