# Task 004: Size probe test (Red)

**depends-on**: none

## Description

Write failing unit tests for the size probe — a HEAD request that reads `content-length` and is fail-open (returns `null`, never throws) on a missing header, a non-ok status, or a network error. Uses an injected fetch, so it is fully testable under the 100% `src/core` gate with a fake.

## Execution Context

**Task Number**: 7 of 15
**Phase**: Foundation (core logic)
**Prerequisites**: none

## BDD Scenarios

```gherkin
Scenario: Returns parsed content-length on success
  Given a fake fetch that resolves ok with content-length: 1048576
  When probe(url) is called
  Then it resolves to 1048576

Scenario: Fail-open on a missing content-length header
  Given a fake fetch that resolves ok with no content-length
  When probe(url) is called
  Then it resolves to null

Scenario: Fail-open on a non-ok status
  Given a fake fetch that resolves with ok: false (e.g. 401)
  When probe(url) is called
  Then it resolves to null

Scenario: Fail-open on a network error
  Given a fake fetch that rejects
  When probe(url) is called
  Then it resolves to null (no throw)
```

**Spec Source**: `docs/superpowers/specs/2026-06-27-download-admission-gate-design.md` (Mechanics — size probe)

## Files to Modify/Create

- Create: `src/core/download/size-probe.test.ts`

## Steps

### Step 1: Verify Scenarios
- Target the `makeSizeProbe` contract in task-004-impl; the fake fetch returns a minimal `{ ok, status, headers: { get(name) } }`-shaped response.

### Step 2: Implement Test (Red)
- **Verification**: `bunx vitest run src/core/download/size-probe.test.ts` FAILS (module missing).

## Verification Commands

```bash
bunx vitest run src/core/download/size-probe.test.ts   # must FAIL
```

## Success Criteria

- Success and all three fail-open paths are encoded; failure is solely the missing module.
