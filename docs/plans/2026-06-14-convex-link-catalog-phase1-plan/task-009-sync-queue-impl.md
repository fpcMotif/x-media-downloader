# Task 009 — Durable local:sync-queue (impl / Green)

- **type:** impl
- **depends-on:** ["008"]
- **files:** `src/core/sync/queue.ts` (new)

## Objective

Implement the durable queue + flush orchestration on top of the pure core (007). Persists captures to
a `wxt` storage item so they survive an MV3 service-worker recycle; `flush` drains to a `SyncClient`,
removing only entries that synced successfully and recording per-item state for the rollup. Storage
and clock are injected so the unit tests use doubles.

## Contracts (signatures only — no bodies)

```ts
export interface FlushResult { attempted: number; synced: number; failed: number }

export interface SyncQueue {
  enqueue(item: MediaItem, source: CaptureSource): Promise<void>  // dedup via dedupeQueue
  read(): Promise<CaptureEntry[]>
  flush(client: SyncClient): Promise<FlushResult>
}

export function makeSyncQueue(deps: {
  storage: { get(): Promise<CaptureEntry[]>; set(v: CaptureEntry[]): Promise<void> }
  now: () => number
}): SyncQueue
```

## BDD Scenario

```gherkin
Scenario: Flush drains the queue into syncItems
  Given two items sit in the local:sync-queue
  When flush runs with a SyncClient double
  Then syncItems is called for both items
  And only successfully-synced items are removed from the queue

Scenario: The queue survives a service-worker recycle
  Given one item sits in the local:sync-queue
  When the in-memory queue is discarded and re-read from storage
  Then the item is still present
```

## Steps

1. Back `read`/`set` with the injected storage (real wiring uses `storage.defineItem('local:sync-queue')`).
2. `enqueue` → `dedupeQueue` then persist.
3. `flush` → batch entries into one `client.syncItems` call (or per-item), remove synced, keep failed.

## Verification

- `bun run test src/core/sync` → **GREEN**.
- `bun run typecheck` passes.
