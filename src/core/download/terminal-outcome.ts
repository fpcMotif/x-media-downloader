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
 * at enqueue (ADR-0006) and never produce a Terminal Outcome.
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
  readonly persistSnapshot: true
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
): OutcomeEffects {
  const kind = recordedKind(outcome)
  return {
    transfers: settleTransfer(state.transfers, id),
    metrics: state.metrics === null ? null : recordOutcome(state.metrics, id, outcome, now),
    syncEvents: isSidecar(id) ? [] : [outcomeEvent(id, kind, deviceId, now)],
    historyActions: [{ kind, requestId: id, at: now }],
    backlink: isSidecar(id) ? null : { _tag: 'TransferOutcome', requestId: id, outcome, at: now },
    persistSnapshot: true,
  }
}
