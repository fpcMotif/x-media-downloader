# Task 006: Admission shell impl (Green)

**depends-on**: task-006-admission-shell-test, task-001-settings-schema-impl, task-002-admission-core-impl, task-004-size-probe-impl

## Description

Implement `makeAdmissionGate`, turning the task-006 tests green. It maps `Settings` → `FilterSettings` (MB → bytes), resolves the saved-tweet set when dedup is on, then walks candidates in input order applying the ordered checks from `admission.ts`, probing a survivor only when a size cap or byte budget is active, and accumulating the running budget so the projection locks tightly within one batch.

## Execution Context

**Task Number**: 12 of 15
**Phase**: Orchestration
**Prerequisites**: task-006-admission-shell-test committed and failing

## BDD Scenarios

Same scenarios as [task-006-admission-shell-test.md](./task-006-admission-shell-test.md).

## Files to Modify/Create

- Create: `src/background/admission-gate.ts`

### Contract (signatures only — no bodies)

```ts
import type { MediaItem, Settings } from '../core/schema'
import type { SkipReason } from '../core/download/admission'
import type { SizeProbePort } from '../core/download/size-probe'
import type { SavedIndex, QueryConvex } from '../core/sync/saved-index'

export interface AdmissionResult {
  readonly admitted: MediaItem[]
  readonly skipped: ReadonlyArray<{ item: MediaItem; reason: SkipReason }>
}

export interface AdmissionGate {
  readonly admit: (items: ReadonlyArray<MediaItem>) => Promise<AdmissionResult>
}

export function makeAdmissionGate(deps: {
  getSettings: () => Promise<Settings>
  savedIndex: SavedIndex
  queryConvex: QueryConvex
  sizeProbe: SizeProbePort
  readTodayBudget: () => Promise<{ bytes: number; count: number }>
}): AdmissionGate
```

## Steps

### Step 1: Implement Logic (Green)
- Map `Settings` → `FilterSettings` (`maxFileSizeMB`/`dailyMaxMB` × 1 MiB → bytes; pass `skipTypes`, `minWidth/Height`, `dailyMaxCount`, `preventDuplicateDownloads`).
- If dedup on, `savedTweetIds = new Set(await savedIndex.resolve([...unique tweetIds], queryConvex))`; else empty set.
- Seed `running` from `readTodayBudget()` when a budget is active.
- For each item in order: `freeReason` → if rejected, skip. Else probe size only when (`maxFileSizeBytes > 0` or `dailyMaxBytes > 0`), else `sizeBytes = null`. `sizeReason` → if rejected, skip. `budgetReason` → if rejected, skip. Else admit and add `{ bytes: sizeBytes ?? 0, count: 1 }` to `running`.
- Reuse `evaluateAdmission`'s helpers; do not re-derive the rule order in the shell.
- **Verification**: `bunx vitest run src/background/admission-gate.test.ts` PASSES.

### Step 2: Verify & Refactor
- **Verification**: `bun run check` clean.

## Verification Commands

```bash
bunx vitest run src/background/admission-gate.test.ts
bun run check
```

## Success Criteria

- Task-006 tests green; the gate operates on `MediaItem[]`; no probe when caps are off; `bun run check` clean.
