# Task 001 (impl) — media_state.tweetId column + by_tweet index

**type**: impl
**depends-on**: ["001-test"]
**files**: `backend/convex/schema.ts`, `backend/convex/sync.ts`

Make Task 001's tests pass (Green): add the top-level `tweetId` column and
`by_tweet` index, and populate `tweetId` when a row is first inserted.

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

- In `schema.ts`, add `tweetId: v.string()` to the `media_state` table and a
  `.index('by_tweet', ['tweetId'])`.
- In `sync.ts` `materializeState`, set `tweetId` from `e.media?.tweetId` **only on
  insert** (the `queued` event always carries `media`). Patches (outcome events)
  must not overwrite it.
- Contract (no body logic here, signatures only):
  `async function materializeState(ctx: Ctx, e: SyncEvent): Promise<void>`
- A row whose first event ever carried no `media` has no derivable `tweetId` —
  accepted limitation; leave such inserts with an empty `tweetId` (covered by
  Task 002's backfill for retroactive rows).

## Verification

- `bun run test backend/convex/sync.test.ts` — Task 001 cases **pass** (Green).
- No regression in existing `recordEvents` idempotency/state cases.
