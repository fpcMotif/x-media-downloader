# Task 003: Shared traversal impl + detectFromJson refactor (Green)

**depends-on**: task-002-shared-traversal-test

## Description
Implement the bodies of the shared traversal primitive `forEachTweetNode` (and its supporting `findAuthor` author resolver) introduced as stubs in task 002, then refactor the existing `detectFromJson` to consume `forEachTweetNode` as its single source of tweet-node iteration and media-key identity. `forEachTweetNode` performs one depth-first walk of a captured X GraphQL response, unwrapping `TweetWithVisibilityResults`, skipping `TweetTombstone`, deriving each tweet's id and author, and yielding exactly one visit per tweet node — including quoted/retweeted tweets as their own separate visits. The refactor must be behavior-preserving: `detectFromJson` keeps its existing public signature and returns the identical `MediaItem[]` it does today, so the existing `xadapter.test.ts` continues to pass while the new `walk.test.ts` turns green.

## Execution Context
**Task Number**: 003 of 30
**Phase**: Foundation
**Prerequisites**: Task 002 has created `src/core/adapters/x/walk.ts` with exported type and signature stubs (`forEachTweetNode`, `findAuthor`, `NESTED_TWEET_KEYS`) whose bodies `throw new Error("not implemented")`, plus a failing `walk.test.ts` mapping the scenario. The existing private `walk`/`findScreenName`/`NESTED_TWEET_KEYS` in `src/core/adapters/x/index.ts` and the current `detectFromJson` behavior are the baseline to preserve.

## BDD Scenario
```gherkin
Scenario: forEachTweetNode visits every tweet node once with one identity authority
  Given a captured GraphQL response (TweetDetail thread fixture)
  When forEachTweetNode walks it
  Then it yields one visit per tweet node with { node, tweetId, handle, author, mediaRaw }
  And it unwraps TweetWithVisibilityResults (.tweet) and SKIPS TweetTombstone
  And a quoted/retweeted tweet is yielded as its OWN separate visit
  And detectFromJson (refactored onto it) returns the SAME MediaItem[] as before (existing xadapter.test.ts stays green)
```
**Spec Source**: docs/superpowers/specs/2026-06-27-tweet-harvest-capture-design.md (§6.0)

## Files to Modify/Create
- Modify: `src/core/adapters/x/walk.ts` (implement bodies)
- Modify: `src/core/adapters/x/index.ts` (refactor `detectFromJson` to consume `forEachTweetNode`; relocate/export `walk`, `findAuthor`, `NESTED_TWEET_KEYS`)

## Contracts (signatures/types ONLY — no bodies)
```ts
// Implement the signatures from task 002. detectFromJson keeps its existing public signature & output.

// src/core/adapters/x/walk.ts (from task 002 — implement these bodies)
export function forEachTweetNode(
  json: unknown,
  visit: (n: { node: Obj; tweetId: string; handle: string; author: Author; mediaRaw: RawMedia[] }) => void,
): void

export function findAuthor(node: unknown): Author

export const NESTED_TWEET_KEYS: ReadonlySet<string>

// src/core/adapters/x/index.ts (public signature & output unchanged)
export function detectFromJson(json: unknown): MediaItem[]
```

## Steps
1. Implement `findAuthor` in `walk.ts` so it generalizes the private `findScreenName`: prune `NESTED_TWEET_KEYS` once and read `screen_name`, `name`, and `rest_id` from the same `core.user_results.result` subtree it stops at, returning the `Author` shape (`{ handle, name?, userId? }`) without letting a quoted tweet's author leak into the outer record.
   - Verification: the author-resolution assertions in `walk.test.ts` no longer hit `not implemented`.
2. Implement `forEachTweetNode` in `walk.ts` to perform one depth-first walk, unwrap `TweetWithVisibilityResults` via `.tweet`, skip `TweetTombstone`, derive `tweetId` from `rest_id` then `legacy.id_str`, resolve `author`/`handle` via `findAuthor`, collect `mediaRaw` from `legacy.extended_entities.media`, and emit exactly one `visit` per tweet node (quoted/retweeted tweets visited independently).
   - Verification: `walk.test.ts` Given/When/Then assertions for visit count, the `{ node, tweetId, handle, author, mediaRaw }` payload, unwrap/skip behavior, and separate nested-tweet visits now evaluate against real values.
3. In `index.ts`, relocate/export the shared primitives so `walk`, `findAuthor`, and `NESTED_TWEET_KEYS` come from `walk.ts`; remove the now-redundant module-private `findScreenName`/`NESTED_TWEET_KEYS` duplication, keeping a single identity authority.
   - Verification: `bunx vitest run src/core/adapters/x/walk.test.ts` shows the new module wired (no duplicate-symbol or unresolved-import errors).
4. Refactor `detectFromJson` in `index.ts` to build `MediaItem[]` by consuming `forEachTweetNode` (using its `tweetId`/`handle`/`mediaRaw`), preserving the existing tweetId-dedup and `resolveTweetMedia` output exactly so the public signature and result are unchanged.
   - Verification: `bunx vitest run src/core/adapters/x/xadapter.test.ts` stays fully green (behavior preserved).
5. Run both targeted suites together to confirm the Green transition, then run the full gate.
   - Verification: `walk.test.ts` and `xadapter.test.ts` both pass; `bun run test:coverage` is green with 100% on `src/core`.

## Verification Commands
```bash
bunx vitest run src/core/adapters/x/walk.test.ts src/core/adapters/x/xadapter.test.ts   # MUST PASS (Green)
bun run test:coverage
```

## Success Criteria
- `forEachTweetNode` yields exactly one visit per tweet node carrying `{ node, tweetId, handle, author, mediaRaw }`, unwraps `TweetWithVisibilityResults` (`.tweet`), skips `TweetTombstone`, and emits quoted/retweeted tweets as their own separate visits — all scenario assertions in `walk.test.ts` pass.
- `findAuthor` reads handle, name, and userId from one pruned `core.user_results.result` subtree with no nested-tweet author leakage.
- `detectFromJson` keeps its existing public signature and returns the identical `MediaItem[]`; existing `xadapter.test.ts` stays green with one shared walk and one identity authority (no second traversal, no re-implemented media-key identity).
- `bun run test:coverage` passes the 100% `src/core` coverage/build gate.
