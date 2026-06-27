# Task 009: Skipped-summary feedback (impl)

**depends-on**: task-007

## Description

Surface the gate's skipped items to the user as an aggregated, by-reason summary in the overlay download feedback (e.g. "5 downloaded · 3 skipped — 2 already saved, 1 too big"). Extend the download response message with the summary, populate it in the background from the gate result, and render it where the existing per-item feedback shows.

## Execution Context

**Task Number**: 15 of 15
**Phase**: UI
**Prerequisites**: task-007 committed (gate produces `skipped`)

## BDD Scenario

```gherkin
Scenario: User sees why downloads were skipped
  Given a download batch where some items were gate-skipped
  When the download response returns to the overlay
  Then the user sees a count of downloaded items and a count of skipped items grouped by reason
  And reasons map to friendly labels (duplicate -> "already saved", too-big -> "too big", filtered-type -> "filtered", too-small -> "too small", daily-budget -> "daily limit")
```

**Spec Source**: `docs/superpowers/specs/2026-06-27-download-admission-gate-design.md` (Skipped feedback channel)

## Files to Modify/Create

- Modify: `src/core/schema/index.ts` (or the message-types module) — add a `skipped` summary field to the download response message: `ReadonlyArray<{ reason: SkipReason; count: number }>`. Add a minimal default-shape test alongside the existing message-schema tests.
- Modify: `src/entrypoints/background.ts` — aggregate `gate.admit(...)`'s `skipped` by reason into counts and include it in the response.
- Modify: `src/entrypoints/overlay.content/` (the handler/render that shows download feedback) — render the aggregated summary with friendly reason labels.

## Steps

### Step 1: Extend the message
- Add the `skipped` summary field with a safe default (empty array) following the existing message-schema pattern; pin its default shape with a small test.

### Step 2: Populate + render
- Background aggregates by reason; overlay renders the counts. Keep it a brief, non-blocking notice consistent with existing feedback styling.

### Step 3: Verify
- **Verification**: `bun run check` clean; full suite green.
- **Manual checklist**: trigger a batch with a known duplicate and a known over-cap file; confirm the summary reads correctly.

## Verification Commands

```bash
bun run check
bunx vitest run
```

## Success Criteria

- Skipped items are reported as by-reason counts in the overlay; message schema extended with a tested default; `bun run check` clean.
