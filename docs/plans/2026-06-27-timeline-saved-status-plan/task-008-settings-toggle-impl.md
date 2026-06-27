# Task 008 (impl) — showSavedStatus toggle in options/popup

**type**: impl
**depends-on**: ["008-test", "007-impl"]
**files**: options/settings entrypoint (`src/entrypoints/options/…`), `src/entrypoints/overlay.content/index.tsx`

> Depends on `007-impl`: this task wraps the `sweepSavedStatus` call site that 007
> creates and edits the same `index.tsx`, so it must land after 007-impl (no parallel
> write conflict).

Make Task 008's tests pass (Green): expose the toggle and honor it in the overlay.

## BDD Scenario

```gherkin
Scenario: Toggle off disables the feature
  Given showSavedStatus is false
  When the overlay mounts on an in-scope timeline
  Then no sweep runs and no chip appears

Scenario: Toggle persists and propagates
  Given the user flips showSavedStatus in the options page
  Then the setting is persisted
  And the overlay observes the new value
```

## Steps

- Add a `showSavedStatus` toggle control to the options/Settings page (per
  [[figma-popup-settings-redesign]]: the new WXT options page is the config surface),
  bound to the existing settings store; default reflects `true`.
- In `index.tsx`, read `showSavedStatus` and gate the sweep: when `false`, never call
  `sweepSavedStatus`; when toggled on at runtime, the existing settings-change
  propagation re-enables it without reload.
- When Convex sync is unconfigured, the feature still runs C-only (local marks) —
  the toggle governs the feature as a whole, independent of sync configuration.

## Verification

- `bun run test` (overlay gating + options settings) — Task 008 cases **pass**.
- `bun run typecheck` and `bun run test:coverage` — `src/core` gate intact.
