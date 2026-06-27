# Task 001: Filter settings schema impl (Green)

**depends-on**: task-001-settings-schema-test

## Description

Add the seven admission-gate keys to the `Settings` schema with decoding defaults, making the task-001 tests pass. No behavior change beyond the schema.

**IMPORTANT**: Load the `effect-v4` skill BEFORE editing — the schema uses Effect v4 beta patterns.

## Execution Context

**Task Number**: 2 of 15
**Phase**: Foundation
**Prerequisites**: task-001-settings-schema-test committed and failing

## BDD Scenarios

Same scenarios as [task-001-settings-schema-test.md](./task-001-settings-schema-test.md) — this task turns them green.

```gherkin
Scenario: Schema gains the seven keys with off/zero defaults
  Given the Settings Schema.Struct in src/core/schema/index.ts
  When the admission-gate keys are added following the existing default-key pattern
  Then decoding {} yields the off/zero defaults
  And corrupt stored values recover via the existing settings recovery path
```

**Spec Source**: `docs/superpowers/specs/2026-06-27-download-admission-gate-design.md` (Settings & UI)

## Files to Modify/Create

- Modify: `src/core/schema/index.ts` (Settings struct) — add, following the existing `withDecodingDefaultKey` pattern and comment style:
  - `preventDuplicateDownloads: Schema.Boolean` → default `false`
  - `skipTypes: Schema.Array(MediaType)` → default `[]` (reuse the existing `MediaType` schema)
  - `minWidth: Schema.Number` → default `0`
  - `minHeight: Schema.Number` → default `0`
  - `maxFileSizeMB: Schema.Number` → default `0` (0 = off)
  - `dailyMaxMB: Schema.Number` → default `0` (0 = off)
  - `dailyMaxCount: Schema.Number` → default `0` (0 = off)

## Steps

### Step 1: Implement Logic (Green)
- Add the keys. No other behavior change.
- **Verification**: `bunx vitest run src/core/schema/schema.test.ts src/core/settings/settings.test.ts` PASSES.

### Step 2: Verify & Refactor
- Full gate.

## Verification Commands

```bash
bunx vitest run src/core/schema/schema.test.ts src/core/settings/settings.test.ts
bun run check
```

## Success Criteria

- Task-001 tests green; no other schema keys touched; `bun run check` clean.
