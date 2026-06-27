# Task 003: Daily-budget record test (Red)

**depends-on**: none

## Description

Write failing unit tests for the pure daily-budget record module: local-day computation under an injected clock, day-rollover reset, and completion accumulation. I/O-free, under the 100% `src/core` coverage gate.

## Execution Context

**Task Number**: 5 of 15
**Phase**: Foundation (core logic)
**Prerequisites**: none

## BDD Scenarios

```gherkin
Scenario: Null or stale record resets to today at zero
  Given no stored record (null), or a record whose day != today
  When freshRecord is read with the current clock
  Then it returns { day: today, bytes: 0, count: 0 }

Scenario: Same-day completions accumulate
  Given today's record with some bytes and count
  When addCompletion adds bytes and a count of 1 on the same day
  Then bytes and count increase by the added amounts and day is unchanged

Scenario: A completion on a new day starts a fresh tally
  Given a record from a previous day
  When addCompletion runs with a clock on the next day
  Then the previous day's totals are discarded and only the new completion is counted
```

**Spec Source**: `docs/superpowers/specs/2026-06-27-download-admission-gate-design.md` (Daily-budget store)

## Files to Modify/Create

- Create: `src/core/download/daily-budget.test.ts`

## Steps

### Step 1: Verify Scenarios
- Target the contract in task-003-impl; inject `now` as a fixed epoch ms so "today" is deterministic (assert via the same `localDay` helper, not a hard-coded string, to stay timezone-agnostic).

### Step 2: Implement Test (Red)
- **Verification**: `bunx vitest run src/core/download/daily-budget.test.ts` FAILS (module missing).

## Verification Commands

```bash
bunx vitest run src/core/download/daily-budget.test.ts   # must FAIL
```

## Success Criteria

- Rollover reset, same-day accumulation, and cross-day reset are encoded; failure is solely the missing module.
