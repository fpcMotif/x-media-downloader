# Download History lifecycle design

**Date:** 2026-07-18

**Status:** Accepted for implementation

## Problem

Download History has one queued record path, but reads and erase bypass it. An
older queued read-modify-write can therefore land after an acknowledged erase
and restore deleted records. Reads can also miss accepted, pending writes.

The current Settings gate has a second flaw: turning recording off after a
request was admitted blocks its terminal update, leaving a permanent `queued`
record.

## Chosen module

One background `DownloadHistory` module owns the durable lifecycle.

```ts
interface DownloadHistory {
  record(projection: {
    projectionId: string
    actions: ReadonlyArray<HistoryAction>
  }): Promise<'applied' | 'reset-fenced'>
  list(): Promise<ReadonlyArray<DownloadRecord>>
  listCompleted(): Promise<ReadonlyArray<CompletedDownloadRecord>>
  erase(terminalProjectionIds: ReadonlyArray<string>): Promise<void>
}
```

The pure record and store reducers stay in `core/history`. The effectful module
lives in `background` and receives a small storage adapter.

## Invariants

1. Record, read, projection, and erase share one recoverable FIFO.
2. Erase wins over every earlier accepted record action.
3. A later real download may appear after erase; erase does not cancel work.
4. Reads observe all earlier accepted actions.
5. Opt-out blocks new queued admissions, not terminal updates to admitted data.
6. Sidecars never enter history.
7. Storage is an exact bounded v3 envelope. Exact v2 and deployed unversioned
   shapes migrate on the owner lane.
8. Corrupt data blocks normal reads and writes without changing raw bytes.
   Explicit erase is the recovery path.
9. Records are bounded, terminal time cannot precede queue time, and the first
   terminal outcome wins.
10. UI clears its view only after an acknowledged erase.
11. Clear snapshots exact terminal-pending Registry projection ids on its owner
    lane. The durable reset fence blocks those identities after restart. A
    terminal identity created after that snapshot may appear.
12. Queue order comes only from immutable `queuedAt`. Duplicate admission is an
    exact no-op and terminal replay cannot move a row or change cap eviction.

## Rejected designs

- **Queue erase only:** leaves reads, startup seeding, and Cloud backfill outside
  the ordering proof.
- **Generic repository:** adds vocabulary without another domain consumer.
- **Unversioned storage:** cannot distinguish current state from a proven
  migration cohort or future incompatible data.
- **Wall-clock reset fence:** clock rollback can classify old replay as new.
- **Effectful module in `core`:** ADR-0010 keeps the core reducer pure.

## Verification

- Delay a record read, request erase, then release; history stays empty.
- Prove reads wait for pending records.
- Prove a failed write does not poison later work.
- Prove opt-out, sidecar, v2 migration, cap, corruption quarantine, immutable
  queue ordering, and terminal monotonicity.
- Record History, reset while Registry still owns the terminal projection,
  restart with a rolled-back clock, and prove replay stays erased.
- Hold the Registry snapshot open; prove a late pre-clear replay stays erased
  while a post-snapshot terminal identity applies.
- Prove the UI keeps records when erase fails.
- Run focused tests, full check, and production build.
