# Task 002 — Cloud-sync settings schema (test / Red)

- **type:** test
- **depends-on:** []
- **files:** `src/core/settings/settings.test.ts` (modify) and/or `src/core/schema/schema.test.ts` (modify)

## Objective

Write failing tests for three new `Settings` fields, following the existing
`withDecodingDefaultKey` corrupt-recovery pattern already used in `src/core/schema/index.ts`. The
fields do not exist yet, so these tests are Red.

## BDD Scenario

```gherkin
Scenario: Cloud sync is off on a fresh install
  Given a user who has never opened settings
  When the extension decodes its settings
  Then cloudSyncEnabled is false
  And syncTrigger defaults to "onDownload"
  And cloudConvexUrl is empty (no vendor default)

Scenario: Corrupt settings recover to safe defaults
  Given a settings blob with an unknown/invalid syncTrigger value
  When settings are decoded
  Then decoding succeeds with cloudSyncEnabled false and syncTrigger "onDownload"
  And no exception escapes to the caller

Scenario: User selects a sync trigger
  Given cloud sync is enabled
  When the user sets syncTrigger to "both"
  Then the stored setting is "both"
  And the value is one of onDownload | onDemand | both
```

## Steps

1. Add a test asserting `decode({})` yields `cloudSyncEnabled === false`, `syncTrigger === 'onDownload'`,
   `cloudConvexUrl === ''`.
2. Add a test feeding `{ syncTrigger: 'garbage' }` and asserting recovery to `'onDownload'` (no throw).
3. Add a test asserting the `SyncTrigger` union accepts only `onDownload | onDemand | both`.

## Verification

- `bun run test src/core/settings` (and/or `src/core/schema`) → the new cases **FAIL** (fields absent).
- Existing settings tests still pass.
