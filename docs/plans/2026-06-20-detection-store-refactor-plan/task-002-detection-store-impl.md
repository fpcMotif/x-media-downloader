# task-002 — Implement makeDetectionStore, behavior-preserving (M2, GREEN)

Type: impl · Depends on: none · Pairs with: task-002-test

## Context
Extract the overlay's four detection containers (`byId`, `byKey`, `recoveredKeys`,
`recoveryAttempted`) + their add/dedup decisions into one tested module, with
IDENTICAL semantics to today (no behavior change — that is M3).

## Scenario
- Given the characterization tests (task-002-test),
- When `makeDetectionStore()` is implemented,
- Then all those tests pass and `src/core` stays at 100% branch coverage.

## Implementation notes
- New file `src/core/adapters/x/detection-store.ts`: `makeDetectionStore()` closing
  over the four containers. API (from the overlay call sites):
  `addDetected(items): MediaItem[]`, `addRecovered(items): MediaItem[]`,
  `needsRecovery(root: ParentNode): string[]` (wraps the existing pure
  `videoTweetsNeedingRecovery` with `keys()`), `resolve(key)`, `get(id)`,
  `values()`, `valuesForTweet(tweetId)`, `count`, `clear()`.
- Move `keysForItem` out of the overlay into this module.
- Keep the dual id+key index EXACTLY as today (do not unify — that is M3).
- Reuse `videoTweetsNeedingRecovery`, `mediaKeyFromUrl`, `resolveTweetMedia` — do
  not reinvent.

## Verification
```
bunx vitest run src/core/adapters/x/detection-store.test.ts   # GREEN
bun run test:coverage   # src/core stays 100% branches (ignore the concurrent
                        # filename.ts gap if still present)
bun run typecheck
```
Done when: task-002-test passes, coverage holds, typecheck green.
