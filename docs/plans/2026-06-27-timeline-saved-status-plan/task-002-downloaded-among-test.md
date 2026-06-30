# Task 002 (test) — downloadedAmong + backfillTweetId

**type**: test
**depends-on**: ["001-impl"]
**files**: `backend/convex/sync.test.ts`

Write failing tests (Red) for the `downloadedAmong` query and the `backfillTweetId`
mutation. Depends on 001-impl because the tests rely on the `by_tweet` index and
the `tweetId` column existing.

## BDD Scenario

```gherkin
Scenario: Returns only tweetIds with a completed row
  Given media_state has T1=completed, T2=queued, T3=failed
  When downloadedAmong is called with the correct secret and [T1, T2, T3, T4]
  Then it returns exactly [T1]

Scenario: Cross-device match (no device filter)
  Given T5 has a completed media_state row on device "A" only
  When downloadedAmong is called (from any device context) with [T5]
  Then it returns [T5]

Scenario: Fail-closed secret gate
  Given the deployment has SYNC_SHARED_SECRET configured
  When downloadedAmong is called with a wrong secret
  Then it throws an unauthorized error and reads nothing

Scenario: Oversized batch is rejected
  Given a tweetIds array longer than the cap (128)
  When downloadedAmong is called
  Then it throws a "batch too large" error

Scenario: Backfill fills missing tweetId from nested media
  Given a pre-existing media_state row with no top-level tweetId but media.tweetId "T6"
  When backfillTweetId runs
  Then that row gains a top-level tweetId equal to "T6"
```

## Steps

- Seed `media_state` via `recordEvents` for T1 (queued→completed), T2 (queued),
  T3 (queued→failed); assert `downloadedAmong({secret, tweetIds:[T1,T2,T3,T4]})`
  returns `["T1"]`.
- Seed a completed row with `deviceId:"A"`; assert a call returns `["T5"]`
  regardless of caller device.
- Assert a wrong `secret` throws (reuse the `assertSecret` pattern from the
  existing write tests).
- Assert a `tweetIds` array of length 129 throws "batch too large".
- For backfill: insert a row directly via `t.run` with `tweetId:""` but
  `media.tweetId:"T6"`, run `backfillTweetId`, assert the row's `tweetId === "T6"`.
- Isolate via `convex-test` in-memory db.

## Verification

- `bun run test backend/convex/sync.test.ts` — the new cases **fail** (Red).
