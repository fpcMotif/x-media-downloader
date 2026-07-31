import type { DownloadTraceEntry, MediaItem } from '@/packages/schema'
import {
  isRetryableInterruptReason,
  planInterruptRetry,
  type PendingInterruptRetry,
} from './interrupt-retry'

/** Durable mirror seam (`session:interruptRetries`). `set` is fire-and-forget —
 *  the queue never awaits it, matching today's `syncPendingRetries` semantics. */
export interface RetryQueueStore {
  readonly get: () => Promise<ReadonlyArray<PendingInterruptRetry>>
  readonly set: (rows: ReadonlyArray<PendingInterruptRetry>) => void
}

export interface RetryClock {
  readonly schedule: (fn: () => void, ms: number) => () => void
}

/** The real clock: wraps `setTimeout`/`clearTimeout`. Used when no `clock` dep is
 *  supplied — tests inject a hand-rolled fake instead (see retry-queue.test.ts). */
const realClock: RetryClock = {
  schedule: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    return () => clearTimeout(handle)
  },
}

export interface RetryQueueDeps {
  readonly store: RetryQueueStore
  /** Injected timer port. Defaults to the real `setTimeout`/`clearTimeout` wrapper
   *  when omitted — tests supply a hand-rolled fake instead. */
  readonly clock?: RetryClock
  /** Wraps `if (live) live = recordRetry(live, id)` — the queue never reaches into
   *  the caller's module-level `live` variable directly. */
  readonly recordRetry: (id: string) => void
  readonly trace: (stage: string, opts?: Omit<DownloadTraceEntry, 'source' | 'stage' | 't'>) => void
  readonly persistSnapshot: (now: number) => Promise<void>
  readonly failBrowserDownload: (id: string, downloadId: number, now: number) => Promise<void>
  /** Re-entry point: `(id) => void fireInterruptRetry(id)`. Kept as a dep (rather
   *  than an import) so this module never depends on background.ts. */
  readonly fire: (id: string) => void
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
  /** Synchronous hook invoked exactly when schedule() decides to schedule a retry,
   *  before any state mutation (including the internal `await persistSnapshot`).
   *  Lets a caller keep its own ledger-settle atomic with the decision instead of
   *  deferring it into a `.then()` after schedule()'s async work resolves. */
  readonly onScheduled?: () => void
}

export interface RetryQueue {
  /** Decide via planInterruptRetry; on schedule ⇒ set attempt + row + timer +
   *  mirror atomically (onScheduled hook FIRST, before any mutation); on refuse ⇒
   *  failBrowserDownload, return false. */
  readonly schedule: (args: ApplyRetryPlanArgs) => Promise<boolean>
  readonly has: (id: string) => boolean
  readonly ownedIds: () => ReadonlySet<string>
  /** fire-path: cancel timer + delete row + mirror. KEEPS the attempt counter —
   *  deliberately different from forget (attempts survive until settle). */
  readonly drop: (id: string) => void
  /** settle-path: cancel + delete row AND attempt counter + mirror. */
  readonly forget: (id: string) => void
  /** boot: read the mirror, restore attempt + row, arm each timer; returns the rows
   *  so the caller seeds its own requestMetaById/inFlight and persists meta once. */
  readonly rehydrate: (now: number) => Promise<ReadonlyArray<PendingInterruptRetry>>
  /** manual reset: cancel every timer, clear both maps, empty the mirror. */
  readonly cancelAll: () => void
}

/**
 * One owner for the interrupt-retry state machine: the attempt counter, the queue
 * row, the live timer, and the durable mirror move together through this module.
 *
 * Invariants (owned here, not spread across the caller):
 *  - every row in the row map has exactly one live timer in the timer map;
 *  - a row and its attempt counter mutate together through schedule/forget;
 *  - `drop` removes the row + timer but KEEPS the attempt counter, so a re-schedule
 *    after a fired retry resumes from the accumulated attempt (the counter only
 *    resets at settle, via `forget`).
 *
 * `drop`'s remove-before-track window: the fire-path calls `drop` BEFORE adding the
 * id to the transfers ledger, so a crash between the two leaves the id in NEITHER
 * ledger — a lost retry, never a double-drive where both rehydrate and reconcile
 * fire the same id on the next boot.
 */
