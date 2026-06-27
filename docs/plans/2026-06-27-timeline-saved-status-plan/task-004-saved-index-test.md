# Task 004 (test) — SavedIndex local-first merge

**type**: test
**depends-on**: []
**files**: `src/core/sync/saved-index.test.ts`

Write failing tests (Red) for the pure `SavedIndex`. All collaborators are injected
(an in-memory Set, an injected `queryConvex`, an injected clock) — no real network,
no real storage.

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

Scenario: Convex result is unioned and cached
  Given an empty seed
  When resolve(["T4"], queryConvex) runs and queryConvex returns ["T4"]
  Then the result contains "T4"
  And a second resolve(["T4"]) returns "T4" without re-querying

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

- Construct a `SavedIndex` with a spy `queryConvex` and a controllable clock.
- Assert each scenario above, checking both the returned saved subset **and** the
  exact arguments `queryConvex` was (or was not) called with.
- For the TTL scenario, advance the injected clock to assert re-query happens only
  after the TTL elapses.

## Verification

- `bun run test src/core/sync/saved-index.test.ts` — the new cases **fail** (Red).
