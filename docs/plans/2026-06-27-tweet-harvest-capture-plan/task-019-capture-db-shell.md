# Task 019: IndexedDB harvest-store shell

**depends-on**: task-013-store-merge-impl, task-017-schema-wiring-impl

## Description
Build the thin, ungated IndexedDB shell `src/background/capture-db.ts` that durably persists harvested `TweetRecord`s. It wraps a single object store in DB `xmd-capture` and exposes `putRecords`, `allRecords`, `conversation`, `count`, and `clear`. Writes go through the pure `mergeRecord` reducer (read-merge-write per tweet inside one transaction) and are funneled through `makeSerialQueue` so concurrent batches cannot lose updates, mirroring the RMW discipline used for download history.

## Execution Context
**Task Number**: 019 of 30
**Phase**: Integration
**Prerequisites**: Task 013 supplies the pure `mergeRecord(existing, incoming)` reducer and `TweetRecordShape` type in `src/core/capture/store.ts`/`record.ts`; Task 017 wires the capture record schema so decoded records are available to persist. `makeSerialQueue` already exists in `src/core/serial-queue.ts`.

## BDD Scenario
```gherkin
Scenario: harvested records persist durably in IndexedDB
  Given the background service worker
  When putRecords(records) runs
  Then it read-merge-writes each tweet via mergeRecord inside ONE transaction in DB 'xmd-capture' store 'tweets' (keyPath tweetId, indexes by_conversation, by_capturedAt)
  And allRecords/conversation(id)/count/clear behave accordingly
  And writes are serialized via makeSerialQueue (no lost update under interleaving)
```
**Spec Source**: docs/superpowers/specs/2026-06-27-tweet-harvest-capture-design.md (§8)

## Files to Modify/Create
- Create: `src/background/capture-db.ts` (ungated shell)

## Contracts (signatures/types ONLY — no bodies)
```ts
import type { TweetRecordShape } from '../core/capture/record'

export function putRecords(records: ReadonlyArray<TweetRecordShape>): Promise<void>
export function allRecords(): Promise<TweetRecordShape[]>
export function conversation(id: string): Promise<TweetRecordShape[]>
export function count(): Promise<number>
export function clear(): Promise<void>
```

## Steps
1. Confirm prerequisites are in place: `mergeRecord` and `TweetRecordShape` are exported from the pure core (`src/core/capture/store.ts` / `record.ts`, from Task 013) and `makeSerialQueue` is exported from `src/core/serial-queue.ts`.
   - Verification: `grep -n "export function mergeRecord" src/core/capture/store.ts` and `grep -n "TweetRecordShape" src/core/capture/record.ts` and `grep -n "makeSerialQueue" src/core/serial-queue.ts` each return a match.
2. Create `src/background/capture-db.ts` as the ungated IndexedDB shell. Open/upgrade DB `xmd-capture` with object store `tweets` (keyPath `tweetId`) and indexes `by_conversation` and `by_capturedAt`. Implement `putRecords` to read-merge-write each tweet via the pure `mergeRecord` inside one transaction, with all write operations funneled through a module-level `makeSerialQueue` so interleaved batches do not lose updates. Implement `allRecords`, `conversation(id)`, `count`, and `clear` as read/maintenance operations over the same store.
   - Verification: `bun run check` passes (build/lint/types) with no errors in `src/background/capture-db.ts`; the module imports only `mergeRecord`/`TweetRecordShape` from core and `makeSerialQueue` from `../core/serial-queue`, with no `browser.storage.local` usage.
3. Document the durability assumption inline only where load-bearing: the shell is the durable source of truth and IndexedDB requires the `unlimitedStorage` manifest permission (wired separately) to avoid eviction under storage pressure.
   - Verification: `bun run check` still passes; the file contains no extraneous prose comments beyond the load-bearing note.

## Verification Commands
```bash
bun run check
# Manual: load the dev extension, enable Capture, scroll X, confirm records appear (DevTools > Application > IndexedDB > xmd-capture).
```

## Success Criteria
- `src/background/capture-db.ts` exports `putRecords`, `allRecords`, `conversation`, `count`, and `clear` with the exact contract signatures.
- `putRecords` read-merge-writes each tweet via the pure `mergeRecord` inside ONE transaction against DB `xmd-capture`, store `tweets` (keyPath `tweetId`, indexes `by_conversation`, `by_capturedAt`).
- All writes are serialized through `makeSerialQueue`, so no update is lost under interleaving (matches the scenario).
- This is an ungated shell (no 100% unit gate): `bun run check` (build/lint/types) passes, and the manual DevTools IndexedDB check confirms records persist in `xmd-capture` when Capture is enabled and X is scrolled.
