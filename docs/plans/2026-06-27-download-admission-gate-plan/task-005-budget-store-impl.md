# Task 005: Daily-budget store adapter impl (Green)

**depends-on**: task-005-budget-store-test, task-003-daily-budget-impl

## Description

Implement `makeDailyBudgetStore`, a durable adapter over the pure `daily-budget` ops, turning the task-005 tests green. Storage and clock are injected; the real wiring (task 007) passes a WXT `local:daily-budget` accessor and `Date.now`.

## Execution Context

**Task Number**: 10 of 15
**Phase**: Integration adapters
**Prerequisites**: task-005-budget-store-test committed and failing

## BDD Scenarios

Same scenarios as [task-005-budget-store-test.md](./task-005-budget-store-test.md).

## Files to Modify/Create

- Create: `src/background/daily-budget-store.ts`

### Contract (signatures only — no bodies)

```ts
import type { BudgetRecord } from '../core/download/daily-budget'

export interface BudgetStorage {
  get(): Promise<BudgetRecord | null>
  set(record: BudgetRecord): Promise<void>
}

export interface DailyBudgetStore {
  /** Today's tally, resetting a stale stored record on read. */
  readonly readToday: () => Promise<{ bytes: number; count: number; day: string }>
  /** Add a completed download's bytes and one file to today's tally; persists. */
  readonly recordCompletion: (bytes: number, count: number) => Promise<void>
  /** Zero today's tally. */
  readonly resetToday: () => Promise<void>
}

export function makeDailyBudgetStore(deps: {
  storage: BudgetStorage
  now: () => number
}): DailyBudgetStore
```

## Steps

### Step 1: Implement Logic (Green)
- Implement the three methods using `freshRecord` / `addCompletion` from `daily-budget.ts`. `readToday` reads, freshens, and (if it changed) persists; `recordCompletion` reads-modify-writes; `resetToday` writes a zeroed record for today.
- **Verification**: `bunx vitest run src/background/daily-budget-store.test.ts` PASSES.

### Step 2: Verify & Refactor
- **Verification**: `bun run check` clean.

## Verification Commands

```bash
bunx vitest run src/background/daily-budget-store.test.ts
bun run check
```

## Success Criteria

- Task-005 tests green; all `daily-budget` value logic reused (no duplication); `bun run check` clean.
