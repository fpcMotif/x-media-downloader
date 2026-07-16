import type { MetricsState } from '../core/download/metrics'
import type { EnqueueOutcomeEffects, OutcomeEffects } from '../core/download/terminal-outcome'
import type { TrackerState } from '../core/download/transfer-tracker'
import type { HistoryAction } from '../core/history/wiring'
import type { SyncEvent } from '../core/sync/events'
import type { TransferOutcome } from '../core/schema'

/** I/O shell for one browser Terminal Outcome. */
export interface OutcomeEffectPorts {
  readonly recordClearComplete: (tweetId: string, requestId: string, downloadId: number) => void
  readonly recordClearFailure: (tweetId: string, requestId: string) => void
  readonly setTransfers: (state: TrackerState) => void
  readonly setMetrics: (state: MetricsState | null) => void
  readonly flushTransfers: () => Promise<unknown>
  readonly reportBacklink: (outcome: TransferOutcome) => void
  readonly recordSync: (events: ReadonlyArray<SyncEvent>) => void
  readonly recordHistory: (actions: ReadonlyArray<HistoryAction>) => void
  readonly markPostSaved: (tweetId: string) => void
  readonly bumpBudget: (bytes: number, count: number) => void
  readonly markMediaSaved: (requestId: string) => void
  readonly persistSnapshot: (now: number) => Promise<void>
}

export interface EnqueueOutcomeEffectPorts {
  readonly setMetrics: (state: MetricsState) => void
  readonly recordSyncEvent: (event: SyncEvent) => void
  readonly recordHistoryAction: (action: HistoryAction) => void
  readonly markPostSaved: (tweetId: string) => void
  readonly bumpBudget: (bytes: number, count: number) => void
  readonly markMediaSaved: (requestId: string) => void
}

/** Apply Terminal Outcome effects in the fixed durable-write order. */
export async function applyOutcomeEffects(
  effects: OutcomeEffects,
  ports: OutcomeEffectPorts,
  now: number,
): Promise<void> {
  const clear = effects.clearNotice
  if (clear?.outcome === 'complete')
    ports.recordClearComplete(clear.tweetId, clear.requestId, clear.downloadId)
  else if (clear?.outcome === 'failed') ports.recordClearFailure(clear.tweetId, clear.requestId)

  ports.setTransfers(effects.transfers)
  ports.setMetrics(effects.metrics)
  await ports.flushTransfers()

  if (effects.backlink) ports.reportBacklink(effects.backlink)
  ports.recordSync(effects.syncEvents)
  ports.recordHistory(effects.historyActions)
  if (effects.postSavedMark) ports.markPostSaved(effects.postSavedMark.tweetId)
  if (effects.budgetBump) ports.bumpBudget(effects.budgetBump.bytes, effects.budgetBump.count)
  if (effects.mediaSavedMark) ports.markMediaSaved(effects.mediaSavedMark.requestId)
  if (effects.persistSnapshot) await ports.persistSnapshot(now)
}

/** Apply a failed start or aria2 hand-off. No Clear or backlink exists here. */
export function applyEnqueueOutcomeEffects(
  effects: EnqueueOutcomeEffects,
  ports: EnqueueOutcomeEffectPorts,
): void {
  ports.setMetrics(effects.metrics)
  if (effects.syncEvent) ports.recordSyncEvent(effects.syncEvent)
  ports.recordHistoryAction(effects.historyAction)
  if (effects.postSavedMark) ports.markPostSaved(effects.postSavedMark.tweetId)
  if (effects.budgetBump) ports.bumpBudget(effects.budgetBump.bytes, effects.budgetBump.count)
  if (effects.mediaSavedMark) ports.markMediaSaved(effects.mediaSavedMark.requestId)
}
