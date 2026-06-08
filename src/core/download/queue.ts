import { Effect, Schedule } from 'effect'
import type { DownloadHandle, DownloadStrategy, SaveRequest } from './strategy'

/** Per-request result: whether it started, and (on success) the transfer handle. */
export interface RequestOutcome {
  readonly id: string
  readonly ok: boolean
  readonly handle?: DownloadHandle
}

export interface QueueResult {
  readonly completed: number
  readonly failed: number
  readonly total: number
  readonly outcomes: ReadonlyArray<RequestOutcome>
}

export interface DownloadQueueCore {
  readonly enqueue: (requests: ReadonlyArray<SaveRequest>) => Effect.Effect<QueueResult>
}

/**
 * Concurrency-bounded fire of `strategy.save` per request, each retried with a
 * bounded schedule. The browser (or aria2) owns the actual transfer (ADR-0002);
 * the background entrypoint drives progress/persistence via `downloads.onChanged`.
 * Returns a per-request outcome (with the started handle) so callers can map a
 * `downloadId` back to its request for monitoring.
 */
export function makeDownloadQueueCore(opts: {
  readonly strategy: DownloadStrategy
  readonly concurrency: number
  readonly retries?: number
}): DownloadQueueCore {
  const { strategy, concurrency, retries = 3 } = opts
  return {
    enqueue: (requests) =>
      Effect.gen(function* () {
        const outcomes = yield* Effect.forEach(
          requests,
          (req) =>
            strategy.save(req).pipe(
              Effect.retry(Schedule.recurs(retries)),
              Effect.map((handle): RequestOutcome => ({ id: req.id, ok: true, handle })),
              Effect.orElseSucceed((): RequestOutcome => ({ id: req.id, ok: false })),
            ),
          { concurrency },
        )
        const completed = outcomes.filter((o) => o.ok).length
        return { completed, failed: requests.length - completed, total: requests.length, outcomes }
      }),
  }
}
