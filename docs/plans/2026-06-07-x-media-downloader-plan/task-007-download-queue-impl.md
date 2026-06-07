# Task 007 — DownloadQueue (impl)

**type:** impl
**depends-on:** ["007-download-queue-test"]

> Follows docs/research/2026-06-07-grounding.md §(b),(d),(f). The MV3 SW dies
> after 30s idle and loses in-memory state, so the queue FIRES downloads and
> TRACKS them via events — it never awaits file completion inside one handler.

## Contract (Effect v4 — `Context.Service` + explicit `Layer`)

```ts
import { Context, Data, Effect, Layer, Schedule, Semaphore } from 'effect'

class DownloadError extends Data.TaggedError('DownloadError')<{
  readonly id: string; readonly reason: string
}> {}

class DownloadQueue extends Context.Service<DownloadQueue, {
  readonly enqueue: (items: ReadonlyArray<MediaItem>) => Effect.Effect<void, DownloadError>
  readonly snapshot: Effect.Effect<QueueState>          // popup reads this (from storage)
}>()('app/DownloadQueue') {}

export const DownloadQueueLive = Layer.effect(
  DownloadQueue,
  Effect.gen(function* () {
    const settings = yield* SettingsService
    const sem = yield* Semaphore.make(/* concurrency from settings */ 3)
    return { /* ... */ }
  }),
).pipe(Layer.provide(SettingsServiceLive))
```

## Files

- `src/core/download/queue.ts`

## Steps

1. `enqueue` bounds in-flight `browser.downloads.download()` STARTS with the
   `Semaphore` (not awaited completions). `downloadOne` renders the filename,
   fires `download({ url, filename, conflictAction: 'uniquify' })`, persists
   `{ downloadId, status, filename }` to `chrome.storage`. Wrap the START in
   `Effect.retry(Schedule.exponential('100 millis', 2).pipe(Schedule.both(Schedule.recurs(3))))`.
2. Progress/retry is driven by the background's top-level
   `browser.downloads.onChanged` listener (registered in task 012): resolve a
   per-`downloadId` `Deferred`, update persisted state on `complete | interrupted`
   (map `SERVER_FORBIDDEN`/`NETWORK_TIMEOUT` → retry/backoff).
3. Byte progress is NOT in `onChanged` → poll `browser.downloads.search({ id })`
   (`bytesReceived`/`totalBytes`; guard `totalBytes === -1`).
4. `QueueUpdate` (completed/total) is derived from persisted state; the popup
   reads it via messaging — never an in-SW `Stream` (dies on recycle).

## Verification

- `bun test src/core/download/queue` — all green (incl. the SW-restart rehydrate scenario).
