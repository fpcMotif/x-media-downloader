# Task 002: Admission core impl (Green)

**depends-on**: task-002-admission-core-test

## Description

Implement the pure admission decision core that turns the task-002 tests green. No I/O — the module receives already-probed sizes and an already-resolved saved-tweet set, and returns decisions. Describe-what-not-how: only the contract is fixed below.

## Execution Context

**Task Number**: 4 of 15
**Phase**: Foundation (core logic)
**Prerequisites**: task-002-admission-core-test committed and failing

## BDD Scenarios

Same scenarios as [task-002-admission-core-test.md](./task-002-admission-core-test.md).

## Files to Modify/Create

- Create: `src/core/download/admission.ts`

### Contract (signatures only — no bodies)

```ts
import type { MediaItem, MediaType } from '../schema'

export type SkipReason =
  | 'duplicate' | 'filtered-type' | 'too-small' | 'too-big' | 'daily-budget'

export interface FilterSettings {
  readonly preventDuplicateDownloads: boolean
  readonly skipTypes: ReadonlyArray<MediaType>
  readonly minWidth: number
  readonly minHeight: number
  readonly maxFileSizeBytes: number  // 0 = off
  readonly dailyMaxBytes: number     // 0 = off
  readonly dailyMaxCount: number     // 0 = off
}

export type AdmissionDecision = { admit: true } | { admit: false; reason: SkipReason }

/** Cheap, metadata-only checks in order: media-type -> min-resolution -> duplicate. */
export function freeReason(
  item: MediaItem,
  settings: FilterSettings,
  savedTweetIds: ReadonlySet<string>,
): SkipReason | null

/** 'too-big' when a known size exceeds the cap; null when cap off or size unknown (fail-open). */
export function sizeReason(sizeBytes: number | null, maxFileSizeBytes: number): SkipReason | null

/** 'daily-budget' when adding this item would cross either active limit. */
export function budgetReason(
  running: { bytes: number; count: number },
  add: { bytes: number; count: number },
  limits: { dailyMaxBytes: number; dailyMaxCount: number },
): SkipReason | null

export interface AdmissionContext {
  readonly settings: FilterSettings
  readonly savedTweetIds: ReadonlySet<string>
  readonly sizeBytes: number | null
  readonly running: { bytes: number; count: number }
}

/** Composes free -> size -> budget; first failing check wins the reason. */
export function evaluateAdmission(item: MediaItem, ctx: AdmissionContext): AdmissionDecision
```

## Steps

### Step 1: Implement Logic (Green)
- Implement the helpers and `evaluateAdmission`. Disabled settings (off/0/empty) short-circuit their check. `freeReason` ordering = type → resolution → duplicate.
- **Verification**: `bunx vitest run src/core/download/admission.test.ts` PASSES.

### Step 2: Verify & Refactor
- **Verification**: `bun run test:coverage` shows 100% for `src/core/download/admission.ts`; `bun run check` clean.

## Verification Commands

```bash
bunx vitest run src/core/download/admission.test.ts
bun run check
```

## Success Criteria

- Task-002 tests green; module is 100% covered; no other files touched.
