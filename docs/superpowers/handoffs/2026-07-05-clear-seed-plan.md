# Handoff: planClearSeed — pure clear-seed composition in core/clear

- **Date:** 2026-07-05 · **Origin:** round-4 /improve-codebase-architecture (8 survey lenses → 21
  adversarial skeptics → survivors grilled; decisions adjudicated by the lead architect)
- **Status:** READY — not started. **Branch discipline:** implement on a fresh branch off main (or the
  current branch per the user's instruction at execution time); this handoff is self-contained.
- **Skeptic tally:** 1–1, tie broken FOR by the lead architect. Strength: WORTH EXPLORING (not a slam
  dunk — record the dissent honestly, see Grilled design decisions below).

## Problem

`handleDownload` in `src/entrypoints/background.ts` (function starts at line 774; the clear-seed block is
lines 895–943) computes the whole clear-on-complete seed inline: scope selection, aria2/clear-off/no-scope
skip reasons, quote-card-id filtering, `clearExpect` widening, and the `seedClearLedger` call, all as one
un-unit-testable Effect-gen block mutating live background state (`clearOriginTab` map,
`clearCoordinator`).

The hard invariants are already tested elsewhere and are NOT what this handoff touches:
- unclearable-id rule → `isClearableTweetId` in `src/core/clear/clearer.ts:156` (regex-tested)
- ledger merge/CAS semantics → `seedScopes`/`reduce`/`tryClaim` in `src/core/clear/ledger.ts` (tested)

What is untested and has already produced a real surprise is the **composition** around those
invariants — specifically the scope-widening asymmetry pinned by the 2026-06-24 audit: the sweep path
widens scopes via `clearAllListsOnSave` but the auto-hook path does not. Today that asymmetry is enforced
by nothing but a ternary:

```ts
// src/entrypoints/background.ts:895-899
const clearScopes: Scope[] = sweep
  ? settings.clearAllListsOnSave
    ? [...new Set([sweep.scope, ...hookScopes(settings).filter((s) => s !== 'notInterested')])]
    : [sweep.scope]
  : hookScopes(settings)
```

Extracting this composition into a pure function buys testability-by-construction exactly where the
surprise already happened, without re-litigating the invariants that are already solid.

## Grilled design decisions

1. **Inputs, verified against the current tree.** `handleDownload`'s signature is
   `(items: ReadonlyArray<MediaItem>, sweep?: { readonly scope: Scope }, clearExpect?: ReadonlyArray<{ readonly tweetId: string; readonly ids: ReadonlyArray<string> }>, originTabId?: number)`
   (background.ts:774–779). `requests: SaveRequest[]` is derived earlier in the same function (from
   `planDownloads`, background.ts ~792). `mediaById: Map<string, MediaItem>` is built at background.ts:810
   (`new Map(admission.admitted.map((i) => [i.id, i]))`). `settings: Settings` (from `SettingsService`)
   is read for `clearAllListsOnSave`, `downloadStrategy`, `clearOnSave`, and — via `hookScopes` — the
   three per-scope toggles `autoUnbookmarkOnSave` / `autoUnlikeOnSave` / `autoNotInterestedOnSave`
   (all in `src/core/schema/index.ts`).

2. **`hookScopes` moves into `core/clear`, into `ledger.ts`** (which already owns `Scope`). Verified pure
   over `Settings` (type-only import), zero coupling to the coordinator's machinery — its current body
   in `src/background/clear-coordinator.ts:39-43` reads only the three boolean toggles off `Settings` and
   returns `Scope[]`. It has TWO production consumers at two different times: seed time (this handoff,
   via `planClearSeed`) and settle time at `src/background/clear-coordinator.ts:160`
   (`enabledScopesFor`, inside `entry.origin === 'sweep' ? ... : new Set(hookScopes(settings))`).
   Passing a precomputed `Scope[]` into `planClearSeed` would just relocate this same coupling one call
   site over, not remove it. `clear-coordinator.ts` re-imports `hookScopes` from `core/clear` after the
   move (it currently defines it locally at line 39; the re-export line 76 import in background.ts,
   `import { makeClearCoordinator, hookScopes } from '../background/clear-coordinator'`, becomes a
   re-export or background.ts imports `hookScopes` from `core/clear` directly — see Plan step 1).
   Deletion test: remove `hookScopes` from `clear-coordinator.ts` and grep for local use — only
   `enabledScopesFor` (line 160) and the moved-away background.ts call site depend on it. Passes.

3. **Result type.** `planClearSeed` returns one of:
   ```ts
   type ClearSeedVerdict =
     | { readonly decision: 'skip'; readonly reason: 'aria2' | 'clear-off' | 'no-scopes' }
     | {
         readonly decision: 'seed'
         readonly byTweet: Map<string, string[]>
         readonly scopes: Scope[]
         readonly origin: 'sweep' | 'hook'
         readonly unclearableCount: number
       }
   ```
   Note: `origin` here uses the same `'sweep' | 'hook'` literal that `ClearCoordinator.seedClearLedger`
   already takes as its third parameter (`src/background/clear-coordinator.ts:69`,
   `clearOrigin: 'sweep' | 'hook'`) — do NOT reuse `ledger.ts`'s broader `Origin` type
   (`'hook' | 'drain' | 'sweep'`, `ledger.ts:16`), which also admits `'drain'` and is not the type
   `seedClearLedger` accepts. `unclearableCount` annotates a SUCCESSFUL seed — the unclearable trace
   co-exists with seeding (downloads and the seed both proceed for the clearable subset); it is not a
   terminal skip reason.

4. **Shell (background.ts) keeps, and only, the following after the swap:**
   - mapping `decision:'skip'` reasons to the three existing `traceBackground('clear-skip', ...)` calls
     (background.ts:901-907, keeping their exact wording)
   - mapping `unclearableCount > 0` to the existing `traceBackground('clear-skip', { detail: ... })` call
     for "not DOM-clearable (v1)" (background.ts:935-938)
   - the `rememberClearOrigin` loop over `byTweet.keys()` (background.ts:941-942) — this mutates the
     live `clearOriginTab` Map (background.ts:301) and stays in the shell
   - the `clearCoordinator.seedClearLedger(byTweet, scopes, origin)` call (background.ts:943)

5. **File location: `src/core/clear/seed.ts`.** Noun convention parallel to the sibling `settle.ts`
   (`src/core/clear/settle.ts`, which exports `decideSettle`). `plan-seed.ts` was considered and rejected
   — it collides with the `core/download` "plan" vocabulary (`planDownloads` in
   `src/core/download/strategy.ts` and friends), and this module has nothing to do with download
   planning. Imports verified cycle-free: `Scope` from `ledger.ts:14` (same directory, no cycle);
   `Settings` and `MediaItem` from `src/core/schema/index.ts` (schema has no reverse dependency on
   `core/clear`); `SaveRequest` from `src/core/download/strategy.ts:30` (download strategy has no
   dependency on `core/clear`, so `core/clear` depending on it is a one-way edge, not a cycle);
   `isClearableTweetId` from `src/core/clear/clearer.ts:156` (same directory).

## Interface sketch

```ts
// src/core/clear/seed.ts
import type { Scope } from './ledger'
import type { Settings, MediaItem } from '../schema'
import type { SaveRequest } from '../download/strategy'
import { isClearableTweetId } from './clearer'

export type ClearSeedVerdict =
  | { readonly decision: 'skip'; readonly reason: 'aria2' | 'clear-off' | 'no-scopes' }
  | {
      readonly decision: 'seed'
      readonly byTweet: Map<string, string[]>
      readonly scopes: Scope[]
      readonly origin: 'sweep' | 'hook'
      readonly unclearableCount: number
    }

export function planClearSeed(input: {
  readonly requests: ReadonlyArray<SaveRequest>
  readonly mediaById: ReadonlyMap<string, MediaItem>
  readonly sweep?: { readonly scope: Scope }
  readonly clearExpect?: ReadonlyArray<{ readonly tweetId: string; readonly ids: ReadonlyArray<string> }>
  readonly settings: Settings
}): ClearSeedVerdict
```

`hookScopes` relocates to `src/core/clear/ledger.ts` with its existing signature unchanged:
`export const hookScopes = (s: Settings): Scope[] => [...]`.

## Out of scope — DO NOT

- Wholesale `handleDownload` split. Refuted shape in the round-4 survey — this handoff extracts only the
  clear-seed composition, not the surrounding admission/queue/history/cloud-upload orchestration.
- The DOM-side clear-affordance module. Refuted in an earlier round (see
  `[[architecture-review-deepening-candidates]]` memory: "C2 clear-affordance REFUTED").
- Changing WHAT gets seeded. This is a behavior-preserving extraction. The 2026-06-24 sweep-vs-hook
  widening asymmetry (sweep widens via `clearAllListsOnSave`; hook does not) is REPRODUCED faithfully and
  pinned by a test as CURRENT behavior. Fixing or changing that policy is a separate product decision —
  this handoff makes it cheap to make later, once the test exists, but does not make it itself.

## Plan with verifiable goals

1. Move `hookScopes` from `src/background/clear-coordinator.ts:39-43` to `src/core/clear/ledger.ts`
   (unchanged body/signature). Update `clear-coordinator.ts`'s internal use at line 160
   (`enabledScopesFor`) to import it from `./ledger` (relative import, same as its existing `Scope`
   import). Update `background.ts:76` (`import { makeClearCoordinator, hookScopes } from
   '../background/clear-coordinator'`) to import `hookScopes` from `../core/clear/ledger` instead.
   → verify: `bun run check` (lint + tsgo + full vitest run) green.
2. Create `src/core/clear/seed.ts` (interface above) and `src/core/clear/seed.test.ts`. Cases to cover:
   - aria2 skip (`settings.downloadStrategy === 'aria2'`)
   - clear-off skip (`!settings.clearOnSave`)
   - no-scopes skip (`clearScopes.length === 0`, both sweep and hook paths)
   - quote-card filtered: an item whose `postId` fails `isClearableTweetId` is excluded from `byTweet`
     and counted in `unclearableCount`, while downloads-adjacent behavior (i.e. the function doesn't drop
     other tweets in the same batch) is preserved
   - `clearExpect` widening: union of existing `byTweet` ids with `clearExpect[].ids` for a matching
     `tweetId`; no-op when the tweetId isn't already in `byTweet`
   - sweep-widens-but-hook-doesn't asymmetry: with `clearAllListsOnSave: true`, a sweep request produces
     `scopes` including the hook's non-`notInterested` scopes unioned with `sweep.scope`; a hook request
     (`sweep` undefined) with the same settings produces only `hookScopes(settings)` — pin this exact gap
     as current behavior, not aspirational
   - dedup of scopes (the `[...new Set(...)]` behavior in the sweep-widening branch)
   → verify: `bun run test:coverage` stays 100% over `src/core` + `src/lib` (new file must be fully
   covered by the case list above; no coverage regression elsewhere).
3. Swap the `background.ts:895-943` block to call `planClearSeed({ requests, mediaById, sweep,
   clearExpect, settings })`, then a small shell `switch`/`if` on `.decision` that maps `'skip'` reasons
   to the three existing `traceBackground('clear-skip', ...)` calls, maps `unclearableCount > 0` on a
   `'seed'` verdict to the existing "not DOM-clearable (v1)" trace, runs the `rememberClearOrigin` loop
   over `verdict.byTweet.keys()` when `originTabId !== undefined`, and calls
   `clearCoordinator.seedClearLedger(verdict.byTweet, verdict.scopes, verdict.origin)`.
   → verify: `bun run check` green AND `bun run build` (wxt build) green.

## Files

- `src/core/clear/ledger.ts` — add `hookScopes` (moved from clear-coordinator.ts)
- `src/core/clear/ledger.test.ts` — add `hookScopes` cases (or keep them in a co-located describe block;
  mirror however `ledger.test.ts` currently organizes its exports)
- `src/core/clear/seed.ts` — new, `planClearSeed`
- `src/core/clear/seed.test.ts` — new
- `src/background/clear-coordinator.ts` — remove local `hookScopes` definition (line 39-43), import it
  from `./ledger` instead, used at line 160
- `src/background/clear-coordinator.test.ts` — remove or adjust the `hookScopes` describe block
  (currently lines 15-24) since the function moves; re-add equivalent cases in `ledger.test.ts` per above
- `src/entrypoints/background.ts` — replace the inline block at lines 895-943 with the `planClearSeed`
  call + shell mapping; update the line-76 import

## Test plan

- `src/core/clear/seed.test.ts`: pure function, no Effect, no fakes needed — mirror the plain
  input/output table-test idiom already used in `src/core/clear/ledger.test.ts` and
  `src/core/clear/clearer.test.ts` (both plain Vitest `describe`/`it` over pure functions, no
  `fakeBrowser`/mocks).
- `src/core/clear/ledger.test.ts`: add `hookScopes` cases by porting the existing table-style assertions
  from `src/background/clear-coordinator.test.ts:15-24` (`toggles(...)` helper produces a minimal
  `Settings` partial; the four assertions cover all-on, single-scope-on ×3 combos, all-off).
- `src/background/clear-coordinator.test.ts`: delete the `hookScopes` describe block (lines 15-24) since
  the function no longer lives here; keep `enabledScopesFor`-adjacent coverage untouched since its
  behavior is unchanged (only its `hookScopes` import moves).
- No new background.ts-level integration test is required by this handoff — `handleDownload`'s Effect-gen
  shell has no existing direct unit test today (per `[[architecture-review-deepening-candidates]]` /
  `[[thermos-findings-adversarially-adjudicated]]` context: background.ts orchestration is exercised only
  via e2e/build gates, not unit tests), and this handoff doesn't change that; the coverage gate excludes
  `src/entrypoints`.

## Coordination

- `background.ts` is also touched by the retry-plan and capture-build-export handoffs dated 2026-07-05.
  This handoff's edit region is lines 76 (one import line) and 895-943 (the clear-seed block) — disjoint
  from typical retry/download-plan regions (near the queue/monitor code, background.ts ~800-895 and
  ~945-1050) and from capture/export regions (elsewhere in the file). Confirm disjointness against the
  sibling handoffs' file:line references before landing if they touch anything inside 890-945.
- `core/clear` gains nothing else this round — `seed.ts` is the only new module in this directory across
  all 2026-07-05 handoffs.
- Recommended ordering: land this after any handoff that also touches `background.ts:895-943` directly
  (none identified as of this writing) or independently if the sibling handoffs' regions are confirmed
  disjoint. Land the `hookScopes` move (step 1) as its own commit before `seed.ts` lands, so a `bun run
  check` failure isolates cleanly to either the mechanical move or the new logic.
