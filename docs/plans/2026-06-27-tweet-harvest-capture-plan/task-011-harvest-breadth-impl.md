# Task 011: Harvest breadth rule + assembly impl (Green)

**depends-on**: task-010-harvest-breadth-test

## Description
Implement the bodies of the `harvestTweets` module so that it consumes the single shared traversal (`forEachTweetNode`) and, for each visited tweet node, builds a candidate `TweetRecord` (via `tweetRecordFromNode`) and assembles its links/card metadata (via the `card.ts` helpers), keeping only the tweets selected by the §7 breadth rule — over one shared walk with no second traversal and no re-implementation of media-key identity. This turns the failing test from task 010 green while preserving the existing detector behavior.

## Execution Context
**Task Number**: 011 of 30
**Phase**: Core
**Prerequisites**: Task 010 (Red) has created the `harvestTweets` type + signature stubs that throw `not implemented` and a failing `harvest.test.ts` asserting the breadth rule over one shared walk. The shared primitive `forEachTweetNode` (walk.ts), `tweetRecordFromNode` (record.ts), and the `card.ts` link/card helpers from earlier Core tasks are available.

## BDD Scenario
```gherkin
Scenario: harvestTweets applies the breadth rule over one shared walk
  Given a captured response and opts
  When harvestTweets runs
  Then kept tweets are assembled via the shared traversal + record + card with no duplicate walk
```
**Spec Source**: docs/superpowers/specs/2026-06-27-tweet-harvest-capture-design.md (§7)

## Files to Modify/Create
- Modify: src/core/capture/harvest.ts (implement bodies)

## Contracts (signatures/types ONLY — no bodies)
```ts
// Implement signature from task 010 using forEachTweetNode + tweetRecordFromNode + card helpers.
```

## Steps
1. Re-read the §7 breadth rule and the failing assertions from `src/core/capture/harvest.test.ts` so the implementation targets the exact behavior under test (`hasMedia(node) OR source === 'tweetDetail' OR includeTextOnly`), and confirm the no-duplicate-walk expectation (the test must observe exactly one traversal).
   - Verification: `bunx vitest run src/core/capture/harvest.test.ts` shows the task-010 assertion failing (not a compile/import error).
2. Implement the `harvestTweets` body so it drives a single `forEachTweetNode(json, visit)` pass; inside `visit`, build each candidate `TweetRecord` via `tweetRecordFromNode` (passing the resolved `source`/`sourceRank` and `capturedAt` from opts) and join its links/card metadata via the `card.ts` helpers, accumulating only the records the breadth rule keeps.
   - Verification: no second walk is introduced (only one call site of `forEachTweetNode`); media identity comes from the shared traversal's resolved media, not a re-walk.
3. Apply the breadth predicate exactly per §7 (`hasMedia` OR `source === 'tweetDetail'` OR `includeTextOnly`) and return the assembled `TweetRecord[]` in visit order.
   - Verification: kept-vs-dropped behavior for media/thread/text-only cases matches the scenario's Then.
4. Run the paired test to confirm Green, then run the full coverage gate.
   - Verification: `harvest.test.ts` passes and the `src/core` 100% gate stays green.

## Verification Commands
```bash
bunx vitest run src/core/capture/harvest.test.ts   # MUST PASS (Green)
bun run test:coverage
```

## Success Criteria
- The task-010 scenario passes: kept tweets are assembled via the shared traversal + `tweetRecordFromNode` + `card.ts` helpers, with exactly one walk (no duplicate traversal).
- The breadth rule (`hasMedia OR source === 'tweetDetail' OR includeTextOnly`) selects exactly the expected records.
- No `not implemented` stubs remain in `src/core/capture/harvest.ts`.
- Media-key identity is sourced from the shared traversal (ADR-0016), not re-derived.
- `bun run test:coverage` passes with the `src/core` 100% gate intact.
