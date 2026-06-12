# Task 002: downloadBadgeEnabled schema impl (Green)

**depends-on**: task-002-settings-schema-test

## Description

Add the `downloadBadgeEnabled` key to the Settings schema with a decoding default of `true`, making the task-002 tests pass.

**IMPORTANT**: Load the `effect-v4` skill BEFORE editing — the schema uses Effect v4 beta patterns.

## Execution Context

**Task Number**: 4 of 8
**Phase**: Foundation
**Prerequisites**: task-002-settings-schema-test committed and failing

## BDD Scenarios

Same scenarios as [task-002-settings-schema-test.md](./task-002-settings-schema-test.md) — this task turns them green.

```gherkin
Scenario: Schema gains the key with default true
  Given the Settings Schema.Struct in src/core/schema/index.ts
  When downloadBadgeEnabled is added following the quickGrabEnabled pattern
  Then decoding {} yields downloadBadgeEnabled = true
  And corrupt stored values recover to true via the existing settings recovery path
```

**Spec Source**: `docs/superpowers/specs/2026-06-12-photo-download-badge-design.md` §5

## Files to Modify/Create

- Modify: `src/core/schema/index.ts` (Settings struct, near `quickGrabEnabled` at ~line 49) — pattern:
  `downloadBadgeEnabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true)))` with a one-line comment in the existing comment style.

## Steps

### Step 1: Implement Logic (Green)
- Add the key. No other behavior change.
- **Verification**: `bunx vitest run src/core/schema/schema.test.ts src/core/settings/settings.test.ts` PASSES.

### Step 2: Verify & Refactor
- Full gate.

## Verification Commands

```bash
bunx vitest run src/core/schema/schema.test.ts src/core/settings/settings.test.ts
bun run check
```

## Success Criteria

- Task-002 tests green; no other schema keys touched; `bun run check` clean.