export function makeRetryQueue(deps: RetryQueueDeps): RetryQueue {
  const { store, recordRetry, trace, persistSnapshot, failBrowserDownload, fire } = deps
  const clock = deps.clock ?? realClock

  // Module-private state — the attempt counter, the queue row, and the live timer.
  // The timer map is keyed by the cancel handle the clock hands back, not a raw
  // setTimeout handle.
  const attemptById = new Map<string, number>()
  const rowById = new Map<string, PendingInterruptRetry>()
  const timerById = new Map<string, () => void>()

  const syncMirror = (): void => {
    store.set([...rowById.values()])
  }

  const cancel = (id: string): void => {
    const handle = timerById.get(id)
    if (handle !== undefined) {
      handle()
      timerById.delete(id)
    }
  }

  const arm = (id: string, delayMs: number): void => {
    cancel(id)
    timerById.set(
      id,
      clock.schedule(() => fire(id), delayMs),
    )
  }

  const schedule = async (args: ApplyRetryPlanArgs): Promise<boolean> => {
    const { id, downloadId, url, filename, item, reason, now, traceLabel, onScheduled } = args
    const attempt = attemptById.get(id) ?? 0
    const plan = planInterruptRetry({ reason, attempt })
    if (!plan.schedule) {
      // Chrome's own `InterruptReason` — the one piece of evidence for WHY this
      // browser transfer died — was previously dropped right here: the eventual
      // `browser-failed` trace `failBrowserDownload` fires only carries the
      // downloadId, not this reason. `SERVER_FORBIDDEN`/`SERVER_UNAUTHORIZED`
      // (both deliberately non-retryable, see interrupt-retry.ts's own doc) are
      // exactly what an expired Meta CDN url returns — this is the trace that
      // lets a live session tell "abandoned because the CDN url was already
      // dead" apart from "abandoned because retries ran out on a flaky network".
      trace('interrupt-retry-abandoned', {
        itemId: id,
        detail: `reason=${reason ?? 'unknown'} attempt=${attempt} retryable=${isRetryableInterruptReason(reason)}`,
      })
      await failBrowserDownload(id, downloadId, now)
      return false
    }

    onScheduled?.()

    attemptById.set(id, plan.nextAttempt)
    recordRetry(id)

    rowById.set(id, {
      id,
      url,
      filename,
      attempt: plan.nextAttempt,
      nextRetryAt: now + plan.delayMs,
      ...(item ? { item } : {}),
    })
    syncMirror()

    arm(id, plan.delayMs)

    trace('interrupt-retry-scheduled', {
      itemId: id,
      detail: `${traceLabel ?? reason ?? 'unknown'} in ${plan.delayMs}ms attempt ${plan.nextAttempt}`,
    })
    await persistSnapshot(now)
    return true
  }

  const drop = (id: string): void => {
    cancel(id)
    rowById.delete(id)
    syncMirror()
  }

  const forget = (id: string): void => {
    cancel(id)
    rowById.delete(id)
    attemptById.delete(id)
    syncMirror()
  }

  const rehydrate = async (now: number): Promise<ReadonlyArray<PendingInterruptRetry>> => {
    const rows = await store.get()
    for (const row of rows) {
      attemptById.set(row.id, row.attempt)
      rowById.set(row.id, row)
      arm(row.id, Math.max(0, row.nextRetryAt - now))
    }
    return rows
  }

  const cancelAll = (): void => {
    for (const handle of timerById.values()) handle()
    timerById.clear()
    rowById.clear()
    attemptById.clear()
    syncMirror()
  }

  return {
    schedule,
    has: (id) => rowById.has(id),
    ownedIds: () => new Set(rowById.keys()),
    drop,
    forget,
    rehydrate,
    cancelAll,
  }
}
