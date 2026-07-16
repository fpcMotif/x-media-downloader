import type { ClearSeedVerdict } from '../core/clear/seed'
import type { HistoryAction } from '../core/history/wiring'
import type { QueueStartEffects, QueueStartUploadItem } from '../core/download/queue-start'
import type { MetricsState } from '../core/download/metrics'
import type { SyncEvent } from '../core/sync/events'

/** Mutable and adapter-bound queue-start operations owned by the background shell. */
export interface QueueStartApplyPort {
  readonly resetCorrelation: () => void
  readonly setMetrics: (metrics: MetricsState) => void
  readonly persistSnapshot: () => Promise<void>
  readonly recordSync: (events: ReadonlyArray<SyncEvent>) => void
  readonly recordHistory: (actions: ReadonlyArray<HistoryAction>) => void
  readonly recordCloudUploads: (items: ReadonlyArray<QueueStartUploadItem>) => void
  readonly applyClearSeed: (verdict: ClearSeedVerdict) => void
}

/** Apply all queue-start intents. The caller starts saving only after this resolves. */
export async function applyQueueStartEffects(
  effects: QueueStartEffects,
  port: QueueStartApplyPort,
): Promise<void> {
  if (effects.resetCorrelation) port.resetCorrelation()
  port.setMetrics(effects.metrics)
  if (effects.persistSnapshot) await port.persistSnapshot()
  port.recordSync(effects.syncEvents)
  port.recordHistory(effects.historyActions)
  port.recordCloudUploads(effects.uploadItems)
  port.applyClearSeed(effects.clearSeed)
}
