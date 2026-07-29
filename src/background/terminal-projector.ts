import type { DailyBudgetStore } from './daily-budget-store'
import type { SyncOutbox } from './sync-outbox'
import type { HistoryAction } from '../core/history/action'
import {
  backlinkForTerminal,
  budgetCreditForTerminal,
  historyActionsForTerminal,
  syncEventsForTerminal,
  type TerminalProjection,
} from '../core/download/terminal-outcome'
import type { MediaItem, Settings, TransferOutcome } from '../core/schema'

export interface TerminalProjector {
  /** Runs durable sinks in order. A rejection leaves the registry row pending. */
  readonly project: (projection: TerminalProjection) => Promise<void>
}

export interface TerminalProjectorDeps {
  /** An adapter around Clear's ledger. Unowned browser transfers must no-op. */
  readonly clear: {
    readonly projectTerminal: (input: {
      readonly tweetId: string
      readonly requestId: string
      readonly downloadId: number
      readonly outcome: 'complete' | 'failed'
      readonly observedAt: number
    }) => Promise<void>
    readonly projectStartFailure: (input: {
      readonly tweetId: string
      readonly requestId: string
      readonly observedAt: number
    }) => Promise<void>
  }
  /** Fetched leases are keyed by the exact Chrome handle. */
  readonly releaseFetched: (downloadId: number) => Promise<void>
  readonly history: {
    /** Durable record and volatile cache update share one owner lane. */
    readonly projectTerminal: (projection: {
      readonly projectionId: string
      readonly actions: ReadonlyArray<HistoryAction>
      readonly completedItem?: MediaItem
    }) => Promise<void>
  }
  readonly sync: Pick<SyncOutbox, 'recordSync'>
  /** One snapshot per projection, only when there are Sync events to persist. */
  readonly settings: { readonly snapshot: () => Promise<Settings> }
  readonly budget: Pick<DailyBudgetStore, 'recordCompletion'>
  /** Volatile metrics owner; it serializes its own read-modify-write. */
  readonly metrics?: {
    readonly record: (
      requestId: string,
      outcome: 'complete' | 'failed',
      observedAt: number,
    ) => void | Promise<void>
  }
  readonly broadcast?: (outcome: TransferOutcome) => void | Promise<void>
  readonly trace?: (stage: string, projection: TerminalProjection) => void | Promise<void>
}

const ignoreFailure = (task: () => void | Promise<void>): void => {
  void Promise.resolve()
    .then(task)
    .catch(() => {})
}

/**
 * Projects a settled transfer into independent sinks. The caller acks the
 * registry only after this resolves. Every durable sink is idempotent on its
 * native key, so replay after a partial failure is safe.
 */
export const makeTerminalProjector = (deps: TerminalProjectorDeps): TerminalProjector => {
  const project = async (projection: TerminalProjection): Promise<void> => {
    const browserEvidence = projection.evidence.tag === 'browser' ? projection.evidence : undefined

    // Clear only understands a real Chrome download. aria2 and local start errors
    // must not fabricate one.
    if (browserEvidence !== undefined && projection.item !== undefined)
      await deps.clear.projectTerminal({
        tweetId: projection.item.postId,
        requestId: projection.requestId,
        downloadId: browserEvidence.downloadId,
        outcome: projection.outcome,
        observedAt: projection.observedAt,
      })
    else if (projection.evidence.tag === 'start-failed' && projection.item !== undefined)
      await deps.clear.projectStartFailure({
        tweetId: projection.item.postId,
        requestId: projection.requestId,
        observedAt: projection.observedAt,
      })

    const historyActions = historyActionsForTerminal(projection)
    const completedItem = projection.outcome === 'complete' ? projection.item : undefined
    if (historyActions.length > 0 || completedItem !== undefined)
      await deps.history.projectTerminal({
        projectionId: projection.projectionId,
        actions: historyActions,
        ...(completedItem === undefined ? {} : { completedItem }),
      })

    let settings: Settings | undefined
    if (projection.item !== undefined) {
      settings = await deps.settings.snapshot()
      const events = syncEventsForTerminal(projection, settings.cloudDeviceId)
      if (events.length > 0) await deps.sync.recordSync(events)
    }

    const credit = budgetCreditForTerminal(projection)
    if (
      credit !== undefined &&
      settings !== undefined &&
      (settings.dailyMaxMB > 0 || settings.dailyMaxCount > 0)
    )
      await deps.budget.recordCompletion(
        projection.projectionId,
        projection.observedAt,
        credit.bytes,
        credit.count,
      )

    // Keep the Blob lease until every durable terminal sink has committed. A
    // sink failure leaves the registry row pending; replay is idempotent.
    if (browserEvidence !== undefined && projection.mode === 'fetched')
      await deps.releaseFetched(browserEvidence.downloadId)

    // Volatile/UI projections run after durable truth. Their failures must never
    // hold a terminal row hostage or overwrite an absent metrics accumulator.
    if (deps.metrics !== undefined)
      ignoreFailure(() =>
        deps.metrics!.record(projection.requestId, projection.outcome, projection.observedAt),
      )
    const backlink = backlinkForTerminal(projection)
    if (backlink !== undefined && deps.broadcast !== undefined)
      ignoreFailure(() => deps.broadcast!(backlink))
    if (deps.trace !== undefined) ignoreFailure(() => deps.trace!('terminal-projected', projection))
  }

  return { project }
}
