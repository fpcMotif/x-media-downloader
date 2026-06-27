# Task 010: Harvest breadth rule + assembly test (Red)

**depends-on**: task-001-capture-test-fixtures, task-003-shared-traversal-impl, task-005-card-links-impl, task-007-record-extraction-impl

## Description
Write the failing test that pins down `harvestTweets` — the capture-flow entry point that consumes the single shared traversal (`forEachTweetNode`) and applies the breadth rule. The test must assert that a tweet is kept iff it has media OR `source === 'tweetDetail'` OR `includeTextOnly` is set, that each kept tweet emerges as a fully assembled `TweetRecord` (record fields + expanded links + card titles + media refs), and that exactly one traversal happens (the shared walk is consumed once; no second walk and no re-resolved media). Create only stub exports in `harvest.ts` so the test compiles and fails on an assertion, not an import error.

## Execution Context
**Task Number**: 010 of 30
**Phase**: Core
**Prerequisites**: The capture fixtures from task-001 exist; the shared `forEachTweetNode` traversal (task-003) is implemented; card/link de-shortening helpers (task-005) are implemented; and `record.ts` exporting `TweetRecordShape`, `Source`, and the record-extraction logic (task-007) is implemented. This is the Red half of the harvest pair; the Green implementation is the next task.

## BDD Scenario
```gherkin
Scenario: harvestTweets applies the breadth rule over one shared walk
  Given a captured response and opts { source, includeTextOnly, capturedAt }
  When harvestTweets runs
  Then a tweet is kept iff it has media OR source === 'tweetDetail' OR includeTextOnly
  And each kept tweet becomes a fully assembled TweetRecord (record + expanded links + card titles + media refs)
  And it performs exactly ONE traversal (consumes forEachTweetNode; no second walk, no re-resolved media)
```
**Spec Source**: docs/superpowers/specs/2026-06-27-tweet-harvest-capture-design.md (§7)

## Files to Modify/Create
- Create: src/core/capture/harvest.test.ts
- Create (stubs only): src/core/capture/harvest.ts

## Contracts (signatures/types ONLY — no bodies)
```ts
import type { TweetRecordShape, Source } from './record'
export function harvestTweets(json: unknown, opts: { source: Source; includeTextOnly: boolean; capturedAt: number }): TweetRecordShape[]
```

## Steps
1. Confirm the scenario maps to the breadth rule in §7: keep iff `hasMedia(node) || source === 'tweetDetail' || includeTextOnly`, with one shared traversal and full per-tweet assembly.
   - Verification: re-read §7 and the contract above; confirm the three keep conditions and the "exactly ONE traversal" constraint are the assertions to encode.
2. Create `src/core/capture/harvest.ts` with the exported signature above as a stub whose body is `throw new Error('not implemented')`, importing the `TweetRecordShape` and `Source` types from `./record` so the test type-checks and compiles.
   - Verification: `bunx tsc --noEmit` (or `bun run check`) resolves the import and the exported `harvestTweets` signature; no missing-symbol errors.
3. Write `src/core/capture/harvest.test.ts` mapping Given/When/Then:
   - Given: load the task-001 capture fixtures and build `opts = { source, includeTextOnly, capturedAt }` variants covering each breadth branch (a media-only timeline response with `includeTextOnly: false`, a `tweetDetail` response, and a text-only response with `includeTextOnly: true`).
   - When: call `harvestTweets(json, opts)`.
   - Then (breadth): assert text-only tweets are dropped when `source !== 'tweetDetail'` and `includeTextOnly` is false, kept when `source === 'tweetDetail'`, kept when `includeTextOnly` is true, and media tweets are always kept.
   - Then (assembly): assert each kept item is a fully assembled `TweetRecord` — record fields populated, `links` expanded (`t.co` → `expandedUrl`), card titles carried, and `media` refs present for media tweets — with `capturedAt` set from opts and `source`/`sourceRank` derived from opts.
   - Then (module-nested breadth, reinforces 002): assert `harvestTweets` over `tweet-detail-thread.json` with `source === 'tweetDetail'` returns ALL THREE module-nested records (root, reply-A, grandchild-B) by id, pinning that module-nested tweets are extracted end-to-end, not just top-level ones.
   - Then (one walk): assert exactly one traversal by spying on the shared `forEachTweetNode` (assert it is invoked once and the visitor is not re-run) and that media is not re-resolved (no second media walk).
   - Verification: the test file imports `harvestTweets` from `./harvest` and the fixtures, and references `forEachTweetNode` for the single-walk assertion.
4. Run the test and confirm it FAILS on an assertion (the breadth/assembly/one-walk expectations), not on a compile or import error.
   - Verification: `bunx vitest run src/core/capture/harvest.test.ts` reports a failing assertion against the `not implemented` stub, not a module-resolution/TypeError-on-import failure.

## Verification Commands
```bash
bunx vitest run src/core/capture/harvest.test.ts   # MUST FAIL (Red)
```

## Success Criteria
- `src/core/capture/harvest.test.ts` and the `harvest.ts` stub exist and the test compiles (imports resolve, types check).
- The test encodes all three Then clauses: the breadth keep-rule (media OR `tweetDetail` OR `includeTextOnly`), full `TweetRecord` assembly (record + expanded links + card titles + media refs), and exactly one traversal via a spied `forEachTweetNode` with no re-resolved media.
- `bunx vitest run src/core/capture/harvest.test.ts` FAILS on an assertion (Red), confirming the spec is pinned before implementation.
- No implementation logic lives in `harvest.ts` beyond the stub that throws; the paired Green task will turn this test green and run the full 100% core coverage gate.
