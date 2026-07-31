import type { ClearSeedVerdict } from '@/packages/clear/seed'
import type { QueueStartEffects, QueueStartUploadItem } from '@/packages/download/queue-start'
import type { MetricsState } from '@/packages/download/metrics'
import type { HistoryAction } from '@/packages/history/wiring'
import type { SyncEvent } from '@/packages/sync/events'

export interface QueueStartPorts {
  readonly resetCorrelation: () => void
  readonly setMetrics: (metrics: MetricsState) => void
  readonly persistSnapshot: (at: number) => Promise<void>
  readonly recordSync: (events: ReadonlyArray<SyncEvent>) => void
  readonly recordHistory: (actions: ReadonlyArray<HistoryAction>) => void
  readonly recordUploads: (items: ReadonlyArray<QueueStartUploadItem>) => void
  readonly seedClear: (verdict: ClearSeedVerdict) => Promise<void>
}

/** Apply every queue-start effect before the first save attempt. */
export async function applyQueueStartEffects(
  effects: QueueStartEffects,
  startedAt: number,
  ports: QueueStartPorts,
): Promise<MetricsState> {
  if (effects.resetCorrelation) ports.resetCorrelation()
  ports.setMetrics(effects.metrics)
  await ports.persistSnapshot(startedAt)
  ports.recordSync(effects.syncEvents)
  ports.recordHistory(effects.historyActions)
  ports.recordUploads(effects.uploadItems)
  await ports.seedClear(effects.clearSeed)
  return effects.metrics
}
