# Task 004: Size probe impl (Green)

**depends-on**: task-004-size-probe-test

## Description

Implement `makeSizeProbe` that turns the task-004 tests green: a HEAD request reading `content-length`, fail-open to `null`. Fetch is injected so the real wiring (task 007) can pass the bound SW fetch; tests pass a fake.

## Execution Context

**Task Number**: 8 of 15
**Phase**: Foundation (core logic)
**Prerequisites**: task-004-size-probe-test committed and failing

## BDD Scenarios

Same scenarios as [task-004-size-probe-test.md](./task-004-size-probe-test.md).

## Files to Modify/Create

- Create: `src/core/download/size-probe.ts`

### Contract (signatures only — no bodies)

```ts
export interface ProbeResponse {
  readonly ok: boolean
  readonly status: number
  readonly headers: { get(name: string): string | null }
}
export type ProbeFetch = (url: string, init: { method: 'HEAD' }) => Promise<ProbeResponse>

export interface SizeProbePort {
  /** Probed byte size from content-length, or null when unknown/unavailable (never throws). */
  readonly probe: (url: string) => Promise<number | null>
}

export function makeSizeProbe(deps: { fetch: ProbeFetch }): SizeProbePort
```

## Steps

### Step 1: Implement Logic (Green)
- Implement `makeSizeProbe`: HEAD the url; on ok, parse `content-length` to a finite number; otherwise return `null`. Catch all errors → `null`.
- **Verification**: `bunx vitest run src/core/download/size-probe.test.ts` PASSES.

### Step 2: Verify & Refactor
- **Verification**: `bun run test:coverage` shows 100% for `src/core/download/size-probe.ts`; `bun run check` clean.

## Verification Commands

```bash
bunx vitest run src/core/download/size-probe.test.ts
bun run check
```

## Success Criteria

- Task-004 tests green; module 100% covered; never throws.
