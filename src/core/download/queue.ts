import { Effect, Schedule } from 'effect'
import type { MediaItem } from '../schema'
import type { DownloadStrategy } from './strategy'

export interface QueueResult {
  readonly completed: number
  readonly failed: number
  readonly total: number
}

export interface DownloadQueueCore {
  readonly enqueue: (
    items: ReadonlyArray<MediaItem>,
    filenameFor: (item: MediaItem) => string,
  ) => Effect.Effect<QueueResult>
}

/**
 * Concurrency-bounded fire of `strategy.save` per item, each retried with a
 * bounded schedule. The browser owns the actual transfer (ADR-0002); the
 * background entrypoint drives progress/persistence via `downloads.onChanged`.
 */
export function makeDownloadQueueCore(opts: {
  readonly strategy: DownloadStrategy
  readonly concurrency: number
  readonly retries?: number
}): DownloadQueueCore {
  const { strategy, concurrency, retries = 3 } = opts
  return {
    enqueue: (items, filenameFor) =>
      Effect.gen(function* () {
        const outcomes = yield* Effect.forEach(
          items,
          (item) =>
            strategy.save(item, filenameFor(item)).pipe(
              Effect.retry(Schedule.recurs(retries)),
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            ),
          { concurrency },
        )
        const completed = outcomes.filter(Boolean).length
        return { completed, failed: items.length - completed, total: items.length }
      }),
  }
}
