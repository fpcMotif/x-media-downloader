# Task 001 (test): Removal tracker state machine test (Red)

- **Type:** test
- **depends-on:** []
- **Files:** `src/core/removal.test.ts` (new)

Write failing unit tests for the pure removal tracker. No DOM, no chrome APIs — plain reducer tests. Mirror the test style of `src/core/launcher.test.ts` / `src/core/badge.test.ts`. The prototype `src/core/removal.prototype.ts` is the validated reference for expected behavior (do not import it).

## Contract under test (signatures only — implemented in 001-impl)

```ts
export type RemovalEvent =
  | { kind: 'arm'; tweetId: string; total: number }
  | { kind: 'itemComplete'; tweetId: string }
  | { kind: 'itemFailed'; tweetId: string }
export type TweetTally = { readonly total: number; readonly completed: number; readonly failed: number; readonly fired: boolean }
export type RemovalState = ReadonlyMap<string, TweetTally>
export type Decision = { kind: 'remove'; tweetId: string } | null
export function reduce(state: RemovalState, ev: RemovalEvent): { state: RemovalState; decision: Decision }
export const emptyRemovalState: RemovalState
```

## BDD Scenario

```gherkin
Scenario: Single-media post fully saved emits remove
  Given a tweet "t1" armed with total 1
  When its 1 item confirms complete
  Then the tracker emits remove(t1) exactly once

Scenario: Multi-media post partially saved emits nothing
  Given a tweet "t1" armed with total 4
  When 3 of its items confirm complete
  Then the tracker emits no decision and "t1" stays pending

Scenario: Multi-media post fully saved emits remove exactly once
  Given a tweet "t1" armed with total 4
  When all 4 items confirm complete
  And a stray extra complete arrives afterward
  Then the tracker emits remove(t1) exactly once and never again

Scenario: Any failed item keeps the post
  Given a tweet "t1" armed with total 4
  When 3 items confirm complete and 1 item fails
  And the failure may arrive before or after the completions
  Then the tracker never emits remove(t1)

Scenario: Events for an un-armed tweet are ignored
  Given no tweet has been armed
  When a complete event arrives for "t_ghost"
  Then the tracker emits no decision and tracks nothing
```

## Steps (what, not how)

- Add a small helper that folds an array of events through `reduce`, collecting every non-null decision, so each scenario asserts the decision list.
- Cover: N=1 remove; N=4 partial (no decision); N=4 full → exactly one `remove` then a trailing `itemComplete` yields no further decision; failure-keeps with the failing event placed both first and last; un-armed `itemComplete` produces empty state and no decision.

## Verification

- `bun run test src/core/removal.test.ts` — tests exist and **fail** (module not yet implemented). Red is correct here.
