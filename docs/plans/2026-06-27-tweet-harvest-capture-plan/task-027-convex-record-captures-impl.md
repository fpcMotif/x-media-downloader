# Task 027: Convex tweet_captures table + recordCaptures impl (Green)

**depends-on**: task-026-convex-record-captures-test

## Description
Make the failing `recordCaptures` mutation test from task 026 pass by adding the `tweet_captures` table (with its validators and indexes) to `backend/convex/schema.ts` and implementing the `recordCaptures` mutation in `backend/convex/captures.ts`. The mutation must fail closed on the shared secret, upsert each incoming capture idempotently by its `captureId` via the `by_capture_id` index, and apply the §6.4 merge rule (rank-then-`at`, not raw last-write-wins) so that a later thin sighting can never overwrite a richer row. The table validators are defined in `schema.ts` and imported by `captures.ts` as the single source of truth.

## Execution Context
**Task Number**: 027 of 30
**Phase**: Mirror
**Prerequisites**: Task 026 has created `backend/convex/captures.test.ts` exercising `recordCaptures` (insert, secret gate, by_capture_id idempotency, and the §6.4 rank-then-`at` merge), and that test currently FAILS because the mutation/table are stubbed or absent. The cloud-upload precedent (`backend/convex/uploads.ts` `recordUploadJobs` + `upload_jobs` table) and the shared `assertSecret`/`SYNC_SHARED_SECRET` convention already exist in the backend package.

## BDD Scenario
```gherkin
Scenario: recordCaptures upserts with parity merge and secret gate
  Given the tweet_captures table + mutation
  When records arrive
  Then assertSecret gates, by_capture_id idempotency applies, and the §6.4 rank-then-at merge keeps rich rows
```
**Spec Source**: docs/superpowers/specs/2026-06-27-tweet-harvest-capture-design.md (§9, §6.4)

## Files to Modify/Create
- Modify: `backend/convex/captures.ts` (implement mutation; assertSecret; §6.4 merge)
- Modify: `backend/convex/schema.ts` (add tweet_captures table + validators per spec §9)

## Contracts (signatures/types ONLY — no bodies)
```ts
// Implement per spec §9. Validators live in schema.ts and are imported by captures.ts (single source of truth).

// backend/convex/schema.ts — table definition (per §9) + exported validators reused by captures.ts
export const captureLink: import('convex/values').Validator<{
  expandedUrl: string
  title?: string
  domain?: string
}>
export const captureRow: import('convex/values').Validator<{
  captureId: string
  deviceId: string
  tweetId: string
  conversationId: string
  inReplyToTweetId?: string
  handle: string
  text: string
  createdAt?: number
  links?: { expandedUrl: string; title?: string; domain?: string }[]
  sourceRank: number
  at: number
}>
// tweet_captures: defineTable(captureRow)
//   .index('by_capture_id', ['captureId'])
//   .index('by_conversation', ['conversationId'])
//   .index('by_at', ['at'])

// backend/convex/captures.ts — modeled on recordUploadJobs
function assertSecret(secret: string): void

export const recordCaptures: import('convex/server').RegisteredMutation<
  'public',
  { captures: Array<{
      captureId: string
      deviceId: string
      tweetId: string
      conversationId: string
      inReplyToTweetId?: string
      handle: string
      text: string
      createdAt?: number
      links?: { expandedUrl: string; title?: string; domain?: string }[]
      sourceRank: number
      at: number
    }>
    secret: string },
  Promise<{ received: number; upserted: number }>
>
```

## Steps
1. Confirm the scenario and the failing test from task 026: re-read `backend/convex/captures.test.ts` and note the exact assertions it makes (return shape `{ received, upserted }`, the secret-gate rejection, the `by_capture_id` idempotency case, and the §6.4 rank-then-`at` merge keeping the rich row on `rich-then-thin` while upgrading on `thin-then-rich`).
   - Verification: `bunx vitest run backend/convex/captures.test.ts` fails on a behavioral assertion (or "not implemented"), not because the file is missing.
2. In `backend/convex/schema.ts`, add the `tweet_captures` table using `defineTable(...)` with exactly the validators from spec §9 (captureId, deviceId, tweetId, conversationId, optional inReplyToTweetId, handle, text, optional createdAt, optional links array of `{ expandedUrl, title?, domain? }`, sourceRank, at) and the three indexes `by_capture_id` on `['captureId']`, `by_conversation` on `['conversationId']`, and `by_at` on `['at']`. Export the reusable row/link validators so `captures.ts` imports them (single source of truth).
   - Verification: `bun run check` typechecks the backend; `tweet_captures` appears in `schema.ts` with the three indexes.
3. In `backend/convex/captures.ts`, build the codegen-free typed `mutation` builder (as in `uploads.ts`/`sync.ts`), import the row validator from `schema.ts`, and add a fail-closed `assertSecret(secret)` matching the existing `SYNC_SHARED_SECRET` convention.
   - Verification: `bun run check` typechecks; `assertSecret` reads `process.env.SYNC_SHARED_SECRET` and throws on missing/mismatch.
4. Implement `recordCaptures({ captures, secret })`: call `assertSecret(secret)` first; for each incoming capture, look up the existing row via `withIndex('by_capture_id', q => q.eq('captureId', ...))`; insert when absent, otherwise apply the §6.4 rule — keep incoming iff `incoming.sourceRank > existing.sourceRank` OR (equal rank AND `incoming.at >= existing.at`) — patching the whole row (records are self-consistent snapshots) and counting `upserted`; return `{ received: captures.length, upserted }`.
   - Verification: `bunx vitest run backend/convex/captures.test.ts` passes the insert, secret-gate, idempotency, and merge cases.
5. Run the full backend gate to confirm no regressions to `uploads`/`sync` tests or the schema.
   - Verification: `bun run check` is green.

## Verification Commands
```bash
bunx vitest run backend/convex/captures.test.ts   # MUST PASS (Green)
bun run check
```

## Success Criteria
- The task 026 test `backend/convex/captures.test.ts` PASSES: insert returns `{ received, upserted }`, a wrong/missing secret throws, re-sending the same `captureId` is upsert-idempotent via `by_capture_id`, and the §6.4 rank-then-`at` merge keeps the rich row on `rich-then-thin` and upgrades on `thin-then-rich`.
- `tweet_captures` exists in `backend/convex/schema.ts` with the §9 validators and the `by_capture_id`, `by_conversation`, and `by_at` indexes; its validators are the single source of truth imported by `captures.ts`.
- The build/lint/type gate `bun run check` is green, with no regression to the existing `uploads`/`sync` mutations and tests.
