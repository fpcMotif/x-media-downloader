# Task 018: Capture pipeline e2e (harvest -> store -> export)

**depends-on**: task-011-harvest-breadth-impl, task-013-store-merge-impl, task-015-export-converters-impl

## Description
Add a pure end-to-end integration test that exercises the whole capture pipeline over real fixtures: harvest a rich `TweetDetail` thread into `TweetRecord[]`, harvest the same tweet a second time as a thin timeline sighting, merge every record into the store via the §6.4 rule, build the conversation tree, and export it. The test asserts the central feature promise — the rich thread wins over the thin sighting in the export, and a quoted tweet's text is inlined — by composing the already-implemented pure functions (`harvestTweets`, `mergeRecord`, `buildTree`, `toMarkdown`/`toJsonl`) without any I/O. This test introduces no new production code; it is a verification harness over the units built by its prerequisites.

## Execution Context
**Task Number**: 018 of 30
**Phase**: Integration
**Prerequisites**: `harvestTweets` (task-011), `mergeRecord` + store selectors (task-013), and the export converters `toMarkdown`/`toJsonl`/`buildTree` (task-015) are all implemented and green. The fixtures for a rich `TweetDetail` thread (multi-level, with a quoted tweet) and a thin timeline response that re-serves one of those tweets must exist under the capture fixtures directory (established in the earlier fixture/harvest tasks). This test only imports and composes those existing modules.

## BDD Scenario
```gherkin
Scenario: end-to-end pure pipeline preserves rich data
  Given a TweetDetail thread fixture harvested, then the same tweet re-harvested thin from a timeline fixture
  When all records are merged into the store and a thread is exported
  Then the exported Markdown/JSON reflects the RICH thread (not the thin sighting)
  And a quoted tweet's text is inlined in the export
```
**Spec Source**: docs/superpowers/specs/2026-06-27-tweet-harvest-capture-design.md (§5)

## Files to Modify/Create
- Create: `src/core/capture/capture-pipeline.e2e.test.ts`

## Contracts (signatures/types ONLY — no bodies)
```ts
// Test-only: composes harvestTweets + mergeRecord + buildTree + toMarkdown/toJsonl over fixtures.
```

## Steps
1. Re-read the BDD scenario and confirm the data flow it pins: harvest rich → harvest thin → merge all → build tree → export, with two distinct assertions (rich-wins and quote-inlining).
   - Verification: the scenario's Given/When/Then maps onto imports of `harvestTweets`, `mergeRecord`, `buildTree`, and `toMarkdown`/`toJsonl` only — no new module is introduced.
2. Confirm the prerequisite modules and their exported signatures are present so the test compiles: `harvestTweets(json, opts)` from `harvest.ts`, `mergeRecord(existing, incoming)` from `store.ts`, `buildTree(records)` from `tree.ts`, and `toMarkdown(tree, allRecords)` / `toJsonl(records)` from `export.ts`. Confirm the rich `TweetDetail` fixture (multi-level thread containing a quoted tweet) and the thin timeline fixture (re-serving one of those tweets) exist under the capture fixtures directory.
   - Verification: `bunx tsc --noEmit` reports no missing-import or missing-symbol errors for the four modules and the fixtures resolve as JSON imports.
3. Write the test mapping Given/When/Then:
   - Given: call `harvestTweets(richThreadFixture, { source: 'tweetDetail', includeTextOnly: false, capturedAt: <t1> })` to get the rich records, then call `harvestTweets(thinTimelineFixture, { source: 'timeline', includeTextOnly: false, capturedAt: <t2 > t1> })` to get the thin sighting of the same `tweetId`.
   - When: fold all records into an in-memory map keyed by `tweetId` using `mergeRecord` (read-merge-write per record), then take the merged record set, run `buildTree(records)`, select the target conversation tree, and produce both `toMarkdown(tree, records)` and `toJsonl(records)`.
   - Then (assertion A): the exported Markdown/JSONL for the re-served tweet carries the RICH thread's fields (e.g. the `TweetDetail` text/metrics with `sourceRank` 2), NOT the thin timeline sighting — proving the §6.4 merge protected the rich record despite the later `capturedAt`.
   - Then (assertion B): the Markdown contains the quoted tweet's text inlined where the outer tweet references it via `quotedTweetId`.
   - Verification: the test body references each pipeline stage exactly once and the two `expect` assertions encode rich-wins and quote-inlining.
4. Run the test and confirm it FAILS on an assertion (not on a compile/import error), proving the scenario is exercised end-to-end against the current implementations.
   - Verification: `bunx vitest run src/core/capture/capture-pipeline.e2e.test.ts` shows a failing `expect` (assertion message), with no `Cannot find module` / TS resolution errors. If all prerequisites are correct, this composition should pass — record any assertion-level failure as a real integration gap to feed back to task-011/013/015.

## Verification Commands
```bash
bunx vitest run src/core/capture/capture-pipeline.e2e.test.ts
bun run test:coverage
```

## Success Criteria
- `src/core/capture/capture-pipeline.e2e.test.ts` exists and composes `harvestTweets`, `mergeRecord`, `buildTree`, and `toMarkdown`/`toJsonl` over the rich `TweetDetail` and thin timeline fixtures with no I/O.
- The test encodes both Then clauses: the export reflects the RICH thread (not the thin sighting), and a quoted tweet's text is inlined.
- The test fails (if at all) on an assertion, never on a missing import or type error — it is a true integration exercise of the prerequisite units.
- `bunx vitest run src/core/capture/capture-pipeline.e2e.test.ts` passes once the pipeline is correct.
- `bun run test:coverage` stays green and the 100% gate over `src/core` is preserved.
