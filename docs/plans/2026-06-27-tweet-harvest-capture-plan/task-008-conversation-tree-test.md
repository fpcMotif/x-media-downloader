# Task 008: Conversation tree buildTree test (Red)

**depends-on**: task-007-record-extraction-impl

## Description
Author the failing unit test that pins down the behaviour of `buildTree`, the pure function that reconstructs conversation reply trees from extracted tweet records. The test must specify that records sharing one `conversationId` are reassembled into a `ConversationTree` whose nesting follows the `in_reply_to` links (including a real multi-level grandchild reply), that orphan replies whose parent was not captured surface honestly as additional roots, that degenerate inputs (missing root, self-thread, cycle) are handled without throwing, and that roots and children come back in a stable `createdAt`-then-`tweetId` order. Create the `tree.ts` module alongside it with exported type and signature stubs only, so the test compiles but fails on its assertions.

## Execution Context
**Task Number**: 008 of 30
**Phase**: Core
**Prerequisites**: Task 007 (record extraction impl) is complete, so `TweetRecordShape` is exported from `src/core/capture/record.ts` and can be imported by the tree module and its test. Vitest is configured and runnable via `bunx vitest`.

## BDD Scenario
```gherkin
Scenario: buildTree reconstructs reply trees from in_reply_to links
  Given records for root R, reply A (in_reply_to R) and reply B (in_reply_to A) sharing one conversationId
  When buildTree runs
  Then it returns one ConversationTree whose root R has child A whose child is B (B is a grandchild)
  And an orphan reply whose parent is absent surfaces as an additional root
  And a missing root, a self-thread, and a cycle are all handled without throwing
  And roots/children are ordered by createdAt then tweetId
```
**Spec Source**: docs/superpowers/specs/2026-06-27-tweet-harvest-capture-design.md (§6.2)

## Files to Modify/Create
- Create: src/core/capture/tree.test.ts
- Create (stubs only): src/core/capture/tree.ts

## Contracts (signatures/types ONLY — no bodies)
```ts
import type { TweetRecordShape } from './record'
export type TweetNode = TweetRecordShape & { children: TweetNode[] }
export type ConversationTree = { conversationId: string; roots: TweetNode[] }
export function buildTree(records: ReadonlyArray<TweetRecordShape>): ConversationTree[]
```

## Steps
1. Confirm the scenario and its mapping to the contract: the records-in / `ConversationTree[]`-out shape, the grandchild nesting requirement (root R → child A → grandchild B), the orphan-as-additional-root rule, the total/no-throw handling of missing-root / self-thread / cycle inputs, and the stable `createdAt`-then-`tweetId` ordering of `roots` and `children`.
   - Verification: re-read §6.2 of the spec and verify each Then/And clause maps to a behaviour expressible against the given `buildTree` signature only.
2. Create `src/core/capture/tree.ts` with the exported types and function signature from the Contracts block verbatim. The `buildTree` body must be a stub that does `throw new Error("not implemented")` so the module type-checks and the test imports/compiles.
   - Verification: `bunx tsc --noEmit` (or the project type-check) reports no errors for `tree.ts`; the stub exports `TweetNode`, `ConversationTree`, and `buildTree`.
3. Create `src/core/capture/tree.test.ts`. Build `TweetRecordShape` fixtures (use existing record fixtures/factories from Task 007 where available) sharing one `conversationId` for root R, reply A (`inReplyToTweetId` = R), and reply B (`inReplyToTweetId` = A), plus an orphan reply whose `inReplyToTweetId` points at an absent parent, and additional degenerate fixtures: a group with a missing root, a self-thread (a record whose `inReplyToTweetId` equals its own `tweetId`), and a two-record cycle. Write `it`/`test` blocks that map the Given/When/Then: assert exactly one `ConversationTree` for the shared conversation, assert R's `children` contains A and A's `children` contains B (the grandchild), assert the orphan appears as an additional entry in `roots`, assert `buildTree` does not throw for the missing-root / self-thread / cycle inputs, and assert `roots` and `children` are ordered by `createdAt` then `tweetId`.
   - Verification: the test file imports `buildTree`, `TweetNode`, `ConversationTree`, and `TweetRecordShape`; it compiles with no unresolved references.
4. Run the test and confirm it fails on an assertion (the `throw new Error("not implemented")` stub), not on a compile or import error.
   - Verification: `bunx vitest run src/core/capture/tree.test.ts` exits non-zero with failing assertions/thrown "not implemented" from `buildTree`, and shows no TypeScript or module-resolution errors.

## Verification Commands
```bash
bunx vitest run src/core/capture/tree.test.ts   # MUST FAIL (Red)
```

## Success Criteria
- `src/core/capture/tree.ts` exports `TweetNode`, `ConversationTree`, and `buildTree` with signatures matching the Contracts block exactly; the body is a `throw new Error("not implemented")` stub.
- `src/core/capture/tree.test.ts` encodes every Given/When/Then clause of the scenario: grandchild nesting (R → A → B), orphan-as-additional-root, no-throw on missing-root / self-thread / cycle, and `createdAt`-then-`tweetId` ordering of roots and children.
- `bunx vitest run src/core/capture/tree.test.ts` FAILS on assertions (not on compile/import), establishing a valid Red for the paired Green impl task to satisfy.
- The test compiles cleanly under the project type-check, keeping `src/core` ready for the 100% unit coverage gate once the impl lands.
