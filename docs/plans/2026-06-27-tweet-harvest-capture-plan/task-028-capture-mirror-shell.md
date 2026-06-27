# Task 028: Background capture mirror shell (mirrorCaptures)

**depends-on**: task-020-background-capture-handlers, task-025-capture-sync-ledger-impl, task-027-convex-record-captures-impl

## Description
Add the background-side opt-in mirror shell that forwards harvested tweet records to the Convex control plane. Create `src/background/capture-outbox.ts` exposing `mirrorCaptures(records)`, which gates strictly on sync being configured AND the `captureMirrorEnabled` toggle, enqueues events into a persisted `captureOutboxItem` outbox, and drains them to the `recordCaptures` mutation over the shared Convex HTTP port — swallowing all control-plane errors so the local IndexedDB harvest stays the source of truth. Wire this call into the existing `CaptureTweets` dispatcher in `background.ts` so every accepted batch is offered to the mirror after being persisted locally. This parallels the existing `mirrorUploadJob` flow in `cloud-upload.ts`.

## Execution Context
**Task Number**: 028 of 30
**Phase**: Mirror
**Prerequisites**: Task 020 established the `CaptureTweets` dispatcher and `capture-db.putRecords` local persistence; Task 025 provides the capture sync ledger reducer (`enqueue`/`readyJobs`/`claim`/`capLedger`/`decodeLedger`) used to manage the outbox; Task 027 provides the deployed `captures:recordCaptures` mutation that this drain targets. The shared `makeConvexHttpPort`, `isSyncConfigured`, and `Settings`/`captureMirrorEnabled` flag must already exist.

## BDD Scenario
```gherkin
Scenario: captures mirror to Convex only when opted in
  Given mirrorCaptures(records)
  When captureMirrorEnabled is OFF or sync is unconfigured
  Then nothing is sent
  And when ON + configured, events enqueue into captureOutboxItem and drain to recordCaptures via the shared Convex HTTP port, swallowing control-plane errors (IndexedDB stays source of truth)
```
**Spec Source**: docs/superpowers/specs/2026-06-27-tweet-harvest-capture-design.md (§9)

## Files to Modify/Create
- Create: `src/background/capture-outbox.ts` (mirrorCaptures + drain)
- Modify: `src/entrypoints/background.ts` (call mirrorCaptures from the CaptureTweets dispatcher)

## Contracts (signatures/types ONLY — no bodies)
```ts
import type { TweetRecordShape } from '../core/capture/record'
export function mirrorCaptures(records: ReadonlyArray<TweetRecordShape>): void   // parallels cloud-upload.ts mirrorUploadJob
```

## Steps
1. Create `src/background/capture-outbox.ts` exporting `mirrorCaptures` with the signature above. Implement the gate first: read `Settings` and return early (sending nothing) when sync is unconfigured (`!isSyncConfigured(settings)` / missing `cloudDeviceId`) OR `settings.captureMirrorEnabled` is false. Model the structure on `mirrorUploadJob` in `src/background/cloud-upload.ts`.
   - Verification: `mirrorCaptures` is exported and importable; with the mirror toggle off or sync unconfigured the function performs no enqueue and no network call (no `captureOutboxItem` write, no port mutation).
2. When the gate passes, map the records into capture events and `enqueue` them (deduped by `tweetId`, newer replaces older) into the persisted `captureOutboxItem` (storage.local) using the capture sync ledger reducer from Task 025, persisting with `capLedger`.
   - Verification: an accepted batch results in `captureOutboxItem` holding the enqueued events; re-mirroring the same `tweetId` replaces rather than duplicates the queued event.
3. Implement the serialized drain: claim `readyJobs` from the decoded ledger, send them to `captures:recordCaptures` via `makeConvexHttpPort({ deploymentUrl: settings.convexUrl, fetchImpl })` with `secret: settings.convexSyncSecret`, and persist the settled ledger (`capLedger`). Wrap the network/mutation in a `try/catch` that swallows control-plane errors (best-effort; IndexedDB remains source of truth), exactly like `mirrorUploadJob`.
   - Verification: with mirror on + sync configured, the drain issues a `captures:recordCaptures` mutation through the shared port; a thrown/rejected mutation is caught and does not propagate, and the local harvest is untouched.
4. In `src/entrypoints/background.ts`, locate the `CaptureTweets` message handler (the dispatcher added in Task 020) and, after `capture-db.putRecords(records)` persists locally, call `mirrorCaptures(records)`. Do not let mirror failures affect the `{ stored }` response.
   - Verification: the dispatcher persists locally then invokes `mirrorCaptures`; the `{ stored }` reply is unchanged whether the mirror is on, off, or erroring.
5. Run the build/lint/type gate and confirm the new module and wiring compile cleanly.
   - Verification: `bun run check` passes.

## Verification Commands
```bash
bun run check
# Manual: configure Convex + enable mirror, scroll, confirm tweet_captures rows appear; disable mirror -> no new rows.
```

## Success Criteria
- `mirrorCaptures` sends nothing when `captureMirrorEnabled` is OFF or sync is unconfigured (no enqueue, no port mutation).
- When the toggle is ON and sync is configured, events are enqueued into `captureOutboxItem` and drained to `captures:recordCaptures` over the shared Convex HTTP port.
- Control-plane errors during drain are swallowed; the local IndexedDB harvest remains the source of truth and the `CaptureTweets` `{ stored }` response is unaffected.
- The `CaptureTweets` dispatcher in `background.ts` calls `mirrorCaptures(records)` after local persistence.
- `bun run check` (build/lint/types) passes; manual extension check shows `tweet_captures` rows appear with mirror enabled and stop appearing when disabled (this `src/background`/`src/entrypoints` shell zone has no 100% unit gate).
