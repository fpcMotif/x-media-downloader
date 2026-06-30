# Task 008 (test) — showSavedStatus toggle behavior

**type**: test
**depends-on**: ["005", "007-impl"]
**files**: `src/entrypoints/overlay.content/handlers.test.ts` (gating), options settings test

> Depends on `007-impl` because the gating test exercises the `sweepSavedStatus`
> function that 007 introduces (the "no sweep runs when off" assertion needs it to exist).

Write failing tests (Red) that the `showSavedStatus` setting gates the sweep and is
persisted/observed from the options surface.

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

- Extend the `inScope`/gating decision so `sweepSavedStatus` is short-circuited when
  `showSavedStatus === false`; assert no enumeration and no chip when off.
- For persistence: assert the options toggle reads/writes the `showSavedStatus`
  setting through the existing settings store (mirror an existing settings-toggle
  test), and that a settings change notifies the overlay (existing settings-change
  propagation).

## Verification

- `bun run test src/entrypoints/overlay.content/handlers.test.ts` and the options
  settings test — new cases **fail** (Red).
