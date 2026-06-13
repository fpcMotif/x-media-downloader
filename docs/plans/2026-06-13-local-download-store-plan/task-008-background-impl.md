# Task 008: Background wiring + HistoryRequest/ClearHistory + storage — impl

**Type:** impl
**depends-on:** ["007"]
**Files:**
- `src/core/history/wiring.ts` (create — the pure helper from task 007)
- `src/core/schema/index.ts` (modify — add `HistoryRequest`/`HistoryResponse` and `ClearHistoryRequest`/`ClearHistoryResponse` to the `Message` union)
- `src/entrypoints/background.ts` (modify — storage item, persist at the recordSync points, message handlers)

## Objective
Make task 007's tests pass (Green) and wire the durable local store into the background: persist Download Records at the **same** outcome points that build Sync Events, behind the `downloadHistoryEnabled` toggle; serve `HistoryRequest`; support `ClearHistoryRequest`. OUT of scope: popup rendering (task 010), any `backend/` change.

## Contract (signatures & types ONLY)
```ts
// core/history/wiring.ts: queuedRecord, planHistory, isMirrorableRequest, HistoryAction (per task 007)

// core/schema Message union gains:
//   { _tag: 'HistoryRequest' }
//   { _tag: 'HistoryResponse', records: ReadonlyArray<DownloadRecord> }
//   { _tag: 'ClearHistoryRequest' }
//   { _tag: 'ClearHistoryResponse', ok: boolean }

// background.ts:
//   const historyItem = storage.defineItem<unknown>('local:downloadHistory', { fallback: null })
//   // serialized read-modify-write chain (same pattern as the sync outbox `withOutbox`)
```

## BDD Scenarios
```gherkin
Scenario: 007's pure-helper scenarios pass
  Given core/history/wiring.ts implements the contract
  When task 007's suite runs
  Then it passes (Green)

Scenario: A queued download is persisted locally when the toggle is on
  Given downloadHistoryEnabled = true
  When handleDownload queues a Media Item (where queuedEvent is built)
  Then a queued DownloadRecord for that requestId is written to local:downloadHistory

Scenario: A terminal outcome updates the local record
  Given a queued record exists for requestId R and the toggle is on
  When the browser/aria2 outcome (or onChanged terminal state) for R is reconciled
  Then the record transitions to completed/failed (same point that builds outcomeEvent)

Scenario: Nothing is persisted when the toggle is off
  Given downloadHistoryEnabled = false
  When downloads run
  Then local:downloadHistory is not written

Scenario: HistoryRequest returns the stored records newest-first
  Given local:downloadHistory has records
  When the popup sends { _tag: 'HistoryRequest' }
  Then the background responds with HistoryResponse carrying the records

Scenario: ClearHistoryRequest clears the store but not downloads
  Given active downloads and a populated history
  When { _tag: 'ClearHistoryRequest' } is received
  Then local:downloadHistory becomes empty and active downloads/inFlight are untouched

Scenario: Sidecar requests are not recorded
  Given a sidecar `<id>.json` Save Request
  When it is processed
  Then no DownloadRecord is written (isMirrorableRequest false)
```

## Steps
1. Implement `src/core/history/wiring.ts` to satisfy task 007.
2. Add the four `Message` variants to the union in `src/core/schema/index.ts`.
3. In `background.ts`: define `historyItem` (`local:downloadHistory`); add a serialized RMW helper mirroring `withOutbox`; at each existing `recordSync(...)` call site, also call `planHistory` and persist (gated by `settings.downloadHistoryEnabled`); add `HistoryRequest`/`ClearHistoryRequest` handlers in `onMessage`.
4. Keep the Convex enqueue path exactly as-is (gated by `cloudSyncEnabled`); the two writes are independent.

## Verification
- `bun run test src/core/history/wiring.test.ts` — passes (Green).
- `bun run check` green (format, lint, tsgo, all tests incl. existing background/sync ones).
- `bun run build` green; manifest gains **no** new permissions.

## Notes
- `local:` (not `session:`) so history survives SW recycle/restart.
- Serialize history writes like the sync outbox so interleaved SW events can't lose an update.
- Reconciliation: because `queuedRecord` and `queuedEvent` share `media`/`requestId`, the local store and Convex `media_state` represent the same state.
