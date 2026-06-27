# Task 007: TweetRecord extraction + findAuthor impl (Green)

**depends-on**: task-006-record-extraction-test

## Description
Implement the bodies of the `TweetRecord` extraction module so the Red test from task 006 passes. Define the `TweetRecord` and `MediaRef` Effect `Schema` shapes per spec §6.1, and fill in `tweetRecordFromNode` to normalize one visited tweet node into an immutable record — populating every §6.1 field from its verified JSON path (with the `rest_id`→`legacy.id_str` and `conversation_id_str`→`tweetId` fallbacks), resolving the author through the existing `findAuthor` (already living in `adapters/x/walk.ts` from task 003) so the outer author's name/userId can never leak from a quoted tweet, and joining the link/card and media data already produced by the shared traversal (no re-walk, no re-resolution of media identity).
- Explicitly EXPORT a runtime Effect `Schema` named `TweetRecord` from `src/core/capture/record.ts` (not only the `TweetRecordShape` TypeScript interface), because the `CaptureTweets` message schema (tasks 016/017) imports the runtime `TweetRecord` Schema from here: `export const TweetRecord = Schema.Struct({...})` and `export type TweetRecord = typeof TweetRecord.Type`.

## Execution Context
**Task Number**: 007 of 30
**Phase**: Core
**Prerequisites**: Task 006 (Red) has created `src/core/capture/record.ts` with exported type + signature stubs whose bodies `throw new Error('not implemented')`, plus `src/core/capture/record.test.ts` mapping the scenario and currently FAILING on an assertion. Tasks 003 (`forEachTweetNode` + `findAuthor` in `adapters/x/walk.ts`) and 005 (`card.ts` link/card helpers) are Green. Fixtures from task 001 are present.

## BDD Scenario
```gherkin
Scenario: a tweet node becomes a normalized TweetRecord
  Given a tweet result node from a fixture
  When tweetRecordFromNode builds a record
  Then all §6.1 fields are populated and the OUTER author's name/userId never leak from a quoted tweet
```
**Spec Source**: docs/superpowers/specs/2026-06-27-tweet-harvest-capture-design.md (§6.1)

## Files to Modify/Create
- Modify: `src/core/capture/record.ts` — implement bodies; define the `TweetRecord`/`MediaRef` Effect `Schema` shapes (and the `Link`/author shapes per §6.1/§6.3).
- Note: `findAuthor` already lives in `src/core/adapters/x/walk.ts` (task 003); reuse it — do **not** re-implement author resolution or re-walk the node.
- Note: link/card joining helpers already live in `src/core/capture/card.ts` (task 005); reuse them.

## Contracts (signatures/types ONLY — no bodies)
```ts
// Implement signatures from task 006 (already declared in src/core/capture/record.ts).
// MUST export the RUNTIME Effect Schema (not only the TweetRecordShape TS interface):
//   export const TweetRecord = Schema.Struct({...})   // tasks 016/017 import this runtime Schema from here
//   export type TweetRecord = typeof TweetRecord.Type
// Reused, NOT redefined here:
//   - findAuthor(node): { handle: string; name?: string; userId?: string }   // src/core/adapters/x/walk.ts (task 003)
//   - expandText / linksFromEntities / cardMeta                              // src/core/capture/card.ts (task 005)
```

## Steps
1. Confirm the failing test from task 006 (`src/core/capture/record.test.ts`) and the §6.1 field table are the contract being satisfied; do not add fields or change exported signatures beyond those already declared in the task 006 stub.
   - **Verification**: `bunx vitest run src/core/capture/record.test.ts` fails on an assertion (Red), and the exported names/signatures in `record.ts` match those the test imports.
2. Define the `TweetRecord` and `MediaRef` Effect `Schema` structs (plus the `Link` and author sub-shapes) per spec §6.1 — `MediaRef` keeping only `id/type/url/ext/index/width?/height?` carried from the shared traversal's resolved media (ADR-0016 identity, no re-resolution).
   - **Verification**: `bun run check` typechecks the new schema definitions without errors.
3. Implement the body of `tweetRecordFromNode` so it populates every §6.1 field from its verified path: `tweetId` (`rest_id`→`legacy.id_str`), `conversationId` (→ `tweetId` fallback), `inReplyToTweetId?`/`inReplyToHandle?`, `author` via `findAuthor`, `text` (expanded) + `rawText`, `createdAt?`, `lang?`, `metrics` (incl. `views.count`), `links` (entities joined with card), `media` (from the visit's resolved media), `mentions`, `hashtags`, `quotedTweetId?`, `retweetOf?`, `source`/`sourceRank`, `capturedAt` (clock passed in).
   - **Verification**: the assertions in `record.test.ts` for field population pass.
4. Ensure author resolution delegates to the imported `findAuthor`, which prunes `NESTED_TWEET_KEYS` once and reads `screen_name`/`name`/`rest_id` from the same stopped-at `core.user_results.result` subtree, so a quoted tweet's `name`/`userId` cannot leak into the outer record.
   - **Verification**: the outer-quotes-inner assertion in `record.test.ts` passes (outer author's `name`/`userId` returned; inner never leaks).
5. Run the paired test, then the full coverage gate.
   - **Verification**: `bunx vitest run src/core/capture/record.test.ts` passes (Green); `bun run test:coverage` is green with `src/core/capture/record.ts` fully covered.

## Verification Commands
```bash
bunx vitest run src/core/capture/record.test.ts   # MUST PASS (Green)
bun run test:coverage
```

## Success Criteria
- The task 006 scenario passes: `tweetRecordFromNode` populates all §6.1 fields, and the outer author's `name`/`userId` never leak from a quoted tweet.
- `TweetRecord`/`MediaRef` (and `Link`/author) Effect `Schema` shapes match spec §6.1; `MediaRef` carries only `id/type/url/ext/index/width?/height?` and uses the shared traversal's resolved media (no re-walk, ADR-0016 identity preserved).
- A runtime Effect `Schema` named `TweetRecord` is EXPORTED from `src/core/capture/record.ts` (not only the `TweetRecordShape` TS interface), via `export const TweetRecord = Schema.Struct({...})` and `export type TweetRecord = typeof TweetRecord.Type`, so the `CaptureTweets` message schema (tasks 016/017) can import the runtime Schema from here.
- Author resolution reuses `findAuthor` from `adapters/x/walk.ts` rather than re-implementing it.
- `bun run test:coverage` passes with 100% coverage of `src/core/capture/record.ts` (the `src/core` + `src/lib` gate stays green).
