# Task 006: Admission shell test (Red)

**depends-on**: task-001-settings-schema-impl, task-002-admission-core-impl, task-004-size-probe-impl

## Description

Write failing tests for the async admission shell `makeAdmissionGate` — the orchestrator that maps `Settings` → `FilterSettings`, resolves dedup via an injected `SavedIndex`, runs the ordered checks, probes survivors **only** when a size cap or byte budget is active, maintains a running budget projection, and returns `{ admitted, skipped }`. All collaborators are injected fakes; lives in `src/background`.

## Execution Context

**Task Number**: 11 of 15
**Phase**: Orchestration
**Prerequisites**: tasks 001-impl, 002-impl, 004-impl committed

## BDD Scenarios

```gherkin
Scenario: Cheap filters run before any probe
  Given a size cap is set and one item is a skipped media type
  When admit([typeFilteredItem]) runs
  Then the item is skipped 'filtered-type'
  And the size probe is never called for it

Scenario: No probe when neither size cap nor byte budget is active
  Given maxFileSizeMB and dailyMaxMB are both 0 (count budget may be on)
  When admit(items) runs
  Then the size probe is never called

Scenario: Duplicate tweets are dropped via the saved set
  Given preventDuplicateDownloads is on and SavedIndex.resolve reports a tweetId as saved
  When admit(items) runs
  Then every item of that tweet is skipped 'duplicate'

Scenario: Size cap skips an over-cap file (fail-open on unknown)
  Given maxFileSizeMB is set
  When the probe returns an over-cap size for one item and null for another
  Then the over-cap item is skipped 'too-big' and the unknown-size item is admitted

Scenario: Daily budget locks once a projected limit is crossed
  Given today's tally near dailyMaxCount and several candidates
  When admit(items) walks them in order
  Then items are admitted until the projection would exceed, then the rest are skipped 'daily-budget'

Scenario: Dedup degrades gracefully when the backstop is unavailable
  Given preventDuplicateDownloads is on and SavedIndex.resolve resolves to only the locally-known saved subset (Convex unreachable)
  When admit(items) runs
  Then the gate never throws
  And items whose tweetId is in the local saved subset are skipped 'duplicate'
  And all other items proceed through the remaining checks
  # SavedIndex.resolve already swallows backstop failures (see saved-index.ts); the shell must not add its own throw.

Scenario: Result shape
  When admit returns
  Then admitted is MediaItem[] and skipped is Array<{ item, reason }> preserving input order
```

**Spec Source**: `docs/superpowers/specs/2026-06-27-download-admission-gate-design.md` (Async shell)

## Files to Modify/Create

- Create: `src/background/admission-gate.test.ts`

## Steps

### Step 1: Verify Scenarios
- Target the `makeAdmissionGate` contract in task-006-impl. Fakes: a `SavedIndex` whose `resolve` returns a chosen subset, a spy `SizeProbePort`, a `readTodayBudget` returning a chosen running tally, and a `getSettings` returning chosen `Settings`.

### Step 2: Implement Test (Red)
- Assert ordering (probe-not-called for type-filtered + probe-not-called when caps off), dedup union, size fail-open, budget lock/projection, and the result shape.
- **Verification**: `bunx vitest run src/background/admission-gate.test.ts` FAILS (module missing).

## Verification Commands

```bash
bunx vitest run src/background/admission-gate.test.ts   # must FAIL
```

## Success Criteria

- Ordering, probe-gating, dedup, fail-open, projection, and shape are all encoded; failure is solely the missing module.
