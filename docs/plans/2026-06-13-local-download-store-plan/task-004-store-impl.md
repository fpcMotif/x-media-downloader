# Task 004: DownloadStore reducer — impl

**Type:** impl
**depends-on:** ["003"]
**Files:**
- `src/core/history/store.ts` (create)

## Objective
Make task 003's Red tests pass (Green) by implementing the pure `DownloadStore` reducer (`upsert`, `applyTransition`, capacity eviction, `decodeStore`, `emptyStore`, `DEFAULT_HISTORY_CAP`). OUT of scope: storage binding, background/popup wiring.

## Contract (signatures & types ONLY)
```ts
export type DownloadStore = { records: ReadonlyArray<DownloadRecord> }
export const DEFAULT_HISTORY_CAP = 500
export const emptyStore: DownloadStore
export function decodeStore(raw: unknown): DownloadStore
export function upsert(store: DownloadStore, record: DownloadRecord, cap?: number): DownloadStore
export function applyTransition(store, requestId, kind, at, bytes?): DownloadStore
```

## BDD Scenarios
```gherkin
Scenario: 003's scenarios pass
  Given the store module exists with the contract above
  When task 003's test suite runs
  Then every scenario in task 003 passes (Green)
```

## Steps
1. Create `src/core/history/store.ts` implementing the reducer per the contract.
2. `upsert` dedupes by `requestId`, keeps newest-first, applies the monotonicity rule (a `queued` incoming does not overwrite an existing terminal status), and ring-evicts beyond `cap`.
3. `applyTransition` finds the record by `requestId` and applies `applyOutcome` (from `./record`); no-op when absent.
4. `decodeStore` decodes via an Effect `Schema` for `{ records: DownloadRecord[] }`, returning `emptyStore` on failure (pattern of `decodeOutbox`).

## Verification
- `bun run test src/core/history/store.test.ts` — **passes (Green)**.
- `bun run check` stays green.

## Notes
- No I/O, no clock; reuse `applyOutcome` from `./record` so transition logic is not duplicated.
- Mirror `core/sync/outbox.ts` for the decode-to-safe-default idiom.
