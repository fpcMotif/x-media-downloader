# Task 026: Convex recordCaptures mutation test (Red)

**depends-on**:   <!-- none — independent -->

## Description
Author the failing (Red) test for the Convex `recordCaptures` mutation, the cloud-mirror counterpart of `recordUploadJobs`. The test must prove the mutation rejects on a bad shared secret, upserts `tweet_captures` rows keyed by `captureId` (`${deviceId}/${tweetId}`) on a good secret, applies the §6.4 richer-source-wins merge rule (a later thin sighting with `sourceRank` 1 does NOT overwrite a stored rich row with `sourceRank` 2, while a thin-then-rich sequence DOES upgrade the row), and returns `{ received, upserted }`. To make the test compile and call into Convex, also create a placeholder `captures.ts` mutation whose handler body throws "not implemented".

## Execution Context
**Task Number**: 026 of 30
**Phase**: Mirror
**Prerequisites**: None. This is an independent Red task. It uses the existing `convex-test` harness and the existing `SYNC_SHARED_SECRET` secret-gate precedent (`backend/convex/sync.ts` `assertSecret`, exercised in `backend/convex/uploads.test.ts`). The matching schema table and Green implementation land in later Mirror-phase tasks; this task only writes the test plus a throwing stub.

## BDD Scenario
```gherkin
Scenario: recordCaptures upserts with parity merge and secret gate
  Given the Convex recordCaptures mutation
  When called with a bad secret
  Then it rejects
  And with a good secret it upserts tweet_captures by captureId (deviceId/tweetId)
  And a later thin sighting (sourceRank 1) does NOT overwrite a rich row (sourceRank 2) — same rule as the local store
  And thin-then-rich upgrades; it returns { received, upserted }
```
**Spec Source**: docs/superpowers/specs/2026-06-27-tweet-harvest-capture-design.md (§9, §6.4)

## Files to Modify/Create
- Create: `backend/convex/captures.test.ts` (convex-test) — the Red spec for `recordCaptures`.
- Create: `backend/convex/captures.ts` (stub mutation so the test can call it; handler body `throw new Error('not implemented')`).

## Contracts (signatures/types ONLY — no bodies)
```ts
// backend/convex/captures.ts
// recordCaptures({ captures: CaptureRow[], secret: string }) => { received: number; upserted: number }
// CaptureRow mirrors the tweet_captures fields (see spec §9):
//   captureId: string          // `${deviceId}/${tweetId}`
//   deviceId: string
//   tweetId: string
//   conversationId: string
//   inReplyToTweetId?: string
//   handle: string
//   text: string
//   createdAt?: number
//   links?: { expandedUrl: string; title?: string; domain?: string }[]
//   sourceRank: number
//   at: number

export declare const recordCaptures: import('./_generated/server').RegisteredMutation<
  'public',
  { captures: CaptureRow[]; secret: string },
  Promise<{ received: number; upserted: number }>
>
```

## Steps
1. Verify the scenario and gather the exact contract from the spec: re-read §9 (`recordCaptures({ captures, secret })`, `by_capture_id` index, returns `{ received, upserted }`, secret via `assertSecret` / `SYNC_SHARED_SECRET`) and §6.4 (merge rule: keep incoming over existing ⟺ `incoming.sourceRank > existing.sourceRank`, then `at` as tiebreaker — NOT raw last-write-wins). Confirm `CaptureRow` field set against the `tweet_captures` `defineTable` block in §9.
   - Verification: the `CaptureRow` fields and return shape in the test match §9 verbatim; the merge assertion encodes "thin (rank 1) cannot overwrite rich (rank 2)" exactly as §6.4 states.
2. Create the stub mutation `backend/convex/captures.ts`: export a `mutation` named `recordCaptures` whose args are `{ captures: v.array(<capture validator>), secret: v.string() }` and whose handler body is `throw new Error('not implemented')`. The args validator may inline the capture object shape so the call type-checks; no merge/upsert logic here.
   - Verification: `bunx tsc --noEmit -p backend` (or the backend type step in `bun run check`) resolves `api.captures.recordCaptures`; no runtime logic exists yet.
3. Write `backend/convex/captures.test.ts` mapping Given/When/Then, following the `uploads.test.ts` harness shape: `const modules = import.meta.glob('./**/*.ts')`, `convexTest(schema, modules)`, `beforeEach(() => vi.stubEnv('SYNC_SHARED_SECRET', SECRET))`, and a `capture(over)` row factory keyed on a fixed `deviceId`/`tweetId`.
   - Given/When/Then mapping:
     - Bad-secret rejection: `await expect(t.mutation(api.captures.recordCaptures, { captures: [capture()], secret: 'wrong' })).rejects.toThrow()`.
     - Good-secret upsert by `captureId`: call with `secret: SECRET`, assert `{ received: 1, upserted: 1 }`, then `t.run((ctx) => ctx.db.query('tweet_captures').collect())` returns one row matching `captureId === 'dev-1/t-1'`.
     - Thin-cannot-overwrite-rich (§6.4): first upsert a rich row (`sourceRank: 2`, richer `text`/`links`, `at: 2_000`); then upsert a thin sighting of the same `captureId` (`sourceRank: 1`, sparse `text`, `at: 3_000`); assert the result is `{ received: 1, upserted: 0 }` and the stored row still has `sourceRank: 2` and the rich `text` (later `at` must NOT win across a lower rank).
     - Thin-then-rich upgrade: first upsert thin (`sourceRank: 1`), then upsert rich (`sourceRank: 2`); assert `{ received: 1, upserted: 1 }`, one row, stored `sourceRank: 2`.
   - Verification: the test file imports `api` from `./_generated/api`, `schema` from `./schema`, and `convexTest` from `convex-test`, mirroring `uploads.test.ts`.
4. Run the test and confirm it FAILS on an assertion, not on a compile/import error. Because the stub throws `not implemented`, the good-secret cases fail at `expect(res).toEqual(...)` / the `.rejects` assertion — confirm the failure is an assertion/thrown-handler failure, NOT a "cannot find module" or type error.
   - Verification: the failing run shows the expected-vs-received diff (or the `not implemented` thrown from the handler reaching the assertion site), confirming a true Red.

## Verification Commands
```bash
bunx vitest run backend/convex/captures.test.ts   # MUST FAIL (Red)
```

## Success Criteria
- `backend/convex/captures.test.ts` exists and encodes every clause of the scenario: bad-secret rejection, good-secret upsert keyed by `captureId`, the §6.4 thin-cannot-overwrite-rich rule, the thin-then-rich upgrade, and the `{ received, upserted }` return shape.
- `backend/convex/captures.ts` exists as a throwing stub so the test compiles and calls a real `api.captures.recordCaptures`.
- `bunx vitest run backend/convex/captures.test.ts` FAILS on an assertion (the Red bar), not on a missing-module or type error — establishing the contract the paired Green task (and `tweet_captures` schema task) must satisfy.
- No backend type/build regression introduced by the stub (the rest of `bun run check`'s backend step still resolves).
