# Task 004 (impl) — SavedIndex

**type**: impl
**depends-on**: ["004-test"]
**files**: `src/core/sync/saved-index.ts`

Make Task 004's tests pass (Green): the pure local-first Saved Index.

## BDD Scenario

```gherkin
Scenario: Seed answers from local history without querying Convex
  Given the index is seeded with ["T1","T2"]
  When resolve(["T1","T3"], queryConvex) runs and queryConvex(["T3"]) returns []
  Then the result contains "T1" and not "T3"
  And queryConvex was called only with the unknowns ["T3"]

Scenario: markSaved lights up instantly
  Given markSaved("T9") was called
  When resolve(["T9"], queryConvex) runs
  Then the result contains "T9" and queryConvex was not called

Scenario: Offline degrades to local-only, never throws
  Given the index is seeded with ["T1"]
  When resolve(["T1","T2"], queryConvex) runs and queryConvex rejects
  Then the result is ["T1"] and no error propagates

Scenario: A miss is not re-queried within the TTL
  Given resolve(["T5"]) ran and queryConvex returned [] (a miss)
  When resolve(["T5"]) runs again within the TTL window
  Then queryConvex is not called again
```

## Steps

- Implement the index. Contract (signatures only — no body logic):
  ```ts
  export type QueryConvex = (tweetIds: string[]) => Promise<string[]>
  export interface SavedIndex {
    readonly seed: (tweetIds: Iterable<string>) => void
    readonly markSaved: (tweetId: string) => void
    readonly resolve: (tweetIds: string[], queryConvex: QueryConvex) => Promise<string[]>
  }
  export function makeSavedIndex(opts?: { now?: () => number; missTtlMs?: number }): SavedIndex
  ```
- Behavior (described): `resolve` returns known-saved ids immediately; computes the
  unknown remainder excluding ids inside their miss-TTL; calls `queryConvex` only on
  that remainder; unions hits into the known set and stamps misses with the current
  clock; on `queryConvex` rejection returns just the locally-known subset (no throw).
- Pure: state is an in-memory Set + a miss-timestamp Map; `now` and `missTtlMs` are
  injected with sane defaults.

## Verification

- `bun run test src/core/sync/saved-index.test.ts` — Task 004 cases **pass** (Green).
- 100% coverage of `saved-index.ts` under the `src/core` gate.
