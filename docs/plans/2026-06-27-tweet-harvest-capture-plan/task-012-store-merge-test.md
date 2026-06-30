# Task 012: Local store merge + selectors test (Red)

**depends-on**: task-007-record-extraction-impl

## Description
Write a failing test that pins the pure local-store contract for Tweet Harvest: the richer-source-wins, non-monotonic-safe `mergeRecord` rule (§6.4), the `decodeRecords` corrupt-input guard, and the read-only selectors (`selectConversation`, `summarize`, `recentConversations`). The merge must keep a rich `TweetDetail` record (sourceRank 2) over any later thin timeline sighting (sourceRank 1) regardless of how much larger that sighting's `capturedAt` is, upgrade in the reverse direction, and fall back to newest-`capturedAt` only when ranks are equal. The selectors must report `{tweets, conversations}` counts and the `n` newest conversation threads, and corrupt input must decode to an empty array rather than throwing. Create the test plus exported type/signature stubs only so the test compiles and fails on an assertion.

## Execution Context
**Task Number**: 012 of 30
**Phase**: Core
**Prerequisites**: Task 007 (record extraction impl) has shipped `src/core/capture/record.ts` exporting the `TweetRecordShape` type that this store builds on. `mergeRecord`/selectors live in the pure, 100%-gated `src/core/capture/` layer (no I/O).

## BDD Scenario
```gherkin
Scenario: richer-source-wins merge is non-monotonic-safe
  Given an existing rich TweetDetail record (sourceRank 2) for a tweet
  When a later thin timeline sighting (sourceRank 1, larger capturedAt) is merged
  Then the rich record is KEPT (rank dominates time)
  And merging thin-then-rich UPGRADES to the rich record
  And equal-rank merges keep the newer capturedAt
  And summarize returns {tweets, conversations} and recentConversations(n) returns the n newest threads; corrupt input decodes to []
```
**Spec Source**: docs/superpowers/specs/2026-06-27-tweet-harvest-capture-design.md (§6.4, §8)

## Files to Modify/Create
- Create: `src/core/capture/store.test.ts`
- Create (stubs only): `src/core/capture/store.ts`

## Contracts (signatures/types ONLY — no bodies)
```ts
import type { TweetRecordShape } from './record'
export function mergeRecord(existing: TweetRecordShape | undefined, incoming: TweetRecordShape): TweetRecordShape
export function decodeRecords(raw: unknown): TweetRecordShape[]
export function selectConversation(records: ReadonlyArray<TweetRecordShape>, conversationId: string): TweetRecordShape[]
export function summarize(records: ReadonlyArray<TweetRecordShape>): { tweets: number; conversations: number }
export type RecentConversation = { conversationId: string; rootHandle: string; rootText: string; count: number; lastAt: number }
export function recentConversations(records: ReadonlyArray<TweetRecordShape>, n: number): RecentConversation[]
```

## Steps
1. Confirm the scenario and §6.4 / §8 spec text describe the merge precedence (rank-then-time, with equal-rank falling back to newest `capturedAt`) and the selector outputs to be locked in.
   - Verification: re-read scenario Given/When/Then and §6.4 / §8 in the spec; note `sourceRank` ride-along (`tweetDetail`=2, else 1) and that `decodeRecords` is corruption-tolerant.
2. Create `src/core/capture/store.ts` with the exact exported types and signatures from Contracts, each function body `throw new Error("not implemented")` so the test file type-checks and imports resolve. Import `TweetRecordShape` from `./record`.
   - Verification: `bunx tsc --noEmit` does not report a missing-export/import error against the new module.
3. Write `src/core/capture/store.test.ts` mapping the scenario: build a rich record (sourceRank 2) and a later thin record (sourceRank 1, strictly larger `capturedAt`) for the same `tweetId`; assert `mergeRecord(rich, thin)` returns the rich record (rank dominates time); assert `mergeRecord(thin, rich)` upgrades to rich; assert two equal-rank records merge to the one with the newer `capturedAt`; assert `summarize` returns `{tweets, conversations}` counts; assert `recentConversations(records, n)` returns the `n` newest threads with `rootHandle`/`rootText`/`count`/`lastAt`; assert `decodeRecords` of corrupt input returns `[]`; assert `selectConversation` filters to one conversation.
   - Verification: test file references only the exported symbols from Contracts and the `TweetRecordShape` shape from Task 007.
4. Run the test and confirm it FAILS on an assertion (the stub throw / wrong value), not on a compile or import error.
   - Verification: `bunx vitest run src/core/capture/store.test.ts` shows failing assertions, with the module imported successfully.

## Verification Commands
```bash
bunx vitest run src/core/capture/store.test.ts   # MUST FAIL (Red)
```

## Success Criteria
- `src/core/capture/store.test.ts` exists and encodes every Given/When/Then clause of the scenario (rich-then-thin keeps rich, thin-then-rich upgrades, equal-rank keeps newer `capturedAt`, `summarize` shape, `recentConversations(n)` newest-n, corrupt → `[]`).
- `src/core/capture/store.ts` exports exactly the Contracts types/signatures with not-implemented bodies and compiles (imports of `TweetRecordShape` from `./record` resolve).
- `bunx vitest run src/core/capture/store.test.ts` fails on assertions, not on compile/import errors (true Red).
- No implementation logic is added in this task; the pure-core 100% coverage gate is satisfied by the paired Green task, not here.
