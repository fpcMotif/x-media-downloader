# Task 003: Popup toggle test (Red)

**depends-on**: task-002-settings-schema-impl

## Description

Write a failing test asserting the popup settings panel exposes a "Show download badge on media" toggle bound to `downloadBadgeEnabled`, following the existing `src/entrypoints/popup/popup-layout.test.ts` pattern (it tests pure layout/control descriptions, not the DOM — keep external dependencies out via the same approach that file already uses).

## Execution Context

**Task Number**: 5 of 8
**Phase**: Core Features
**Prerequisites**: `downloadBadgeEnabled` exists in the Settings type (task-002-impl), otherwise this test cannot typecheck

## BDD Scenarios

```gherkin
Scenario: Toggle is present and bound
  Given the popup settings panel layout
  When controls are enumerated
  Then a toggle labeled "Show download badge on media" exists
  And it reads and writes the downloadBadgeEnabled settings key
  And it sits in the same group as the Quick Grab controls

Scenario: Toggle reflects the stored default
  Given default settings
  When the panel renders its control model
  Then the badge toggle is on
```

**Spec Source**: `docs/superpowers/specs/2026-06-12-photo-download-badge-design.md` §5

## Files to Modify/Create

- Modify: `src/entrypoints/popup/popup-layout.test.ts`

## Steps

### Step 1: Verify Scenarios
- Read `popup-layout.test.ts` first; reuse its fixtures/helpers — do not invent a new test style.

### Step 2: Implement Test (Red)
- Add the two cases above.
- **Verification**: `bunx vitest run src/entrypoints/popup/popup-layout.test.ts` FAILS (control not yet in the layout).

## Verification Commands

```bash
bunx vitest run src/entrypoints/popup/popup-layout.test.ts   # must FAIL
```

## Success Criteria

- Failure is solely the missing toggle in the layout model.
