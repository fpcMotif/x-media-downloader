# Task 024: Capture sync event + ledger test (Red)

**depends-on**: task-007-record-extraction-impl

## Description
Author the failing unit test that pins down the capture mirror's local queue: a bounded, deduped ledger of `SyncCaptureEvent`s derived from `TweetRecordShape` records. The test must specify that events dedupe by `tweetId` (a newer event replaces an older queued one), that the ledger is capped (~2000) dropping the oldest on overflow, that `captureEventId(deviceId, tweetId)` is a deterministic idempotency key, and that `decodeLedger` tolerates corrupt persisted input. Create the `src/core/sync/captures.ts` module as exported type and signature stubs only (bodies throw) so the test compiles, then prove the test fails on an assertion rather than an import/compile error. This is the Red half of the capture ledger; the implementation lands in the paired Green task.

## Execution Context
**Task Number**: 024 of 30
**Phase**: Mirror
**Prerequisites**: task-007 (record extraction impl) must be complete so `TweetRecordShape` exists at `src/core/capture/record.ts` and can be imported by the ledger module under test. Familiarity with the cloud-upload ledger precedent at `src/core/cloud/upload-job.ts` (`enqueue`/`readyJobs`/`claim`/`capLedger`/`decodeLedger`) is assumed, since the capture ledger is modeled on it.

## BDD Scenario
```gherkin
Scenario: capture events queue in a bounded, deduped ledger
  Given SyncCaptureEvents derived from records
  When they are enqueued
  Then a newer event for the same tweetId REPLACES the older queued one (dedupe by tweetId)
  And the ledger is capped (~2000) dropping oldest on overflow
  And captureEventId(deviceId, tweetId) is the deterministic idempotency key
  And decodeLedger tolerates corrupt input
```
**Spec Source**: docs/superpowers/specs/2026-06-27-tweet-harvest-capture-design.md (§9)

## Files to Modify/Create
- Create: `src/core/sync/captures.test.ts`
- Create (stubs only): `src/core/sync/captures.ts`

## Contracts (signatures/types ONLY — no bodies)
```ts
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
1. Verify the scenario and its source. Re-read §9 of the spec to confirm the capture ledger contract: dedicated `SyncCaptureEvent` schema carrying `tweetId`, `conversationId`, `inReplyToTweetId?`, `handle`, `text`, `createdAt?`, `links?`, `sourceRank`, `at`; `enqueue` deduped by `tweetId` (newer replaces older queued); `readyJobs`/`claim`; `capLedger` cap ~2000; `decodeLedger`; idempotency key `captureEventId(deviceId, tweetId) = `${deviceId}/${tweetId}``. Confirm the contracts above are the only signatures to expose — do not invent others.
   - Verification: spec §9 lists each of these names; the Given/When/Then maps one-to-one onto dedupe, cap, idempotency key, and corrupt-decode.
2. Create `src/core/sync/captures.ts` with the exported `SyncCaptureEvent` Effect Schema definition (a type/schema declaration, allowed), the exported `CaptureLedger` type, and the function signature STUBS exactly matching the Contracts block — `captureEventId`, `captureEventFromRecord`, `enqueue`, `readyJobs`, `claim`, `capLedger`, `decodeLedger`. Every function body is `throw new Error('not implemented')` so the test compiles and runs. Import `TweetRecordShape` as a type from `../capture/record`. The exported surface (ledger shape, reducer arg order, `capLedger`) MIRRORS `src/core/cloud/upload-job.ts` so the test compiles against the final surface the paired Green task implements.
   - Verification: `bunx tsc --noEmit` (or the project typecheck) resolves all imports; the module exports every symbol the test imports, including `CaptureLedger` and `capLedger`.
3. Write `src/core/sync/captures.test.ts` mapping the scenario's Given/When/Then to assertions: (Given) build `SyncCaptureEvent`s via `captureEventFromRecord` from fixture records; (When) `enqueue` them into a fresh ledger; (Then) assert a second, newer event for the same `tweetId` REPLACES the older queued one and the ledger length does not grow for a duplicate `tweetId`; assert that enqueuing past the `cap` (~2000) drops the oldest and holds the length at the cap; assert `captureEventId('dev-A', '123') === 'dev-A/123'` and is stable across calls; assert `decodeLedger` on corrupt input (e.g. a non-array / malformed value) returns a usable empty/valid ledger rather than throwing.
   - Verification: the test file imports only the contracted symbols and expresses one assertion per Then clause.
4. Run the test and confirm it FAILS on an assertion, not on a compile/import error. Each stub throwing `not implemented` must surface as a failed expectation inside the `it` blocks (the call under assertion throws/returns wrong), confirming the spec is pinned and unimplemented.
   - Verification: `bunx vitest run src/core/sync/captures.test.ts` reports failing assertions for dedupe, cap, idempotency, and corrupt-decode — and zero "Cannot find module" / TS compile errors.

## Verification Commands
```bash
bunx vitest run src/core/sync/captures.test.ts   # MUST FAIL (Red)
```

## Success Criteria
- `src/core/sync/captures.test.ts` and the stub module `src/core/sync/captures.ts` both exist; the test compiles and runs (no import/compile errors).
- The test encodes every Then of the scenario: tweetId dedupe (newer replaces older queued), ~2000 cap dropping oldest on overflow, deterministic `captureEventId(deviceId, tweetId)` key, and corrupt-input tolerance in `decodeLedger`.
- `bunx vitest run src/core/sync/captures.test.ts` FAILS on assertions (Red), confirming the unimplemented behavior is pinned for the paired Green task.
- The module exposes only the contracted signatures and the `SyncCaptureEvent` schema — no extra invented exports — keeping it ready for the 100% `src/core` coverage gate once implemented.
