# Task 001: Filter settings schema test (Red)

**depends-on**: none

## Description

Write failing tests pinning the seven new admission-gate settings keys: each defaults to off/zero when absent, and corrupt values recover to the default. Extend the existing schema/settings suites — follow their established `quickGrabEnabled` / `downloadConcurrency` patterns exactly.

**IMPORTANT**: This codebase uses Effect v4 beta ("effect-smol"). Load the `effect-v4` skill BEFORE writing any test code that decodes schemas — v3 idioms (`decodeUnknownEither`, `ParseError`, …) do not exist here.

## Execution Context

**Task Number**: 1 of 15
**Phase**: Foundation
**Prerequisites**: none

## BDD Scenarios

```gherkin
Scenario: New keys default off/zero when absent
  Given stored settings JSON without any admission-gate keys
  When the Settings schema decodes it
  Then preventDuplicateDownloads is false
  And skipTypes is an empty array
  And minWidth, minHeight, maxFileSizeMB, dailyMaxMB, dailyMaxCount are all 0

Scenario: Corrupt values recover to defaults
  Given stored settings where an admission-gate key holds a wrong-typed value
  When settings are read through the recovery path
  Then the user receives the schema defaults (off/zero) for those keys
  And recovery follows the existing semantics (corrupt settings reset to full defaults)
```

**Spec Source**: `docs/superpowers/specs/2026-06-27-download-admission-gate-design.md` (Settings & UI)

## Files to Modify/Create

- Modify: `src/core/schema/schema.test.ts` (default-when-absent cases, alongside the existing default tests)
- Modify: `src/core/settings/settings.test.ts` (corrupt-recovery case, following its existing corrupt-recovery tests)

## Steps

### Step 1: Verify Scenarios
- Locate the existing default/corrupt-recovery tests for `quickGrabEnabled` / `downloadConcurrency` and mirror their shape for the seven new keys.

### Step 2: Implement Test (Red)
- Add both scenarios. `skipTypes` default `[]`; the five numeric keys default `0`; `preventDuplicateDownloads` default `false`.
- **Verification**: `bunx vitest run src/core/schema/schema.test.ts src/core/settings/settings.test.ts` FAILS (keys not in schema yet — a type error counts as Red).

## Verification Commands

```bash
bunx vitest run src/core/schema/schema.test.ts src/core/settings/settings.test.ts   # must FAIL
```

## Success Criteria

- Both scenarios encoded in the suites' existing style; failure is solely the missing schema keys.
