# Task 006 — Sync core (test / Red)

- **type:** test
- **depends-on:** ["003"]
- **files:** `src/core/sync/machine.test.ts` (new)

## Objective

Write failing unit tests for the pure Phase-1 sync core (to be lifted from
`study/cloud-sync-prototype/machine.ts` and trimmed in 007). Covers the capture decision (master
gate + trigger), on-demand always-on, queue dedupe, and the 3-state rollup. No upload-job/provider
logic (that is Phase 2).

The core is pure (no I/O), so tests need no doubles.

## BDD Scenario

```gherkin
Scenario: The master gate blocks capture and never touches the download
  Given cloudSyncEnabled is false
  When a download-complete capture is decided for an item
  Then enqueue is false
  And the decision reason states the download path is untouched

Scenario: A completed download auto-captures only when the trigger opts in
  Given cloudSyncEnabled is true and syncTrigger is "onDemand"
  When a download-complete capture is decided
  Then enqueue is false
  When syncTrigger is "onDownload" and the decision is retried
  Then enqueue is true

Scenario: The on-demand backup button always captures while sync is on
  Given cloudSyncEnabled is true and syncTrigger is "onDownload"
  When an on-demand capture is decided for an item
  Then enqueue is true

Scenario: Re-capturing an already-queued item is deduped
  Given an item "m-1" is already in the capture set
  When "m-1" is enqueued again
  Then the set contains exactly one entry for "m-1"

Scenario: Per-item status rolls up to a 3-state value
  Given a set of item sync states
  When rollup is computed
  Then it reports counts of safe, pending, and failed
  And an item is "safe" only when its Convex catalog write is confirmed
```

## Steps

1. Test `decideCapture(settings, source)` across the gate/trigger/on-demand matrix.
2. Test `dedupeQueue` keeps a single entry per `mediaId`.
3. Test `rollup` maps states → `{ safe, pending, failed }`.

## Verification

- `bun run test src/core/sync` → **FAIL** (module not yet created).
