import type { DownloadTraceEntry, MediaItem } from '../core/schema'
import { planInterruptRetry, type PendingInterruptRetry } from '../core/download/interrupt-retry'

/** Browser download metadata for interrupted auto-retry (url/filename + attempt).
 *  Mirrors background.ts's own `RequestMeta` — re-declared here (not imported) so
 *  this module has no dependency on background.ts (that would invert the seam). */
export interface RequestMeta {
  readonly url: string
  readonly filename: string
  readonly item?: MediaItem
}

export interface CancelHandle {
  (): void
}

export interface RetryClock {
  readonly schedule: (fn: () => void, ms: number) => CancelHandle
}

/** The real clock: wraps `setTimeout`/`clearTimeout`. Used when no `clock` dep is
 *  supplied — tests inject a hand-rolled fake instead (see retry-plan.test.ts). */
const realClock: RetryClock = {
  schedule: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    return () => clearTimeout(handle)
  },
}

export interface RetryPlanApplierDeps {
  readonly interruptAttemptById: Map<string, number>
  readonly pendingRetries: Map<string, PendingInterruptRetry>
  readonly syncPendingRetries: () => void
  /** Wraps `if (live) live = recordRetry(live, id)` — the applier never reaches
   *  into the module-level `live` variable directly. */
  readonly recordRetry: (id: string) => void
  readonly trace: (stage: string, opts?: Omit<DownloadTraceEntry, 'source' | 'stage' | 't'>) => void
  readonly persistSnapshot: (now: number) => Promise<void>
  readonly failBrowserDownload: (id: string, downloadId: number, now: number) => Promise<void>
  /** Re-entry point: `(id) => void fireInterruptRetry(id)`. Kept as a dep (rather
   *  than an import) so this module never depends on background.ts. */
  readonly fire: (id: string) => void
  /** Injected timer port. Defaults to the real `setTimeout`/`clearTimeout` wrapper
   *  when omitted — tests supply a hand-rolled fake instead. */
  readonly clock?: RetryClock
}

export interface ApplyRetryPlanArgs {
  readonly id: string
  /** Sentinel (e.g. -1) when no live download handle exists yet. */
  readonly downloadId: number
  readonly url: string
  readonly filename: string
  readonly item?: MediaItem
  readonly reason: string | undefined
  readonly now: number
  /** Overrides the trace-log vocabulary term (defaults to `reason ?? 'unknown'`).
   *  `fireInterruptRetry`'s catch passes `'start-failed'` here to keep "launch
   *  itself threw" distinguishable in the trace stream from an ordinary
   *  onChanged-driven interrupt of an already-launched download. */
  readonly traceLabel?: string
  /** Synchronous hook invoked exactly when apply() decides to schedule a retry,
   *  before any state mutation (including the internal `await persistSnapshot`).
   *  Lets a caller keep its own ledger-settle atomic with the decision instead of
   *  deferring it into a `.then()` after apply()'s async work resolves. */
  readonly onScheduled?: () => void
}

export interface RetryPlanApplier {
  /** Compute attempt, decide via planInterruptRetry, and either schedule a retry
   *  (state + timer + trace + persist) or call failBrowserDownload. Returns
   *  whether a retry was scheduled. */
  readonly apply: (args: ApplyRetryPlanArgs) => Promise<boolean>
  /** Re-arm a durable row's timer on boot (rehydrateInterruptRetries' timer triad
   *  only — row restoration stays in background.ts). */
  readonly rehydrateTimer: (row: PendingInterruptRetry, now: number) => void
  /** Cancel + drop a pending retry's TIMER ONLY (wraps the current clearRetryTimeout).
   *  Does NOT touch pendingRetries/interruptAttemptById/requestMetaById — those stay
   *  owned by background.ts's existing clearInterruptRetryState. */
  readonly cancel: (id: string) => void
}

export const makeRetryPlanApplier = (deps: RetryPlanApplierDeps): RetryPlanApplier => {
  const {
    interruptAttemptById,
    pendingRetries,
    syncPendingRetries,
    recordRetry,
    trace,
    persistSnapshot,
    failBrowserDownload,
    fire,
  } = deps
  const clock = deps.clock ?? realClock

  // Private factory state: the retry-specific timer map (was `retryTimeouts` /
  // `clearRetryTimeout` in background.ts). Keyed by the CancelHandle the clock
  // hands back, not a raw setTimeout handle.
  const retryTimers = new Map<string, CancelHandle>()

  const cancel = (id: string): void => {
    const handle = retryTimers.get(id)
    if (handle !== undefined) {
      handle()
      retryTimers.delete(id)
    }
  }

  const arm = (id: string, delayMs: number): void => {
    cancel(id)
    const handle = clock.schedule(() => fire(id), delayMs)
    retryTimers.set(id, handle)
  }

  const apply = async (args: ApplyRetryPlanArgs): Promise<boolean> => {
    const { id, downloadId, url, filename, item, reason, now, traceLabel, onScheduled } = args
    const attempt = interruptAttemptById.get(id) ?? 0
    const plan = planInterruptRetry({ reason, attempt })
    if (!plan.schedule) {
      await failBrowserDownload(id, downloadId, now)
      return false
    }

    onScheduled?.()

    interruptAttemptById.set(id, plan.nextAttempt)
    recordRetry(id)

    const nextRetryAt = now + plan.delayMs
    pendingRetries.set(id, {
      id,
      url,
      filename,
      attempt: plan.nextAttempt,
      nextRetryAt,
      ...(item ? { item } : {}),
    })
    syncPendingRetries()

    arm(id, plan.delayMs)

    trace('interrupt-retry-scheduled', {
      itemId: id,
      detail: `${traceLabel ?? reason ?? 'unknown'} in ${plan.delayMs}ms attempt ${plan.nextAttempt}`,
    })
    await persistSnapshot(now)
    return true
  }

  const rehydrateTimer = (row: PendingInterruptRetry, now: number): void => {
    const delay = Math.max(0, row.nextRetryAt - now)
    arm(row.id, delay)
  }

  return { apply, rehydrateTimer, cancel }
}
