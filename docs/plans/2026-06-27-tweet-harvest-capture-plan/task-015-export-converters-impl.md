# Task 015: Export converters impl (Green)

**depends-on**: task-014-export-converters-test

## Description
Implement the bodies of the pure export converters declared in task 014 so they produce the bulk JSONL artifact, the per-thread nested JSON, and the threaded depth-indented Markdown described in the spec, including cross-conversation resolution that inlines quoted-tweet text where a `quotedTweetId` is referenced. The `toRows` projection seam plus its `Row` type remain defined as the projection seam and ship a trivial, fully-covered real body (each record mapped to a `Row { tweetId, conversationId, handle, text, links }` with `links` joined), but no Notion/Sheets exporter is built. This is the Green half of the pair: make the failing `export.test.ts` pass without changing the test or the public signatures.

## Execution Context
**Task Number**: 015 of 30
**Phase**: Core
**Prerequisites**: Task 014 (Red) has created `src/core/capture/export.ts` with exported type and function signature stubs that throw `new Error("not implemented")`, and `src/core/capture/export.test.ts` asserting JSONL line shape, nested tree JSON, Markdown indentation/links, and quoted-text inlining; that test currently fails on an assertion. The `ConversationTree`, `TweetRecord`, and related types from the earlier record/tree tasks are available to import.

## BDD Scenario
```gherkin
Scenario: records export to JSONL, nested JSON, and threaded Markdown
  Given a tree + full record set
  When converters run
  Then output matches the scenario incl. quoted-text inlining; toRows seam exists but no exporter is built
```
**Spec Source**: docs/superpowers/specs/2026-06-27-tweet-harvest-capture-design.md (§10)

## Files to Modify/Create
- Modify: src/core/capture/export.ts (implement bodies)

## Contracts (signatures/types ONLY — no bodies)
```ts
// Implement signatures from task 014.
```

## Steps
1. Re-read `src/core/capture/export.test.ts` and `src/core/capture/export.ts` to confirm the exact signatures and assertions from task 014; do not alter the test or any signature.
   - Verification: `bunx vitest run src/core/capture/export.test.ts` shows the test failing on an assertion (Red), confirming the starting point.
2. Implement `toJsonl(records)` to emit one `TweetRecord` per line carrying `conversationId` + `inReplyToTweetId`, matching the JSONL line shape asserted by the test.
   - Verification: the JSONL line-shape assertion in `export.test.ts` passes when run in isolation or via the focused run.
3. Implement `toTreeJson(tree, allRecords)` to serialize one `ConversationTree` as pretty nested JSON, resolving `quotedTweetId` against `allRecords` so referenced quoted text is inlined (bare reference when unresolved).
   - Verification: the tree-JSON and quoted-inlining assertions in `export.test.ts` pass.
4. Implement `toMarkdown(tree, allRecords)` to render threaded, depth-indented replies with per-tweet author + timestamp, expanded text, link bullets (`title — url` when titled), and `[media: type ×N]` lines, inlining resolved quoted text via `allRecords`.
   - Verification: the Markdown indentation, link-bullet, and quoted-text assertions in `export.test.ts` pass.
5. Implement `toRows(records)` as a trivial, fully-covered real body — map each `TweetRecord` to a `Row { tweetId, conversationId, handle, text, links }`, joining `links` into a single string — so the 100% coverage gate passes. This is just the projection seam: introduce NO Notion/Sheets exporter or delivery code.
   - Verification: the test's `toRows` projection assertion passes, `export.ts` reports 100% coverage with `toRows` fully exercised, and no new exporter files appear.

## Verification Commands
```bash
bunx vitest run src/core/capture/export.test.ts   # MUST PASS (Green)
bun run test:coverage
```

## Success Criteria
- `bunx vitest run src/core/capture/export.test.ts` passes, covering JSONL line shape, nested tree JSON, Markdown indentation/links, and quoted-text inlining per the scenario.
- Quoted-tweet text is inlined in `toMarkdown`/`toTreeJson` via cross-conversation `quotedTweetId` resolution; unresolved references render as a bare reference.
- The `toRows` projection seam and `Row` type remain defined with a trivial, fully-covered real body (each record mapped to `Row { tweetId, conversationId, handle, text, links }` with `links` joined) and no exporter built (no Notion/Sheets delivery added).
- Public signatures from task 014 are unchanged and the test file is untouched.
- `bun run test:coverage` passes the 100% unit gate over `src/core` (export.ts fully covered).
