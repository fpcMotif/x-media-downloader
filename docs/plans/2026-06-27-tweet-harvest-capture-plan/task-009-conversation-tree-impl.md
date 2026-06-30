# Task 009: Conversation tree buildTree impl (Green)

**depends-on**: task-008-conversation-tree-test

## Description
Implement the bodies of the `buildTree` function (and any private helpers) in the conversation-tree module so it reconstructs reply trees purely from `inReplyToTweetId` links: group captured records by `conversationId`, build a `tweetId → node` map, attach each node under its in-reply-to parent only when that parent was captured in the same group, surface true roots and orphan replies as roots, order siblings deterministically, and defend against cycles so the traversal stays total. The `conversationthread` module nesting from the raw response must play no part — parentage comes solely from `in_reply_to_status_id_str`. This is the Green half of the task-008 Red test: turn the failing assertions into passing ones without changing the test.

## Execution Context
**Task Number**: 009 of 30
**Phase**: Core
**Prerequisites**: Task 008 (Red) has landed: `src/core/capture/tree.ts` exists with exported `ConversationTree`/`TweetNode` types and a `buildTree` signature whose body currently `throw new Error("not implemented")`, and `src/core/capture/tree.test.ts` encodes the BDD scenario and is currently failing on an assertion. The `TweetRecord` type (with `tweetId`, `conversationId`, `inReplyToTweetId?`, `createdAt?`) from `record.ts` is available for `buildTree`'s input.

## BDD Scenario
```gherkin
Scenario: buildTree reconstructs reply trees from in_reply_to links
  Given records for root R, reply A and grandchild reply B
  When buildTree runs
  Then parentage comes SOLELY from in_reply_to_status_id_str; conversationthread module nesting is ignored; cycles are defended
```
**Spec Source**: docs/superpowers/specs/2026-06-27-tweet-harvest-capture-design.md (§6.2)

## Files to Modify/Create
- Modify: `src/core/capture/tree.ts` (implement bodies)

## Contracts (signatures/types ONLY — no bodies)
```ts
// Implement signatures from task 008.
//
// No new exports. The types and signature below already exist in tree.ts
// from task 008 (Red); task 009 only fills their bodies.
//
//   export type TweetNode = TweetRecord & { children: TweetNode[] }
//   export interface ConversationTree { conversationId: string; roots: TweetNode[] }
//   export function buildTree(records: readonly TweetRecord[]): ConversationTree[]
```

## Steps
1. Re-read the task-008 test `src/core/capture/tree.test.ts` and the §6.2 spec rules (group by `conversationId`; link under `inReplyToTweetId` iff parent is in the group; roots = true roots + orphan replies; stable order `createdAt` then `tweetId`; cycle-defended via a visited set; module nesting ignored) so the implementation matches the scenario exactly.
   - Verification: the test names/assertions map 1:1 to the §6.2 behaviors (root R → child A → grandchild B; an orphan reply surfaces as an additional root; a constructed cycle terminates).
2. In `src/core/capture/tree.ts`, replace the `throw new Error("not implemented")` body of `buildTree` (and add any private, non-exported helpers needed) so parentage is derived solely from `inReplyToTweetId`, supports multi-level chains (root → A → B), surfaces true roots plus orphan replies as roots, orders siblings by `createdAt` then `tweetId`, and uses a visited set so a cyclic `inReplyToTweetId` reference cannot recurse forever. Do not read or honor any `conversationthread` nesting.
   - Verification: `bunx tsgo --noEmit` (or `bun run check`) type-checks; no new exported symbols beyond those defined in task 008.
3. Run the paired test and confirm the previously failing assertions now pass.
   - Verification: `bunx vitest run src/core/capture/tree.test.ts` is green, including the grandchild (B), orphan-root, and cycle-defense cases.

## Verification Commands
```bash
bunx vitest run src/core/capture/tree.test.ts   # MUST PASS (Green)
bun run test:coverage
```

## Success Criteria
- `src/core/capture/tree.test.ts` passes, including the grandchild reply B (multi-level chain), the orphan-reply-as-root case, and the cycle-defense case from the scenario.
- `buildTree` derives parentage SOLELY from `inReplyToTweetId`; no `conversationthread` module nesting is consulted.
- Siblings are emitted in stable order (`createdAt` then `tweetId`); traversal is total (terminates on cyclic input).
- No new exported symbols beyond the task-008 contracts; the task-008 test is unchanged.
- `bun run test:coverage` stays green at 100% over `src/core` (the new `tree.ts` bodies are fully covered).
