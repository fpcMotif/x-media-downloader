# Task 003: Popup toggle impl (Green)

**depends-on**: task-003-popup-toggle-test, task-002-settings-schema-impl (the `downloadBadgeEnabled` key must exist in the Settings type)

## Description

Add the "Show download badge on media" toggle to the popup settings panel, bound to `downloadBadgeEnabled` through the existing SettingsService read/write path (same wiring as the Quick Grab toggle). Match the panel's existing Preact + Tailwind idiom; keep WCAG AA contrast, keyboard operability, visible focus, and ≥40px pointer targets per PRODUCT.md.

**IMPORTANT**: If touching any Effect code in the settings path, load the `effect-v4` skill first.

## Execution Context

**Task Number**: 6 of 8
**Phase**: Core Features
**Prerequisites**: task-003-popup-toggle-test committed and failing

## BDD Scenarios

Same scenarios as [task-003-popup-toggle-test.md](./task-003-popup-toggle-test.md) — this task turns them green.

```gherkin
Scenario: Toggling writes the setting live
  Given the popup is open with downloadBadgeEnabled = true
  When the user toggles "Show download badge on media" off
  Then the setting persists via SettingsService
  And open tabs receive the change through the existing storage watch
```

**Spec Source**: `docs/superpowers/specs/2026-06-12-photo-download-badge-design.md` §5

## Files to Modify/Create

- Modify: `src/entrypoints/popup/App.tsx` (toggle in the Quick Grab settings group)
- Modify (only if the layout model lives separately): the module `popup-layout.test.ts` imports

## Steps

### Step 1: Implement Logic (Green)
- Add the control; bind through the same handler shape the Quick Grab toggle uses.
- **Verification**: `bunx vitest run src/entrypoints/popup/popup-layout.test.ts` PASSES.

### Step 2: Verify & Refactor
- Full gate; visually confirm the popup renders (`bun run dev`, open popup) — alignment, focus ring, 40px target.

## Verification Commands

```bash
bunx vitest run src/entrypoints/popup/popup-layout.test.ts
bun run check
```

## Success Criteria

- Toggle present, bound, persisted, live-propagating; suite green; popup visual check done.
