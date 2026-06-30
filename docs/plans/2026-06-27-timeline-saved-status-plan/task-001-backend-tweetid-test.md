# Task 001 (test) — media_state.tweetId materialization

**type**: test
**depends-on**: []
**files**: `backend/convex/sync.test.ts`

Write failing tests (Red) asserting that ingesting events populates a top-level
`tweetId` on `media_state`, retrievable via a `by_tweet` index. Tests use
`convex-test` (mirror the existing cases in `backend/convex/sync.test.ts`).

## BDD Scenario

```gherkin
Scenario: Queued event populates top-level tweetId
  Given a queued sync event whose media.tweetId is "T1"
  When recordEvents ingests it
  Then the created media_state row has a top-level tweetId equal to "T1"
  And the row is retrievable via the by_tweet index for "T1"

Scenario: Outcome event preserves tweetId
  Given an existing media_state row for request "R" with tweetId "T1"
  When a completed event for "R" (carrying no media) is ingested
  Then the row's tweetId remains "T1"
  And the row's lastKind is "completed"
```

## Steps

- Add a test that records a `queued` event (with `media.tweetId = "T1"`) via
  `api.sync.recordEvents`, then reads `media_state` and asserts `row.tweetId === "T1"`.
- Add a test that queries `media_state` through `withIndex('by_tweet', q => q.eq('tweetId','T1'))`
  and asserts the row is found.
- Add a test that records `queued` then `completed` for the same `requestId` and
  asserts `tweetId` is unchanged and `lastKind === 'completed'`.
- Isolate all I/O through `convex-test`'s in-memory db (no live deployment).

## Verification

- `bun run test backend/convex/sync.test.ts` — the new cases **fail** (Red): the
  `tweetId` column and `by_tweet` index do not exist yet.
