# Task 001: Badge state machine impl (Green)

**depends-on**: task-001-badge-core-test

## Description

Implement `src/core/badge.ts` so the task-001 test suite passes. Pure functions over readonly state, exactly the contract pinned in [task-001-badge-core-test.md](./task-001-badge-core-test.md). No DOM, no timers, no Effect services — mirror the `core/quickgrab.ts` idiom (this module is plain TS; the `effect-v4` skill is NOT needed here).

## Execution Context

**Task Number**: 2 of 8
**Phase**: Foundation
**Prerequisites**: task-001-badge-core-test committed and failing

## BDD Scenarios

Same scenarios as [task-001-badge-core-test.md](./task-001-badge-core-test.md) — this task turns them green.

```gherkin
Scenario: All task-001 test scenarios pass
  Given the failing suite from task-001-badge-core-test
  When src/core/badge.ts is implemented per the pinned contract
  Then bunx vitest run src/core/badge.test.ts passes
  And the full suite has no regressions
```

**Spec Source**: `docs/superpowers/specs/2026-06-12-photo-download-badge-design.md` §4

## Files to Modify/Create

- Create: `src/core/badge.ts`

## Steps

### Step 1: Implement Logic (Green)
- Implement the contract; constants: `badgeNudgeDelayMs = 2200`, `badgeSavedRevertMs = 1600`.
- Document each export with the same doc-comment style as `quickgrab.ts` (what the rule is, not how the code works).
- **Verification**: `bunx vitest run src/core/badge.test.ts` PASSES.

### Step 2: Verify & Refactor
- Run the full gate; refactor while green if needed.

## Verification Commands

```bash
bunx vitest run src/core/badge.test.ts
bun run check   # fmt + lint + typecheck + all tests
```

## Success Criteria

- Task-001 suite green; `bun run check` clean; no implementation leaked into UI files.
