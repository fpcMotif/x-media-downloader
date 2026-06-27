# Task 002: Admission core test (Red)

**depends-on**: none

## Description

Write failing unit tests for the pure admission decision core — the five skip reasons, their precedence, disabled-setting short-circuits, and fail-open behavior. This module is I/O-free and falls under the 100% `src/core` coverage gate, so the tests must exhaust every branch.

## Execution Context

**Task Number**: 3 of 15
**Phase**: Foundation (core logic)
**Prerequisites**: none

## BDD Scenarios

```gherkin
Scenario: Media-type filter rejects a skipped type
  Given skipTypes includes 'video'
  When a video item is evaluated
  Then freeReason returns 'filtered-type'

Scenario: Min-resolution rejects an under-size image; absent dimensions pass
  Given minWidth/minHeight are set
  When an item below the threshold is evaluated
  Then freeReason returns 'too-small'
  And an item whose width/height are absent passes (fail-open)

Scenario: Duplicate rejects an already-saved tweet
  Given savedTweetIds contains the item's tweetId
  When the item is evaluated
  Then freeReason returns 'duplicate'

Scenario: Per-file size cap is fail-open on unknown size
  Given maxFileSizeBytes is set
  When sizeReason is called with a byte count over the cap
  Then it returns 'too-big'
  And when sizeBytes is null it returns null (allowed)

Scenario: Daily budget rejects once a limit would be crossed
  Given a running budget and dailyMaxBytes/dailyMaxCount limits
  When admitting the next item would exceed either limit
  Then budgetReason returns 'daily-budget'
  And a disabled (0) limit never triggers

Scenario: Precedence — free checks win over size
  Given an item that is both a duplicate and over the size cap
  When evaluateAdmission composes free -> size -> budget in order
  Then the reason is 'duplicate' (free checks precede size)

Scenario: Precedence — size wins over budget
  Given an item that is over the per-file size cap AND would also cross the daily budget
  When evaluateAdmission composes free -> size -> budget in order
  Then the reason is 'too-big' (the size check precedes the budget check)

Scenario: All filters off is a pass-through
  Given every filter setting off/zero and an empty savedTweetIds
  When evaluateAdmission runs
  Then it returns { admit: true }
```

**Spec Source**: `docs/superpowers/specs/2026-06-27-download-admission-gate-design.md` (Pure core, check order)

## Files to Modify/Create

- Create: `src/core/download/admission.test.ts`

## Steps

### Step 1: Verify Scenarios
- Confirm the reason union and helper signatures from task-002-impl's contract (below) are what the tests target.

### Step 2: Implement Test (Red)
- Cover each helper (`freeReason`, `sizeReason`, `budgetReason`) and the composed `evaluateAdmission` precedence + pass-through.
- Use plain literals for `MediaItem` and `FilterSettings`; no I/O, no fakes needed.
- **Verification**: `bunx vitest run src/core/download/admission.test.ts` FAILS (module does not exist yet).

## Verification Commands

```bash
bunx vitest run src/core/download/admission.test.ts   # must FAIL
```

## Success Criteria

- Every reason, the precedence rule, both fail-open paths, and the all-off pass-through are encoded; failure is solely the missing module.
