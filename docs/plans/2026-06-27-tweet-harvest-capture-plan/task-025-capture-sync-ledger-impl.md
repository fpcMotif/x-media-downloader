# Task 025: Capture sync event + ledger impl (Green)

**depends-on**: task-024-capture-sync-ledger-test

## Description
Implement the bodies of the dedicated capture sync ledger so the bounded, deduped, idempotent behavior specified by the task-024 Red test passes exactly. The module is the client-side control-plane stream for the opt-in Convex mirror (§9): a `SyncCaptureEvent` carrying one tweet's mirror-eligible fields (`tweetId`, `conversationId`, `inReplyToTweetId?`, `handle`, `text`, `createdAt?`, `links?`, `sourceRank`, `at`) plus a deterministic idempotency key, and a pure bounded ledger reducer modeled on `src/core/cloud/upload-job.ts` (NOT the `SyncEvent`-bound `core/sync/outbox.ts`). `captureEventId(deviceId, tweetId)` must produce the deterministic `` `${deviceId}/${tweetId}` `` key that makes at-least-once enqueue exactly-once; `enqueue` must dedupe by `tweetId` so a newer event replaces an older queued one for the same tweet; `readyJobs`/`claim` must surface and lease drainable events; `capLedger` must bound the ledger at roughly 2000 entries; and `decodeLedger` must turn raw persisted input into a validated ledger, falling back to empty on corrupt data. This is the Green half of the task-024 Red test: turn the failing assertions into passing ones without changing the test.

## Execution Context
**Task Number**: 025 of 30
**Phase**: Mirror
**Prerequisites**: Task 024 (Red) has landed: `src/core/sync/captures.ts` exists with the exported `SyncCaptureEvent` schema/type, the `CaptureLedger` type, and the `captureEventId`, `decodeLedger`, `enqueue`, `readyJobs`, `claim`, and `capLedger` signatures whose bodies currently `throw new Error("not implemented")`, and `src/core/sync/captures.test.ts` encodes the BDD scenario and is currently failing on an assertion (not a compile/import error). The `upload-job.ts` ledger is the structural precedent (injected `now`, no I/O, no clock, no randomness; deterministic ids; bounded ledger), and §6.4's merge ordering (`sourceRank` then `at`) is the source of truth for which sighting wins on the cloud side.

## BDD Scenario
```gherkin
Scenario: capture events queue in a bounded, deduped ledger
  Given the ledger reducers
  When events enqueue/claim
  Then dedupe-by-tweetId, cap, and idempotency key behave per the scenario
```
**Spec Source**: docs/superpowers/specs/2026-06-27-tweet-harvest-capture-design.md (§9)

## Files to Modify/Create
- Modify: `src/core/sync/captures.ts` (implement bodies)

## Contracts (signatures/types ONLY — no bodies)
```ts
// implement the signatures from task 024 (mirror core/cloud/upload-job.ts; do NOT reuse the SyncEvent-bound core/sync/outbox.ts)

import type { TweetRecordShape } from '../capture/record'
// SyncCaptureEvent = Effect Schema { eventId, tweetId, conversationId, inReplyToTweetId?, handle, text, createdAt?, links?, sourceRank, at }
// CaptureLedger + reducers MIRROR src/core/cloud/upload-job.ts EXACTLY (match its ledger shape and arg order).
export type CaptureLedger = unknown // = the upload-job ledger shape adapted to SyncCaptureEvent (e.g. { pending: SyncCaptureEvent[] })
export function captureEventId(deviceId: string, tweetId: string): string
export function captureEventFromRecord(record: TweetRecordShape, deviceId: string, at: number): unknown // SyncCaptureEvent
export function enqueue(ledger: CaptureLedger, event: unknown, cap?: number): CaptureLedger // dedupe by tweetId; cap oldest on overflow
export function readyJobs(ledger: CaptureLedger, now: number): unknown[]
export function claim(ledger: CaptureLedger, eventId: string, now: number, leaseMs?: number): CaptureLedger
export function capLedger(ledger: CaptureLedger, cap: number): CaptureLedger
export function decodeLedger(raw: unknown): CaptureLedger
```

