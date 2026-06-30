# Task 013: Local store merge + selectors impl (Green)

**depends-on**: task-012-store-merge-test

## Description
Implement the bodies of the pure store module so the §6.4 richer-source-wins merge rule and its read-side selectors behave exactly as the task-012 Red test specifies. `mergeRecord` must pick the winner between an existing and an incoming `TweetRecord` using the non-monotonic-safe rule (keep incoming iff `incoming.sourceRank > existing.sourceRank`, OR equal rank AND `incoming.capturedAt >= existing.at`), replacing the loser whole because records are self-consistent snapshots; `decodeRecords` must turn raw persisted input into validated records; and the selectors `selectConversation`, `summarize`, and `recentConversations` must derive their views over a collection of records. This is the Green half of the task-012 Red test: turn the failing assertions into passing ones without changing the test, so that a rich `TweetDetail` sighting can never be clobbered by a later thin timeline sighting (rich-then-thin stays rich) while a thin-then-rich sequence upgrades.

## Execution Context
**Task Number**: 013 of 30
**Phase**: Core
**Prerequisites**: Task 012 (Red) has landed: `src/core/capture/store.ts` exists with the exported types and the `decodeRecords`, `mergeRecord`, `selectConversation`, `summarize`, and `recentConversations` signatures whose bodies currently `throw new Error("not implemented")`, and `src/core/capture/store.test.ts` encodes the BDD scenario and is currently failing on an assertion (not a compile/import error). The `TweetRecord` type from `record.ts` — carrying `tweetId`, `conversationId`, `sourceRank`, and `capturedAt`/`at` — is available as the merge and selector input.

## BDD Scenario
```gherkin
Scenario: richer-source-wins merge is non-monotonic-safe
  Given the merge rule keep incoming iff incoming.sourceRank > existing.sourceRank OR (equal rank AND incoming.capturedAt >= existing.at)
  When records merge
  Then rich-then-thin stays rich and thin-then-rich upgrades
```
**Spec Source**: docs/superpowers/specs/2026-06-27-tweet-harvest-capture-design.md (§6.4, §8)

## Files to Modify/Create
- Modify: `src/core/capture/store.ts` (implement bodies)

## Contracts (signatures/types ONLY — no bodies)
```ts
// Implement signatures from task 012.
//
// No new exports. The types and signatures below already exist in store.ts
// from task 012 (Red); task 013 only fills their bodies.
//
//   export function decodeRecords(raw: unknown): TweetRecord[]
//   // mergeRecord: keep incoming iff
//   //   incoming.sourceRank > existing.sourceRank
//   //   OR (equal rank AND incoming.capturedAt >= existing.capturedAt)
//   // (local TweetRecordShape carries capturedAt; .at exists only on the Convex row.
//   //  the Convex parity mutation (task 027) applies the same rule with .at, which mirrors capturedAt.)
//   export function mergeRecord(existing: TweetRecord, incoming: TweetRecord): TweetRecord
//   export function selectConversation(records: readonly TweetRecord[], conversationId: string): TweetRecord[]
//   export function summarize(records: readonly TweetRecord[]): { tweets: number; conversations: number }
//   export function recentConversations(
//     records: readonly TweetRecord[],
//     n: number,
//   ): { conversationId: string; rootHandle: string; rootText: string; count: number; lastAt: number }[]
```

## Steps
1. Re-read the task-012 test `src/core/capture/store.test.ts` and §6.4 / §8 of the spec so the implementation matches the scenario exactly: the merge rule is rank-first then `capturedAt >= capturedAt` on equal rank (the `>=` tie-break on the local `TweetRecordShape.capturedAt` field, not strict `>`; `.at` exists only on the Convex row), the winner replaces the loser whole, `decodeRecords` validates raw input into `TweetRecord[]`, and the selectors derive conversation slices, the `{ tweets, conversations }` summary, and the `{ conversationId, rootHandle, rootText, count, lastAt }[]` recent list. Note: the Convex parity mutation (task 027) applies the same rule with `.at`, which mirrors `capturedAt`.
   - Verification: the test names/assertions map 1:1 to the §6.4 behaviors — rich-then-thin keeps rich, thin-then-rich upgrades, equal-rank-later-time wins on `>=` — and to the §8 selector shapes.
2. In `src/core/capture/store.ts`, replace the `throw new Error("not implemented")` body of `mergeRecord` (and add any private, non-exported helpers needed) so it keeps `incoming` iff `incoming.sourceRank > existing.sourceRank` OR (equal rank AND `incoming.capturedAt >= existing.at`), otherwise keeps `existing`, returning the chosen record whole.
   - Verification: `bun run check` type-checks; no new exported symbols beyond those defined in task 012.
3. Replace the `throw new Error("not implemented")` body of `decodeRecords` so it turns raw persisted input into validated `TweetRecord[]`, and implement `selectConversation` (records for one `conversationId`), `summarize` (distinct `{ tweets, conversations }` counts), and `recentConversations` (top-`n` conversations by `lastAt`, each surfacing root handle/text, member count, and last-seen time) consistent with §8 and §12.
   - Verification: `bun run check` type-checks; the returned object shapes match the contracts byte-for-byte (`{ tweets, conversations }` and `{ conversationId, rootHandle, rootText, count, lastAt }`).
4. Run the paired test and confirm the previously failing assertions now pass.
   - Verification: `bunx vitest run src/core/capture/store.test.ts` is green, including both the rich-then-thin and thin-then-rich merge cases and the selector assertions.

## Verification Commands
```bash
bunx vitest run src/core/capture/store.test.ts   # MUST PASS (Green)
bun run test:coverage
```

## Success Criteria
- `src/core/capture/store.test.ts` passes, including rich-then-thin stays rich, thin-then-rich upgrades, and the equal-rank `capturedAt >= capturedAt` tie-break from the scenario (the local `TweetRecordShape` field is `capturedAt`; `.at` exists only on the Convex row, and the Convex parity mutation (task 027) applies the same rule with `.at`, which mirrors `capturedAt`).
- `mergeRecord` is non-monotonic-safe: a later thin timeline sighting can never overwrite a higher-`sourceRank` record; the winner replaces the loser whole.
- `decodeRecords` and the selectors (`selectConversation`, `summarize`, `recentConversations`) return the §8 shapes exactly; no new exported symbols beyond the task-012 contracts; the task-012 test is unchanged.
- `bun run test:coverage` stays green at 100% over `src/core` (the new `store.ts` bodies are fully covered).
