# Task 002: downloadBadgeEnabled schema test (Red)

**depends-on**: none

## Description

Write failing tests pinning the new `downloadBadgeEnabled` settings key: default `true` when absent, corrupt-value recovery to the default. Extend the existing schema/settings suites — follow their established patterns exactly.

**IMPORTANT**: This codebase uses Effect v4 beta ("effect-smol"). Load the `effect-v4` skill BEFORE writing any test code that decodes schemas — v3 idioms (`decodeUnknownEither`, `ParseError`, …) do not exist here.

## Execution Context

**Task Number**: 3 of 8
**Phase**: Foundation
**Prerequisites**: none

## BDD Scenarios

```gherkin
Scenario: Missing key defaults on
  Given stored settings JSON without a downloadBadgeEnabled key
  When the Settings schema decodes it
  Then downloadBadgeEnabled is true

Scenario: Corrupt value recovers to default
  Given stored settings where downloadBadgeEnabled is a non-boolean value
  When settings are read through the recovery path
  Then the user receives downloadBadgeEnabled = true
  And recovery follows the existing semantics (corrupt settings reset to full defaults)
```

**Spec Source**: `docs/superpowers/specs/2026-06-12-photo-download-badge-design.md` §5

## Files to Modify/Create

- Modify: `src/core/schema/schema.test.ts` (default-when-absent case, alongside the existing `quickGrabEnabled` default tests)
- Modify: `src/core/settings/settings.test.ts` (corrupt-recovery case, following its existing corrupt-recovery tests)

## Steps

### Step 1: Verify Scenarios
- Locate the existing default/corrupt-recovery tests for `quickGrabEnabled` and mirror their shape for the new key.

### Step 2: Implement Test (Red)
- Add both cases.
- **Verification**: `bunx vitest run src/core/schema/schema.test.ts src/core/settings/settings.test.ts` FAILS (key not in schema yet — likely a type error, which counts as Red).

## Verification Commands

```bash
bunx vitest run src/core/schema/schema.test.ts src/core/settings/settings.test.ts   # must FAIL
```

## Success Criteria

- Both scenarios encoded as tests in the suites' existing style; failure is solely the missing schema key.