## Steps
1. Re-read the task-024 test `src/core/sync/captures.test.ts` and §9 (and §6.4 for the ordering used cloud-side) so the implementation matches the scenario exactly: `captureEventId` is the deterministic `` `${deviceId}/${tweetId}` `` key; `enqueue` dedupes **by `tweetId`** (a newer event for the same tweet replaces the older queued one — distinct from `upload-job.ts` which keys on `idempotencyKey`); `capLedger` bounds the ledger at the ~2000 cap (oldest trimmed on overflow); `readyJobs`/`claim` lease drainable events with an injected `now`; and `decodeLedger` validates raw input and falls back to empty on corrupt data.
   - Verification: the test names/assertions map 1:1 to the §9 behaviors — dedupe-by-`tweetId` keeps the newer event, the cap trims the oldest beyond ~2000, and the idempotency key is `` `${deviceId}/${tweetId}` `` — with `now` injected (no real clock/randomness in the module).
2. In `src/core/sync/captures.ts`, replace the `throw new Error("not implemented")` body of `captureEventId` so it returns `` `${deviceId}/${tweetId}` ``, the deterministic key that makes at-least-once enqueue exactly-once.
   - Verification: `bun run check` type-checks; no new exported symbols beyond those defined in task 024.
3. Replace the `throw new Error("not implemented")` body of `enqueue` (adding any private, non-exported helpers needed) so it appends the event or replaces the existing queued event for the same `tweetId` with the newer one, then trims to the cap; and implement `decodeLedger` to decode raw persisted input into a validated `CaptureLedger`, returning empty on a decode failure (the `outbox.ts`/`upload-job.ts` corrupt-data idiom).
   - Verification: `bun run check` type-checks; `enqueue` never grows the ledger past the cap and never holds two entries for one `tweetId`.
4. Replace the `throw new Error("not implemented")` bodies of `readyJobs`, `claim`, and `capLedger` so `readyJobs` surfaces the drainable events at `now`, `claim` is the compare-and-set lease/fencing transition over an `eventId` (modeled on `upload-job.ts` `claim`), and `capLedger` returns a ledger bounded to the ~2000 cap (returning the same reference when nothing is dropped).
   - Verification: `bun run check` type-checks; the returned shapes match the task-024 contracts byte-for-byte and `claim` refuses a held lease / honors the injected `now`.
5. Run the paired test and confirm the previously failing assertions now pass.
   - Verification: `bunx vitest run src/core/sync/captures.test.ts` is green, including the dedupe-by-`tweetId`, cap, and `captureEventId` cases from the scenario.

## Verification Commands
```bash
bunx vitest run src/core/sync/captures.test.ts   # MUST PASS (Green)
bun run test:coverage
```

## Success Criteria
- `src/core/sync/captures.test.ts` passes, including dedupe-by-`tweetId` (a newer event replaces the older queued one), the ~2000 cap trims the oldest, and `captureEventId(deviceId, tweetId) === ` `` `${deviceId}/${tweetId}` `` from the scenario.
- The ledger is pure and bounded: `enqueue`/`claim`/`readyJobs`/`capLedger` take an injected `now` where time matters, hold no clock or randomness, never exceed the cap, and never keep two entries for one `tweetId`; `decodeLedger` falls back to empty on corrupt data.
- The module mirrors `core/cloud/upload-job.ts` (its own dedicated ledger) and does **not** reuse `core/sync/outbox.ts`; no new exported symbols beyond the task-024 contracts; the task-024 test is unchanged.
- `bun run test:coverage` stays green at 100% over `src/core` (the new `captures.ts` bodies are fully covered).
