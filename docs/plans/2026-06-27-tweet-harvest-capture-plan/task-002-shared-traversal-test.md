# Task 002: Shared tweet-node traversal test (Red)

**depends-on**: task-001-capture-test-fixtures

## Description
Author the failing unit test that pins the behavior of the shared `forEachTweetNode` traversal primitive for the X GraphQL adapter, plus the `findAuthor` helper and the exported `NESTED_TWEET_KEYS` set. The test must prove that a single depth-first walk of a captured TweetDetail thread fixture yields exactly one visit per tweet node carrying `{ node, tweetId, handle, author, mediaRaw }`, that `TweetWithVisibilityResults` is unwrapped to its `.tweet` and `TweetTombstone` nodes are skipped, that quoted/retweeted tweets surface as their own separate visits, and that `detectFromJson` — refactored to consume this primitive — still returns the identical `MediaItem[]` it returns today. Create the module with exported type and signature stubs only (no logic) so the test compiles and fails on an assertion rather than an import error.

## Execution Context
**Task Number**: 002 of 30
**Phase**: Foundation
**Prerequisites**: Task 001 (capture test fixtures) has landed the new TweetDetail thread fixture and supporting capture fixtures under the project's fixture directory, so this test can load a realistic GraphQL response containing a visibility wrapper, a tombstone, and a quoted/retweeted tweet.

## BDD Scenario
```gherkin
Scenario: forEachTweetNode visits every tweet node once with one identity authority
  Given a captured GraphQL response (TweetDetail thread fixture)
  When forEachTweetNode walks it
  Then it yields one visit per tweet node with { node, tweetId, handle, author, mediaRaw }
  And it unwraps TweetWithVisibilityResults (.tweet) and SKIPS TweetTombstone
  And a quoted/retweeted tweet is yielded as its OWN separate visit
  And it descends into conversationthread items[] yielding the THREE module-nested tweets (root, reply-A, grandchild-B)
  And detectFromJson (refactored onto it) returns the SAME MediaItem[] as before
```
**Spec Source**: docs/superpowers/specs/2026-06-27-tweet-harvest-capture-design.md (§6.0)

## Files to Modify/Create
- Create: `src/core/adapters/x/walk.test.ts`
- Create (stubs only, this task): `src/core/adapters/x/walk.ts`

## Contracts (signatures/types ONLY — no bodies)
```ts
export type Author = { handle: string; name?: string; userId?: string }
export function forEachTweetNode(json: unknown, visit: (n: { node: object; tweetId: string; handle: string; author: Author; mediaRaw: unknown[] }) => void): void
export function findAuthor(node: unknown): Author
export const NESTED_TWEET_KEYS: ReadonlySet<string>
```

## Steps
1. Confirm the scenario and its spec source (§6.0): `forEachTweetNode` is a single shared depth-first traversal that unwraps `TweetWithVisibilityResults` (`.tweet`), skips `TweetTombstone`, derives `tweetId` (`rest_id` → `legacy.id_str`), resolves the author via `findAuthor`, and yields nested quoted/retweeted tweets as their own visits; `detectFromJson` is refactored to consume it without changing its `MediaItem[]` output.
   - Verification: Re-read §6.0 of the spec and the `walk.test.ts` line in §13; confirm the four Then/And clauses map to (one visit per node), (unwrap + tombstone skip), (separate nested visit), (detector output unchanged).
2. Create `src/core/adapters/x/walk.ts` exporting the contracts above as compile-only stubs: define `type Author`, and stub `forEachTweetNode` and `findAuthor` with bodies that `throw new Error("not implemented")`, plus `export const NESTED_TWEET_KEYS: ReadonlySet<string>` initialized to an empty set so the module typechecks and imports succeed.
   - Verification: `bunx tsc --noEmit` (or the repo's typecheck) resolves the imports; the module exports `forEachTweetNode`, `findAuthor`, `Author`, and `NESTED_TWEET_KEYS`.
3. Write `src/core/adapters/x/walk.test.ts` mapping the scenario:
   - Given: load the captured TweetDetail thread fixture from Task 001 (the response that contains a `TweetWithVisibilityResults` wrapper, a `TweetTombstone` entry, and a quoted/retweeted tweet).
   - When: call `forEachTweetNode(fixture, visit)`, collecting each visit object into an array.
   - Then: assert one visit per real tweet node, each visit shaped `{ node, tweetId, handle, author, mediaRaw }` with `tweetId` and `handle` populated and `author` matching the `{ handle, name?, userId? }` shape.
   - And: assert the visibility-wrapped node is yielded as its unwrapped inner `.tweet` (its derived `tweetId` is the inner tweet's), and that no visit corresponds to the `TweetTombstone` entry.
   - And: assert the quoted/retweeted tweet appears as its own separate visit with its own distinct `tweetId`, alongside the outer tweet's visit.
   - And: assert `forEachTweetNode` over `tweet-detail-thread.json` yields the THREE module-nested tweets authored inside the `conversationthread` `items[]` (the root → reply-A → grandchild-B chain) — assert the visit COUNT is three and that the yielded `tweetId`s match the root, reply-A, and grandchild-B ids. This guards that `forEachTweetNode` descends into `conversationthread` `items[]` (a traversal that fails to descend would yield zero and otherwise pass), which is the fixture's reason for existing.
   - And: assert `detectFromJson(fixture)` (imported from `src/core/adapters/x/index.ts`) deep-equals the current/expected `MediaItem[]` for the same fixture (snapshot the existing detector output so a behavior change would break this assertion).
   - Verification: the test file references the real exported names and the Task 001 fixture path; no placeholder identifiers remain.
4. Run the test and confirm it FAILS on an assertion (the stub `throw new Error("not implemented")` from `forEachTweetNode` surfaces as a failing expectation when the collected-visits array is asserted), not on a compile or import error.
   - Verification: the failure output names `walk.test.ts` assertions / the "not implemented" throw, and the module under test imported cleanly.

## Verification Commands
```bash
bunx vitest run src/core/adapters/x/walk.test.ts   # MUST FAIL on assertion (Red)
```

## Success Criteria
- `src/core/adapters/x/walk.ts` exists with stub-only exports (`Author`, `forEachTweetNode`, `findAuthor`, `NESTED_TWEET_KEYS`) whose function bodies throw `"not implemented"`.
- `src/core/adapters/x/walk.test.ts` encodes every Given/When/Then clause of the scenario: one visit per tweet node with the `{ node, tweetId, handle, author, mediaRaw }` shape, visibility-wrapper unwrap, tombstone skip, separate nested quote/retweet visit, and `detectFromJson` output equivalence.
- `bunx vitest run src/core/adapters/x/walk.test.ts` fails on an assertion (Red), proving the test exercises real behavior rather than crashing on a missing import or type error.
- The test compiles under the repo's typecheck and is positioned within `src/core` so it falls under the 100% coverage gate that the paired Green task must satisfy.
