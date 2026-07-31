import { Effect, Schedule } from 'effect'
import type { DownloadHandle, DownloadStrategy, SaveRequest } from './strategy'

/** Per-request result: whether it started, and (on success) the transfer handle
 *  or (on failure) the `DownloadError.reason` that caused it — the concrete
 *  "why didn't this download?" answer, not just a bare `ok: false`. */
export interface RequestOutcome {
  readonly id: string
  readonly ok: boolean
  readonly handle?: DownloadHandle
  readonly error?: string
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
  /** Exponential backoff base for save-start retries (ms). Tests pass a small value. */
  readonly retryBaseMs?: number
}): DownloadQueueCore {
  const { strategy, concurrency, retries = 3, retryBaseMs = 500 } = opts
  // Exponential backoff (base·2ⁿ) bounded to `retries` attempts. A bare
  // `Schedule.recurs(n)` retries with ZERO spacing, so a flapping twimg CDN gets
  // hammered back-to-back; spacing the save-start retry (the SW fetch under the
  // Fetched strategy, the aria2 RPC) is what was missing. The transfer-level
  // backoff for an interrupted browser download still lives in interrupt-retry.
  const retrySchedule = Schedule.exponential(`${retryBaseMs} millis`, 2).pipe(
    Schedule.both(Schedule.recurs(retries)),
  )
  return {
    enqueue: (requests) =>
      Effect.gen(function* () {
        const outcomes = yield* Effect.forEach(
          requests,
          (req) =>
            strategy.save(req).pipe(
              Effect.retry(retrySchedule),
              // The DownloadError's own `reason` is the actual "why". Surfacing
              // that reason — rather than collapsing every failure to a bare
              // `ok: false`, as the prior `orElseSucceed`-based recovery did
              // with no access to the error value at all — is what makes a
              // failed hand-off debuggable from outside the SW's own console.
              Effect.match({
                onFailure: (error): RequestOutcome => ({
                  id: req.id,
                  ok: false,
                  error: error.reason,
                }),
                onSuccess: (handle): RequestOutcome => ({ id: req.id, ok: true, handle }),
              }),
            ),
          { concurrency },
        )
        const completed = outcomes.filter((o) => o.ok).length
        return { completed, failed: requests.length - completed, total: requests.length, outcomes }
      }),
  }
}
