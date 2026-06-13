# Task 005: downloadHistoryEnabled setting (default off) — test

**Type:** test
**depends-on:** []
**Files:**
- `src/core/settings/settings.test.ts` (modify)
- `src/core/schema/schema.test.ts` (modify)

## Objective
Write failing (Red) tests asserting the `Settings` schema gains `downloadHistoryEnabled: boolean` defaulting to **false**, recovers to its default on a corrupt stored value, and is delivered through `watchSettings`. Mirrors the existing `cloudSyncEnabled` default-off / corrupt-recovery tests. OUT of scope: any consumer of the flag.

## Contract (signatures & types ONLY)
```ts
// Settings (src/core/schema) gains:
//   downloadHistoryEnabled: boolean   // default false
// No new function signatures; getSettings()/setSettings()/watchSettings() are unchanged.
```

## BDD Scenarios
```gherkin
Scenario: downloadHistoryEnabled defaults off
  Given no stored settings
  When getSettings() resolves
  Then settings.downloadHistoryEnabled is false

Scenario: A corrupt stored value recovers to the default
  Given storage.local has settings: { downloadHistoryEnabled: "nope" }
  When getSettings() resolves
  Then settings.downloadHistoryEnabled is false

Scenario: watchSettings delivers a change to the flag
  Given a watcher subscribed via watchSettings
  When setSettings({ downloadHistoryEnabled: true }) is called
  Then the watcher receives settings with downloadHistoryEnabled true
  And after unwatch, further changes are not delivered

Scenario: The schema test asserts the field exists with a boolean default
  Given the Settings schema
  When decoding an empty object
  Then downloadHistoryEnabled is present and false
```

## Steps
1. In `settings.test.ts`, add a default-off test and a corrupt-recovery test next to the existing `cloudSyncEnabled` ones, using `fakeBrowser` storage.
2. Add/extend a `watchSettings` case for the new flag.
3. In `schema.test.ts`, assert the `Settings` decode default includes `downloadHistoryEnabled: false`.

## Verification
- `bun run test src/core/settings/settings.test.ts src/core/schema/schema.test.ts` — **fails (Red)** until the field is added.

## Notes
- Use `fakeBrowser` (WXT) for storage doubles. Match the existing optional-with-default decode pattern used for `cloudSyncEnabled`.
