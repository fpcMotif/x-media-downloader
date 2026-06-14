# Task 003 (test): Popup un-like toggle test (Red)

- **Type:** test
- **depends-on:** ["002-impl"]
- **Files:** `src/entrypoints/popup/popup-layout.test.ts` (extend) or a co-located popup settings test

Add a failing test that the settings panel exposes an "Un-like after saving (Likes page)" toggle bound to `autoUnlikeOnSave`. Follow the existing popup toggle tests (the `quickGrabEnabled` / `downloadBadgeEnabled` toggles already have coverage — mirror their setup, including any settings-store/test double they use).

## BDD Scenario

```gherkin
Scenario: Settings panel shows an un-like toggle bound to the setting
  Given the popup settings panel is rendered with autoUnlikeOnSave false
  When the user toggles "Un-like after saving (Likes page)" on
  Then the persisted settings autoUnlikeOnSave becomes true
```

## Steps (what, not how)

- Render the settings panel with `autoUnlikeOnSave: false`; assert the toggle is present and reflects off.
- Simulate toggling it on; assert the settings update path is called with `autoUnlikeOnSave: true` (use the same store/persistence double the sibling toggle tests use).

## Verification

- `bun run test src/entrypoints/popup/popup-layout.test.ts` — new assertion **fails** (toggle not yet rendered). Red.
