# Task 002: DownloadRecord schema + builders — impl

**Type:** impl
**depends-on:** ["001"]
**Files:**
- `src/core/history/record.ts` (create)

## Objective
Make task 001's Red tests pass (Green) by implementing the `DownloadRecord` schema, the `DownloadStatus` literal, and the `recordFromMediaItem` / `applyOutcome` builders. OUT of scope: the store reducer, storage, wiring.

## Contract (signatures & types ONLY — no bodies in this plan)
```ts
export const DownloadStatus = Schema.Literals(['queued', 'completed', 'failed'])
export type DownloadStatus = typeof DownloadStatus.Type

export const DownloadRecord = Schema.Struct({
  requestId: Schema.String,
  filename: Schema.String,
  status: DownloadStatus,
  media: SyncMediaMeta,
  bytesReceived: Schema.optional(Schema.Number),
  bytesTotal: Schema.optional(Schema.Number),
  queuedAt: Schema.Number,
  finishedAt: Schema.optional(Schema.Number),
})
export type DownloadRecord = typeof DownloadRecord.Type

export function recordFromMediaItem(item: MediaItem, filename: string, at: number): DownloadRecord
export function applyOutcome(record, kind, at, bytes?): DownloadRecord
```

## BDD Scenarios
```gherkin
Scenario: 001's scenarios pass
  Given the record module exists with the contract above
  When task 001's test suite runs
  Then every scenario in task 001 passes (Green)
```

## Steps
1. Create `src/core/history/record.ts` with the schema, literal, and builders defined by the contract.
2. `recordFromMediaItem` maps the `MediaItem` provenance into `media` exactly as `queuedEvent` does in `core/sync/events.ts` (same fields → reconciliation by construction), sets `status: 'queued'`, `queuedAt: at`.
3. `applyOutcome` returns a new record with updated `status`, `finishedAt`, and optional byte fields; never mutates the input.

## Verification
- `bun run test src/core/history/record.test.ts` — **passes (Green)**.
- `bun run check` stays green (format, lint, tsgo, all tests).

## Notes
- Import `SyncMediaMeta` from `src/core/sync/events.ts` and `MediaItem` from `src/core/schema`. Do not redefine the media shape.
- Pure module: no I/O, no clock; `at` is injected.
