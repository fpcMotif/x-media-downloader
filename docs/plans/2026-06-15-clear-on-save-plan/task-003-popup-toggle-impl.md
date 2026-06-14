# Task 003 (impl): Popup un-like toggle impl (Green)

- **Type:** impl
- **depends-on:** ["003-test", "002-impl"]
- **Files:** `src/entrypoints/popup/App.tsx` (settings panel)

Add a toggle "Un-like after saving (Likes page)" bound to `autoUnlikeOnSave`, placed with the other behavior toggles (`quickGrabEnabled`, `downloadBadgeEnabled`). Reuse the existing toggle component and settings-update handler — do not introduce a new pattern.

## Steps (what, not how)

- Render a toggle reading/writing `settings.autoUnlikeOnSave` through the same update path as sibling toggles.
- Helper copy (sub-label): "Removes your Like once all the post's media is saved. Off by default."
- Keep it visually consistent with the existing toggles (same row/label structure).

## BDD Scenario

```gherkin
Scenario: Settings panel shows an un-like toggle bound to the setting
  Given the popup settings panel is rendered with autoUnlikeOnSave false
  When the user toggles "Un-like after saving (Likes page)" on
  Then the persisted settings autoUnlikeOnSave becomes true
```

## Verification

- `bun run test src/entrypoints/popup/popup-layout.test.ts` — 003-test passes (Green).
- `bun run typecheck` — clean.
