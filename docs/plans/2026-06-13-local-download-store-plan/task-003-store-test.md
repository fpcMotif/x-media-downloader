# Task 003: DownloadStore reducer — test

**Type:** test
**depends-on:** ["002"]
**Files:**
- `src/core/history/store.test.ts` (create)

## Objective
Write failing (Red) tests for the pure `DownloadStore` reducer: `upsert`, `applyTransition` (with status monotonicity), capacity ring-eviction, and total `decodeStore`. Pure, injected-time, no I/O — mirrors `core/sync/outbox.ts`. OUT of scope: storage binding, wiring.

## Contract (signatures & types ONLY)
```ts
export type DownloadStore = { records: ReadonlyArray<DownloadRecord> } // newest-first
export const DEFAULT_HISTORY_CAP: number // 500
export const emptyStore: DownloadStore
export function decodeStore(raw: unknown): DownloadStore // corrupt → emptyStore
export function upsert(store: DownloadStore, record: DownloadRecord, cap?: number): DownloadStore
export function applyTransition(
  store: DownloadStore,
  requestId: string,
  kind: 'completed' | 'failed',
  at: number,
  bytes?: { received: number; total: number },
): DownloadStore
```

## BDD Scenarios
```gherkin
Scenario: Upsert a new record prepends it (newest-first)
  Given an empty store
  When upsert(store, recordA) then upsert(store, recordB) (different requestIds)
  Then records are [recordB, recordA]

Scenario: Upsert an existing requestId updates in place, no duplicate
  Given a store containing a queued record for requestId R
  When upsert(store, an updated record for R)
  Then there is exactly one record for R and it reflects the update

Scenario: Status is monotonic — a queued upsert never regresses a terminal record
  Given a store where requestId R is "completed"
  When upsert(store, a "queued" record for R)
  Then R remains "completed" (no regression)

Scenario: applyTransition moves a queued record to terminal
  Given a store where R is "queued"
  When applyTransition(store, R, "completed", t2, { received, total })
  Then R becomes "completed" with finishedAt=t2 and byte fields set

Scenario: applyTransition on an unknown requestId is a no-op
  Given a store without requestId R
  When applyTransition(store, R, "failed", t2)
  Then the store is unchanged

Scenario: Capacity eviction drops the oldest
  Given a store at cap N (newest-first)
  When upsert pushes an N+1th distinct record
  Then length stays N and the oldest record is evicted

Scenario: decodeStore recovers from corrupt storage
  Given a malformed stored value (e.g. a string, or records of wrong shape)
  When decodeStore(raw) is called
  Then it returns emptyStore (never throws)

Scenario: decodeStore round-trips a valid store
  Given a valid serialized store
  When decodeStore(raw) is called
  Then it returns the equivalent store
```

## Steps
1. Create the test importing the contract from `./store` (does not exist → Red) and `DownloadRecord`/`recordFromMediaItem` from `./record`.
2. Build records via `recordFromMediaItem` + `applyOutcome` with explicit timestamps.
3. Use a small `cap` in eviction tests to avoid building 500 records.

## Verification
- `bun run test src/core/history/store.test.ts` — **fails (Red)** because `src/core/history/store.ts` does not exist.

## Notes
- Follow `core/sync/outbox.ts` reducer conventions (pure, returns new state, `decodeX` swallows errors to a safe default).
- Monotonicity rule: terminal (`completed`/`failed`) must not be overwritten back to `queued` by a later queued upsert; document the precedence used.
