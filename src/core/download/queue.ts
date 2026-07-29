import { Cause, Effect, Schedule } from 'effect'
import { boundedDiagnosticText } from '../diagnostic-text'
import type { DownloadError } from '../errors'
import { MAX_FAILURE_REASON_LENGTH } from '../schema/download'
import type { DownloadHandle, DownloadStrategy, SaveRequest } from './strategy'

/** Queue outcomes cross the runtime wire through QueueUpdate. Bound every
 * strategy/preflight/commit error at this single ownership seam. */
const failureReason = (reason: string): string =>
  boundedDiagnosticText(reason === '' ? 'download failed' : reason, MAX_FAILURE_REASON_LENGTH)

/** Per-request result: whether it started, and (on success) the transfer handle
 *  or (on failure) the `DownloadError.reason` that caused it — the concrete
 *  "why didn't this download?" answer, not just a bare `ok: false`. */
export type RequestOutcome =
  | {
      /** Fetched capacity is full; a durable registry retry owns this launch. */
      readonly id: string
      readonly ok: false
      readonly status: 'deferred'
      readonly error: string
    }
  | {
      readonly id: string
      readonly ok: true
      readonly status: 'started'
      readonly handle: DownloadHandle
    }
  | {
      readonly id: string
      readonly ok: false
      readonly status: 'start-failed'
      readonly error: string
    }
  | {
      /** The browser handoff may have happened, but no handle was returned. */
      readonly id: string
      readonly ok: false
      readonly status: 'ambiguous-start'
      readonly error: string
    }
  | {
      /** The browser accepted the download, but its durable handle write failed. */
      readonly id: string
      readonly ok: false
      readonly status: 'untracked-start'
      readonly handle: DownloadHandle
      readonly error: string
    }

/** Persist a started handle before the queue admits its outcome. */
export type StartedCommit = (
  request: SaveRequest,
  handle: DownloadHandle,
) => Effect.Effect<void, unknown>
/** One durable preflight, outside save retries (e.g. aria2 call arm). */
export type BeforeStart = (request: SaveRequest) => Effect.Effect<void, DownloadError>

export interface QueueResult {
  /** Transfers the strategy accepted and handed off; not terminal completions. */
  readonly started: number
  /** Starts durably deferred for Fetched capacity; not failed handoffs. */
  readonly deferred: number
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
  /** false means this request has an at-most-once start boundary (aria2). */
  readonly retryStart?: (request: SaveRequest) => boolean
  /** Runs once, immediately before save; failures never invoke the strategy. */
  readonly beforeStart?: BeforeStart
  /** Awaited after a successful save. It is deliberately outside save retries. */
  readonly onStarted?: StartedCommit
}): DownloadQueueCore {
  const {
    strategy,
    concurrency,
    retries = 3,
    retryBaseMs = 500,
    onStarted,
    retryStart,
    beforeStart,
  } = opts
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
            (beforeStart === undefined ? Effect.void : beforeStart(req)).pipe(
              Effect.andThen(
                retryStart?.(req) === false
                  ? strategy.save(req)
                  : strategy.save(req).pipe(
                      Effect.retry({
                        while: (error) => error.retryable !== false,
                        schedule: retrySchedule,
                      }),
                    ),
              ),
              // Surface the DownloadError's `reason` so failed hand-offs remain
              // debuggable outside the SW console. The prior `orElseSucceed`
              // recovery collapsed every failure to `ok: false` and discarded
              // the error value.
              Effect.matchEffect({
                onFailure: (error): Effect.Effect<RequestOutcome> =>
                  Effect.succeed({
                    id: req.id,
                    ok: false,
                    status:
                      error.certainty === 'ambiguous-handoff'
                        ? 'ambiguous-start'
                        : error.certainty === 'deferred-capacity'
                          ? 'deferred'
                          : 'start-failed',
                    error: failureReason(error.reason),
                  }),
                onSuccess: (handle): Effect.Effect<RequestOutcome> =>
                  (onStarted ? onStarted(req, handle) : Effect.void).pipe(
                    // This runs after the retried save succeeds, not inside that
                    // retry. A failed durable bind therefore never starts a second
                    // browser download whose first handle is untracked.
                    Effect.matchCause({
                      onFailure: (cause): RequestOutcome => {
                        const error = Cause.squash(cause)
                        return {
                          id: req.id,
                          ok: false,
                          status: 'untracked-start',
                          handle,
                          error: failureReason(
                            error instanceof Error ? error.message : String(error),
                          ),
                        }
                      },
                      onSuccess: (): RequestOutcome => ({
                        id: req.id,
                        ok: true,
                        status: 'started',
                        handle,
                      }),
                    }),
                  ),
              }),
            ),
          { concurrency },
        )
        const started = outcomes.filter((o) => o.ok).length
        const deferred = outcomes.filter((outcome) => outcome.status === 'deferred').length
        return {
          started,
          deferred,
          failed: requests.length - started - deferred,
          total: requests.length,
          outcomes,
        }
      }),
  }
}
