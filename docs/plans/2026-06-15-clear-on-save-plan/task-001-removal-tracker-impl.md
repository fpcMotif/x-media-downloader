# Task 001 (impl): Removal tracker state machine impl (Green)

- **Type:** impl
- **depends-on:** ["001-test"]
- **Files:** `src/core/removal.ts` (new); delete `src/core/removal.prototype.ts` (absorbed)

Implement the pure removal tracker so the 001-test suite passes. The reducer logic was prototype-validated in `src/core/removal.prototype.ts` — port the pure core (`RemovalEvent`, `TweetTally`, `RemovalState`, `Decision`, `reduce`, `emptyRemovalState`) and **delete the prototype file** when done (it is throwaway; its verdict is captured in design spec §9).

## Contract (signatures only — no implementation body in this plan)

```ts
export type RemovalEvent =
  | { kind: 'arm'; tweetId: string; total: number }
  | { kind: 'itemComplete'; tweetId: string }
  | { kind: 'itemFailed'; tweetId: string }
export type TweetTally = { readonly total: number; readonly completed: number; readonly failed: number; readonly fired: boolean }
export type RemovalState = ReadonlyMap<string, TweetTally>
export type Decision = { kind: 'remove'; tweetId: string } | null
export const emptyRemovalState: RemovalState
export function reduce(state: RemovalState, ev: RemovalEvent): { state: RemovalState; decision: Decision }
```

## Behavior contract (from spec §3.1 / §4)

- `arm` is idempotent: an already-tracked tweetId is never re-armed/reset.
- `itemComplete`/`itemFailed` for an un-armed tweetId are ignored.
- Emit `{ kind:'remove', tweetId }` exactly once, only when `completed === total && failed === 0`, then latch (`fired`) so no re-emit.
- Any `failed > 0` keeps the post forever (remove impossible).
- Pure: returns a new state map; never mutates input; no DOM/chrome/Date/random.

## BDD Scenario

```gherkin
Scenario: Multi-media post fully saved emits remove exactly once
  Given a tweet "t1" armed with total 4
  When all 4 items confirm complete
  And a stray extra complete arrives afterward
  Then the tracker emits remove(t1) exactly once and never again

Scenario: Any failed item keeps the post
  Given a tweet "t1" armed with total 4
  When 3 items confirm complete and 1 item fails
  Then the tracker never emits remove(t1)
```

(The full set of 001 scenarios in [bdd-specs.md](./bdd-specs.md) must all pass.)

## Steps (what, not how)

- Create `src/core/removal.ts` with the contract above; behavior per the prototype reducer.
- Remove `src/core/removal.prototype.ts`.

## Verification

- `bun run test src/core/removal.test.ts` — all 001-test scenarios **pass** (Green).
- `git status` shows `src/core/removal.prototype.ts` deleted and `src/core/removal.ts` added.
