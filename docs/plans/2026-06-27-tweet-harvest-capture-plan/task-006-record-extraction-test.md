# Task 006: TweetRecord extraction + findAuthor test (Red)

**depends-on**: task-001-capture-test-fixtures, task-003-shared-traversal-impl, task-005-card-links-impl

## Description
Author the failing (Red) test that pins down how a single X GraphQL tweet result node is normalized into a `TweetRecord`, plus the `findAuthor` outer-author guarantee. The test must assert that `tweetRecordFromNode` derives `tweetId` from `rest_id` with a `legacy.id_str` fallback, attaches the OUTER tweet's author (handle/name/userId) even when the node quotes another tweet, fills `metrics` (replies/retweets/likes/quotes/bookmarks + `views.count`), sets `text` to the `t.co`-expanded `full_text` while keeping the original in `rawText`, and stamps `source`/`sourceRank` (tweetDetail = 2 else 1) and `capturedAt` from the passed clock. Create only the exported type and signature STUBS in `record.ts` so the test compiles and fails on an assertion, not on import.

## Execution Context
**Task Number**: 006 of 30
**Phase**: Core
**Prerequisites**: Task 001 has produced the new capture fixtures (a tweet-detail node and an outer-quotes-inner node) under the project fixtures location. Task 003 has landed the shared traversal (`src/core/adapters/x/walk.ts`) exporting `Author` and `forEachTweetNode`. Task 005 has landed `src/core/capture/card.ts` exporting `Link`, `expandText`, and `linksFromEntities`. This is a Red test task: no `record.ts` bodies are implemented here.

## BDD Scenario
```gherkin
Scenario: a tweet node becomes a normalized TweetRecord
  Given a tweet result node from a fixture
  When tweetRecordFromNode builds a record
  Then tweetId uses rest_id with legacy.id_str fallback
  And author (handle, name, userId) is the OUTER tweet's author even when it quotes another tweet
  And metrics include reply/retweet/like/quote/bookmark counts and views.count
  And text is the t.co-expanded full_text while rawText keeps the original
  And source/sourceRank are set (tweetDetail=2 else 1) and capturedAt is the passed clock
```
**Spec Source**: docs/superpowers/specs/2026-06-27-tweet-harvest-capture-design.md (§6.1, §6.4)

## Files to Modify/Create
- Create: `src/core/capture/record.test.ts`
- Create (stubs only): `src/core/capture/record.ts`

## Contracts (signatures/types ONLY — no bodies)
```ts
import type { Author } from '../adapters/x/walk'
import type { Link } from './card'

export type Source = 'tweetDetail' | 'timeline' | 'other'

export function sourceRank(source: Source): number

// MediaRef + TweetRecord as Effect Schema structs (see spec §6.1 field table).
// MediaRef keeps id/type/url/ext/index/width?/height? from MediaItem.
export interface TweetRecordShape {
  tweetId: string
  conversationId: string
  inReplyToTweetId?: string
  inReplyToHandle?: string
  author: Author
  text: string
  rawText: string
  createdAt?: number
  lang?: string
  metrics: { replies?: number; retweets?: number; likes?: number; quotes?: number; bookmarks?: number; views?: number }
  links: Link[]
  media: object[]
  mentions: string[]
  hashtags: string[]
  quotedTweetId?: string
  retweetOf?: string
  source: Source
  sourceRank: number
  capturedAt: number
}

export function tweetRecordFromNode(args: {
  node: object
  author: Author
  mediaRaw: unknown[]
  source: Source
  capturedAt: number
}): TweetRecordShape | null
```

## Steps
1. Verify the scenario against the spec field table (§6.1) and merge-rank rule (§6.4): confirm the exact source paths (`rest_id`→`legacy.id_str`, `legacy.conversation_id_str`, `views.count`, the five `legacy.*_count` metrics, `legacy.full_text`) and that `sourceRank` is `tweetDetail`=2 / else 1, so the assertions below mirror the spec verbatim.
   - Verification: each `Then`/`And` clause maps to a documented field/path in §6.1 or the rank rule in §6.4; no invented fields.
2. Create `src/core/capture/record.ts` with the exported `Source` type, the `TweetRecordShape` interface, and signature STUBS for `sourceRank` and `tweetRecordFromNode` whose bodies `throw new Error('not implemented')`. Import `Author` from `../adapters/x/walk` and `Link` from `./card` exactly as in Contracts so the module type-checks.
   - Verification: `bunx tsc --noEmit` (or the project's typecheck) resolves all imports/exports; the file contains no extraction logic, only stubs that throw.
3. Write `src/core/capture/record.test.ts` mapping the scenario Given/When/Then:
   - Given: load the tweet-detail fixture node (Task 001) and an outer-quotes-inner fixture node; build the `Author` argument as the OUTER author.
   - When: call `tweetRecordFromNode({ node, author, mediaRaw, source: 'tweetDetail', capturedAt: <fixed clock> })`.
   - Then (one assertion per clause): (a) `tweetId === rest_id`, and a second node missing `rest_id` falls back to `legacy.id_str`; (b) `record.author` equals the outer handle/name/userId — NOT the quoted tweet's author; (c) `metrics.replies/retweets/likes/quotes/bookmarks` and `metrics.views` equal the fixture counts incl. `views.count`; (d) `text` equals the `t.co`-expanded `full_text` while `rawText` equals the untouched `full_text`; (e) `source === 'tweetDetail'`, `sourceRank === 2` (and a `timeline`/`other` case yields 1 via `sourceRank`), and `capturedAt` equals the passed clock.
   - Verification: the test file compiles and imports resolve; running it reaches the assertions (does not error at import time).
4. Run the test and confirm it FAILS on an assertion (the stub throwing `not implemented` inside `tweetRecordFromNode`/`sourceRank` surfaces as a failed expectation, not a compile or import error).
   - Verification: `bunx vitest run src/core/capture/record.test.ts` reports a failing assertion/throw from the stub, with the module successfully imported.

## Verification Commands
```bash
bunx vitest run src/core/capture/record.test.ts   # MUST FAIL (Red)
```

## Success Criteria
- `src/core/capture/record.ts` exports `Source`, `TweetRecordShape`, `sourceRank`, and `tweetRecordFromNode` as stubs (bodies throw `not implemented`); it imports `Author` from `../adapters/x/walk` and `Link` from `./card`.
- `src/core/capture/record.test.ts` encodes every `Then`/`And` clause of the scenario, including the `rest_id`→`legacy.id_str` fallback, outer-author-wins-over-quote, full `metrics` + `views.count`, expanded `text` vs untouched `rawText`, and `source`/`sourceRank`/`capturedAt`.
- `bunx vitest run src/core/capture/record.test.ts` fails on an assertion (Red), proving the test exercises real behavior rather than a compile/import error — leaving the Green impl (bodies + 100% `src/core` gate) for the paired implementation task.
