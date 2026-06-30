# Task 005: Daily-budget store adapter test (Red)

**depends-on**: task-003-daily-budget-impl

## Description

Write failing tests for the durable daily-budget store adapter — a thin shell over the pure `daily-budget` ops backed by injected storage. Verify reset-on-read at day rollover, completion accumulation persisting to storage, and reset-today zeroing. Lives in `src/background` (alongside the existing `saved-status` / settle-port unit tests); injected storage + clock make it deterministic.

## Execution Context

**Task Number**: 9 of 15
**Phase**: Integration adapters
**Prerequisites**: task-003-daily-budget-impl (pure ops) committed

## BDD Scenarios

```gherkin
Scenario: readToday returns a zeroed tally when storage is empty
  Given empty storage
  When readToday() is called
  Then it resolves to today's record with bytes 0 and count 0

Scenario: readToday resets a stale stored record
  Given storage holds a record from a previous day
  When readToday() is called with today's clock
  Then it resolves to a zeroed record for today (and does not surface the stale totals)

Scenario: recordCompletion accumulates and persists
  Given today's stored record
  When recordCompletion(bytes, 1) is called twice on the same day
  Then storage holds the summed bytes and count for today

Scenario: resetToday zeroes the stored tally
  Given a non-zero stored record for today
  When resetToday() is called
  Then storage holds bytes 0 and count 0 for today
```

**Spec Source**: `docs/superpowers/specs/2026-06-27-download-admission-gate-design.md` (Daily-budget store)

## Files to Modify/Create

- Create: `src/background/daily-budget-store.test.ts`

## Steps

### Step 1: Verify Scenarios
- Target the `makeDailyBudgetStore` contract in task-005-impl. Use a fake `{ get, set }` over an in-memory variable and a fixed `now`.

### Step 2: Implement Test (Red)
- **Verification**: `bunx vitest run src/background/daily-budget-store.test.ts` FAILS (module missing).

## Verification Commands

```bash
bunx vitest run src/background/daily-budget-store.test.ts   # must FAIL
```

## Success Criteria

- Reset-on-read, accumulation+persistence, and reset-today are encoded; failure is solely the missing module.
