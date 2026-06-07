# Task 007 — DownloadQueue (impl)

**type:** impl
**depends-on:** ["007-download-queue-test"]

## Contract

```ts
export class DownloadQueue extends Effect.Service<DownloadQueue>()("DownloadQueue", {
  // enqueue: (items: MediaItem[]) => Effect<void>
  // progress: Stream<QueueUpdate>
}) {} // deps: SettingsService (concurrency, template)
```

## Files

- `src/core/download/queue.ts`

## Steps

1. `Effect.forEach(items, downloadOne, { concurrency })` gated by a `Semaphore`
   sized from settings.
2. `downloadOne`: render filename, call `chrome.downloads.download` with
   `conflictAction: "uniquify"`; wrap in `Schedule.exponential` retry (cap attempts).
3. Publish `QueueUpdate` to a `PubSub`/`Stream` consumers can subscribe to.

## Verification

- `bun test src/core/download/queue` — all green.
