# Task 003: Daily-budget record impl (Green)

**depends-on**: task-003-daily-budget-test

## Description

Implement the pure daily-budget record module that turns the task-003 tests green. No storage I/O here — this is the value logic only; the WXT-backed adapter is task 005.

## Execution Context

**Task Number**: 6 of 15
**Phase**: Foundation (core logic)
**Prerequisites**: task-003-daily-budget-test committed and failing

## BDD Scenarios

Same scenarios as [task-003-daily-budget-test.md](./task-003-daily-budget-test.md).

## Files to Modify/Create

- Create: `src/core/download/daily-budget.ts`

### Contract (signatures only — no bodies)

```ts
export interface BudgetRecord {
  readonly day: string   // local 'YYYY-MM-DD'
  readonly bytes: number
  readonly count: number
}

/** Local calendar day for an epoch-ms instant, 'YYYY-MM-DD'. */
export function localDay(nowMs: number): string

/** Today's record: the input if its day is today, else a zeroed record for today. */
export function freshRecord(record: BudgetRecord | null, nowMs: number): BudgetRecord

/** freshRecord(record, now) then add the completion's bytes and count. */
export function addCompletion(
  record: BudgetRecord | null,
  nowMs: number,
  bytes: number,
  count: number,
): BudgetRecord
```

## Steps

### Step 1: Implement Logic (Green)
- Implement `localDay`, `freshRecord`, `addCompletion`. `localDay` uses local time (the budget window is local-midnight per the spec).
- **Verification**: `bunx vitest run src/core/download/daily-budget.test.ts` PASSES.

### Step 2: Verify & Refactor
- **Verification**: `bun run test:coverage` shows 100% for `src/core/download/daily-budget.ts`; `bun run check` clean.

## Verification Commands

```bash
bunx vitest run src/core/download/daily-budget.test.ts
bun run check
```

## Success Criteria

- Task-003 tests green; module 100% covered; no other files touched.
