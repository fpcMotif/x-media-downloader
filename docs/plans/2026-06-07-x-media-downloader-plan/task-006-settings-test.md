# Task 006 — SettingsService (test)

**type:** test
**depends-on:** ["002-schema-impl"]

## BDD Scenario

```gherkin
Scenario: First run returns defaults
  Given empty chrome.storage.local
  When SettingsService.get runs
  Then it returns the default Settings (authFallbackEnabled false, concurrency 3)

Scenario: Persist and reload settings
  Given SettingsService.set updates the filenameTemplate
  When SettingsService.get runs afterward
  Then the updated template is returned

Scenario: Corrupt stored data falls back to defaults
  Given chrome.storage.local holds an invalid settings blob
  When SettingsService.get runs
  Then it returns defaults instead of throwing
```

## Files

- `src/core/settings/settings.test.ts`

## Steps

1. Use WXT `fakeBrowser`; reset storage between tests.
2. Failing tests for defaults, round-trip persistence, and corrupt-data recovery.

## Verification

- `bun test src/core/settings` — runs and **fails** (red).
