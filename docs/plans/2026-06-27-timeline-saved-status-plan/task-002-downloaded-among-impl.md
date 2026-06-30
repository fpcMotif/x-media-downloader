# Task 002 (impl) — downloadedAmong query + backfillTweetId mutation

**type**: impl
**depends-on**: ["002-test"]
**files**: `backend/convex/sync.ts`

Make Task 002's tests pass (Green).

## BDD Scenario

```gherkin
Scenario: Returns only tweetIds with a completed row
  Given media_state has T1=completed, T2=queued, T3=failed
  When downloadedAmong is called with the correct secret and [T1, T2, T3, T4]
  Then it returns exactly [T1]

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

- Add `downloadedAmong` query. Contract (signature only — no body logic):
  `query({ args: { secret: v.string(), tweetIds: v.array(v.string()) }, returns: v.array(v.string()), handler })`
- Handler behavior (described, not coded): `assertSecret(secret)`; reject when
  `tweetIds.length > 128`; for each id, look up via `by_tweet` and include the id
  if any row has `lastKind === 'completed'`; return the matched subset.
- Add `backfillTweetId` mutation. Contract:
  `mutation({ args: { secret: v.string() }, returns: v.object({ patched: v.number() }), handler })`
- Handler behavior: `assertSecret(secret)`; page `media_state`; for rows with empty
  `tweetId` and a present `media.tweetId`, patch the top-level `tweetId`.
- Reuse the existing `assertSecret` helper.

## Verification

- `bun run test backend/convex/sync.test.ts` — Task 002 cases **pass** (Green).
