/**
 * Terminal Outcome — the single decision a tracked browser transfer's final state
 * fans out into.
 *
 * After hand-off, the background SW observes a transfer's terminal state in
 * `downloads.onChanged` (bytes landed = `complete`, or `failed`). Recording it
 * touches five sinks: the Transfer Tracker (settle), the Metrics accumulator, the
 * Cloud Sync outbox, Download History, and the badge backlink (`TransferOutcome`).
 * That fan-out was hand-replicated in `completeBrowserDownload` /
 * `failBrowserDownload`; this module is the one place that decides it.
 *
 * Pure: it advances the in-memory reducers (`settleTransfer`, `recordOutcome`) and
 * returns the next state plus the I/O intents as plain data — the `OutcomeEffects`.
 * The background shell runs them in order (`applyOutcomeEffects`); that ordering and
 * the storage/broadcast I/O stay imperative (ADR-0014). aria2 hand-offs are terminal
 * at enqueue (ADR-0006) and never produce a Terminal Outcome — their fan-out (and a
 * failed-to-start's) is this module's sibling decision, `decideEnqueueOutcome`.
 *
 * Sidecar `.json` requests are not user media: they carry no badge and were never
 * mirrored at queue time, so they emit NO sync event and NO backlink. The history
 * transition and the tracker settle still run — both idempotent no-ops for an id
 * that was never queued/tracked — matching the pre-extraction behaviour exactly.
 */
import { recordOutcome } from './metrics'
import type { ItemOutcome, MetricsState } from './metrics'
import { settleTransfer } from './transfer-tracker'
import type { TrackerState } from './transfer-tracker'
import { outcomeEvent } from '../sync/events'
import type { SyncEvent } from '../sync/events'
import type { HistoryAction } from '../history/wiring'
import type { TransferOutcome } from '../schema'

/** A tracked browser transfer's final state. Equals `TransferOutcome.outcome`. */
export type TerminalOutcome = ItemOutcome // 'complete' | 'failed'

/** The outcome-bearing state the decision reads and advances. */
export interface OutcomeState {
  readonly transfers: TrackerState
  /** The live metrics accumulator, or `null` after an SW recycle (no delta then). */
  readonly metrics: MetricsState | null
}

/** Everything one Terminal Outcome must record, as data for the shell to execute. */
export interface OutcomeEffects {
  readonly transfers: TrackerState
  readonly metrics: MetricsState | null
  readonly syncEvents: ReadonlyArray<SyncEvent>
  readonly historyActions: ReadonlyArray<HistoryAction>
  readonly backlink: TransferOutcome | null
  readonly clearNotice: ClearNotice | null
  readonly postSavedMark: PostSavedMark | null
  readonly mediaSavedMark: MediaSavedMark | null
  readonly budgetBump: BudgetBump | null
  readonly persistSnapshot: true
}

export type ClearNotice =
  | {
      readonly outcome: 'complete'
      readonly tweetId: string
      readonly requestId: string
      readonly downloadId: number
    }
  | {
      readonly outcome: 'failed'
      readonly tweetId: string
      readonly requestId: string
    }

export interface PostSavedMark {
  readonly tweetId: string
}

export interface MediaSavedMark {
  readonly requestId: string
}

export interface BudgetBump {
  readonly bytes: number
  readonly count: 1
}

export interface OutcomeContext {
  readonly tweetId?: string
  readonly downloadId: number
}

const isSidecar = (id: string): boolean => id.endsWith('.json')

/** Map a terminal outcome to the past-tense kind the sync/history sinks use. */
const recordedKind = (outcome: TerminalOutcome): 'completed' | 'failed' =>
  outcome === 'complete' ? 'completed' : 'failed'

/**
 * Decide the full fan-out for one Terminal Outcome. Idempotent on `id`: the
 * underlying `settleTransfer` / `recordOutcome` are no-ops the second time, so a
 * duplicate `onChanged` terminal can never double-count or re-settle.
 */
export function decideTerminalOutcome(
  state: OutcomeState,
  id: string,
  outcome: TerminalOutcome,
  now: number,
  deviceId: string,
  context?: OutcomeContext,
): OutcomeEffects {
  const kind = recordedKind(outcome)
  const metrics = state.metrics === null ? null : recordOutcome(state.metrics, id, outcome, now)
  const sidecar = isSidecar(id)
  const complete = outcome === 'complete'
  const tweetId = context?.tweetId
  const metricsTransitioned = state.metrics !== null && metrics !== state.metrics
  const progress = state.metrics?.items.get(id)
  const bytes = progress
    ? progress.totalBytes > 0
      ? progress.totalBytes
      : progress.bytesReceived
    : 0
  const clearNotice: ClearNotice | null =
    sidecar || context === undefined || context.tweetId === undefined
      ? null
      : complete
        ? {
            outcome: 'complete',
            tweetId: context.tweetId,
            requestId: id,
            downloadId: context.downloadId,
          }
        : { outcome: 'failed', tweetId: context.tweetId, requestId: id }
  return {
    transfers: settleTransfer(state.transfers, id),
    metrics,
    syncEvents: sidecar ? [] : [outcomeEvent(id, kind, deviceId, now)],
    historyActions: [{ kind, requestId: id, at: now }],
    backlink: sidecar ? null : { _tag: 'TransferOutcome', requestId: id, outcome, at: now },
    clearNotice,
    postSavedMark: !sidecar && complete && tweetId !== undefined ? { tweetId } : null,
    mediaSavedMark: !sidecar && complete ? { requestId: id } : null,
    budgetBump:
      !sidecar && complete && tweetId !== undefined && metricsTransitioned
        ? { bytes, count: 1 }
        : null,
    persistSnapshot: true,
  }
}

/** Everything one outcome terminal AT ENQUEUE (failed-to-start, aria2 hand-off —
 *  no downloadId ever issued, so no Transfer Tracker entry either) must record.
 *  No `backlink` field at all, unlike `OutcomeEffects`: ADR-0014 gives a badge
 *  backlink only to a transfer that got a Download Handle, and this one never did
 *  — the absence is structural, not a suppressed value. */
export interface EnqueueOutcomeEffects {
  readonly syncEvent: SyncEvent | null
  readonly historyAction: HistoryAction
}

/** Same sidecar policy as `decideTerminalOutcome`: sync event suppressed, history
 *  recorded regardless (sidecar history is an idempotent no-op downstream for an
 *  id that was never queued). The metrics delta is the caller's `outcome` verbatim
 *  — nothing to decide, so it is not echoed back here. */
export function decideEnqueueOutcome(args: {
  readonly id: string
  readonly outcome: TerminalOutcome
  readonly now: number
  readonly deviceId: string
}): EnqueueOutcomeEffects {
  const { id, outcome, now, deviceId } = args
  const kind = recordedKind(outcome)
  return {
    syncEvent: isSidecar(id) ? null : outcomeEvent(id, kind, deviceId, now),
    historyAction: { kind, requestId: id, at: now },
  }
}
