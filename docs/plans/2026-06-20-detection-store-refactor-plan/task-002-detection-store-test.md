# task-002 — Characterization tests for makeDetectionStore (M2, RED)

Type: test · Depends on: none · Pairs with: task-002-impl

## Context
The recover/dedup logic the review had to hand-trace lives untested in the overlay
closure. Before extracting it, pin TODAY's behavior as characterization tests so
the extraction (task-002-impl) can't change semantics.

## Scenario (the 5 invariants the review traced + the query surface)
- Given a fresh `makeDetectionStore()`:
- `addDetected` returns only newly-added items; dual-index (by id AND media key).
- `addRecovered` skips `type==='photo'`, skips items whose key is already known,
  records recovered keys; a LATER `addDetected` of the same media (different id
  scheme) is suppressed via the recovered-keys guard (no double count).
- `addRecovered` re-checks known-keys on its input (TOCTOU-safe).
- `resolve(key)` returns the item for a media key; `get(id)`, `values()`,
  `valuesForTweet(tweetId)`, `count` mirror today's byId/byKey reads.
- `needsRecovery(root)` returns the same tweet ids as
  `videoTweetsNeedingRecovery(root, <store keys>)`.
- `clear()` empties all four containers.

## Implementation notes
- New file `src/core/adapters/x/detection-store.test.ts`.
- Assert CURRENT behavior, including the suspected tee-vs-DOM photo double-count
  (it stays present in M2 — it is FIXED in M3, not here).
- happy-dom is the global env (build DOM via `document.createElement`).

## Verification
```
bunx vitest run src/core/adapters/x/detection-store.test.ts
# RED: fails because makeDetectionStore does not exist yet (task-002-impl makes it green)
```
Done when: the test file exists and fails ONLY because the impl is absent.
