# Task 007: Background wiring + completion accounting (impl)

**depends-on**: task-005-budget-store-impl, task-006-admission-shell-impl

## Description

Wire the admission gate into `handleDownload` so it runs on the incoming `MediaItem[]` **before** `planDownloads()`, plan only the admitted items, and carry the `skipped` summary forward. Instantiate the gate with real ports, and increment the daily-budget tally at the terminal-success completion hook. This is an entrypoint integration task — its underlying logic is already unit-covered by tasks 002–006; verification here is the build gate plus a manual checklist.

## Execution Context

**Task Number**: 13 of 15
**Phase**: Integration
**Prerequisites**: tasks 005-impl, 006-impl committed

## BDD Scenario

```gherkin
Scenario: The gate gates scheduling
  Given the admission gate is wired before planDownloads in handleDownload
  When a batch of MediaItems arrives
  Then only gate-admitted items are planned and enqueued
  And the skipped items never reach the download queue
  And a completed download increments today's daily-budget tally
```

**Spec Source**: `docs/superpowers/specs/2026-06-27-download-admission-gate-design.md` (Architecture, Mechanics)

## Files to Modify/Create

- Modify: `src/entrypoints/background.ts`
  - Construct the gate near the existing `SavedIndex` init (~`background.ts:302-317`):
    - `sizeProbe = makeSizeProbe({ fetch: <bound SW fetch HEAD> })` — reuse the existing bound-fetch helper (`src/core/fetch.ts`); do not introduce a new unbound fetch (see the `bindFetch` footgun).
    - `budgetStore = makeDailyBudgetStore({ storage: <WXT local:daily-budget accessor>, now: () => Date.now() })`.
    - `gate = makeAdmissionGate({ getSettings, savedIndex, queryConvex, sizeProbe, readTodayBudget: () => budgetStore.readToday() })`.
  - In `handleDownload` (~`background.ts:675-696`): before `planDownloads`, `const { admitted, skipped } = await gate.admit(items)`; expand/plan only `admitted`; keep the existing `inFlight` filter after planning. Thread `skipped` to the response (consumed by task 009).
  - At the terminal-success site that already calls `savedStatusCoordinator.onCompleted(tweetId)` (completion reconciliation ~`background.ts:837-878`): also `await budgetStore.recordCompletion(bytesReceived ?? 0, 1)` using the actual received bytes when available (from the outcome/metrics), else the probed size, else 0.

## Steps

### Step 1: Implement Wiring
- Insert the gate, plan only admitted items, wire completion accounting. No logic duplication — delegate to the gate/store.

### Step 2: Verify
- **Verification**: `bun run check` clean; `bunx vitest run` full suite green (no regressions).
- **Manual checklist** (load the unpacked build, enable settings):
  - With `preventDuplicateDownloads` on, re-triggering a saved tweet enqueues nothing.
  - With `maxFileSizeMB` set low, an over-cap video is not downloaded.
  - With `dailyMaxCount` set to 1, the second download in a session is blocked until reset.

## Verification Commands

```bash
bun run check
bunx vitest run
```

## Success Criteria

- Only admitted items are planned/enqueued; completion increments the tally; gate built with bound fetch; full suite green.
