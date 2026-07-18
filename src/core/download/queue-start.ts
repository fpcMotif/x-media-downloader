import { planClearSeed, type ClearSeedVerdict } from '../clear/seed'
import type { HistoryAction } from '../history/wiring'
import type { MediaItem, Settings } from '../schema'
import { queuedEvent, type SyncEvent } from '../sync/events'
import { emptyMetrics, extendTotal, snapshot, type MetricsState } from './metrics'
import type { SaveRequest } from './strategy'

export interface QueueStartUploadItem {
  readonly item: MediaItem
  readonly filename: string
}

export interface QueueStartEffects {
  readonly metrics: MetricsState
  readonly resetCorrelation: boolean
  readonly syncEvents: ReadonlyArray<SyncEvent>
  readonly historyActions: ReadonlyArray<HistoryAction>
  readonly uploadItems: ReadonlyArray<QueueStartUploadItem>
  readonly clearSeed: ClearSeedVerdict
  readonly persistSnapshot: true
}

export function decideQueueStart(input: {
  readonly metrics: MetricsState | null
  readonly requests: ReadonlyArray<SaveRequest>
  readonly mediaById: ReadonlyMap<string, MediaItem>
  readonly settings: Settings
  readonly startedAt: number
  readonly sweep?: { readonly scope: 'bookmark' | 'like' | 'notInterested' }
  readonly clearExpect?: ReadonlyArray<{
    readonly tweetId: string
    readonly ids: ReadonlyArray<string>
  }>
  readonly originTabId?: number
}): QueueStartEffects {
  const { metrics, requests, mediaById, settings, startedAt } = input
  const fresh = metrics === null || snapshot(metrics, startedAt).active === 0
  const nextMetrics = fresh
    ? emptyMetrics({
        total: requests.length,
        concurrencyCap: settings.downloadConcurrency,
        startedAt,
      })
    : extendTotal(metrics, requests.length, settings.downloadConcurrency)

  const mirrorable = requests.flatMap((request) => {
    const item = mediaById.get(request.id)
    return item === undefined ? [] : [{ request, item }]
  })

  return {
    metrics: nextMetrics,
    resetCorrelation: fresh,
    syncEvents: mirrorable.map(({ item }) => queuedEvent(item, settings.cloudDeviceId, startedAt)),
    historyActions: mirrorable.map(({ request, item }) => ({
      kind: 'queued',
      item,
      filename: request.filename,
      at: startedAt,
    })),
    uploadItems: mirrorable.map(({ request, item }) => ({
      item,
      filename: request.filename,
    })),
    clearSeed: planClearSeed({
      requests,
      mediaById,
      settings,
      ...(input.sweep ? { sweep: input.sweep } : {}),
      ...(input.clearExpect ? { clearExpect: input.clearExpect } : {}),
      ...(input.originTabId === undefined ? {} : { originTabId: input.originTabId }),
    }),
    persistSnapshot: true,
  }
}
