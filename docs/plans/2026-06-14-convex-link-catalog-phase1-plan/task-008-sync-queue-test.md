# Task 008 — Durable local:sync-queue (test / Red)

- **type:** test
- **depends-on:** ["007"]
- **files:** `src/core/sync/queue.test.ts` (new)

## Objective

Write failing tests for the durable capture queue built on `wxt` `storage.defineItem('local:sync-queue')`.
Covers durable persistence, survival across a simulated service-worker recycle, flush-to-`syncItems`,
and dedupe.

**External-dependency isolation:** inject a fake storage (in-memory map) and a `SyncClient` **test
double**; no real `wxt` storage or Convex is touched. The recycle is simulated by discarding the
in-memory queue object and re-reading from the fake storage.

## BDD Scenario

```gherkin
Scenario: A capture is buffered durably
  Given an item is enqueued
  Then it is written to the durable local:sync-queue storage item

Scenario: The queue survives a service-worker recycle
  Given one item sits in the local:sync-queue
  When the in-memory queue is discarded and re-read from storage
  Then the item is still present

Scenario: Flush drains the queue into syncItems
  Given two items sit in the local:sync-queue
  When flush runs with a SyncClient double
  Then syncItems is called for both items
  And only successfully-synced items are removed from the queue

Scenario: A duplicate enqueue is deduped
  Given "m-1" is already queued
  When "m-1" is enqueued again
  Then the queue holds a single entry for "m-1"
```

## Steps

1. Build a fake storage with get/set + a `SyncClient` double (records calls; can be made to fail).
2. Assert enqueue persists; re-read after discard returns the entry.
3. Assert flush calls `syncItems` per item and removes only the synced ones; a failing client leaves
   the entry queued (state `failed`/`pending`).
4. Assert dedupe.

## Verification

- `bun run test src/core/sync` → new queue cases **FAIL** (module absent).
