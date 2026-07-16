/**
 * Queue Start — the pure decision for records created before save attempts.
 *
 * Admission, in-flight filtering, mutable state, adapters, and enqueue stay in
 * the background shell. This module decides the shared fan-out once.
 */
import { planClearSeed, type ClearSeedVerdict } from '../clear/seed'
import type { Scope } from '../clear/ledger'
import type { HistoryAction } from '../history/wiring'
import { isMirrorableRequest } from '../history/wiring'
import type { MediaItem, Settings } from '../schema'
import { queuedEvent, type SyncEvent } from '../sync/events'
import { emptyMetrics, extendTotal, snapshot, type MetricsState } from './metrics'
import type { SaveRequest } from './strategy'

/** Provider-neutral cloud upload intent. Adapters map the Media Item as needed. */
export interface QueueStartUploadItem {
  readonly item: MediaItem
  readonly filename: string
}

/** Everything an accepted queue batch records before save starts. */
export interface QueueStartEffects {
  readonly metrics: MetricsState
  readonly resetCorrelation: boolean
  readonly syncEvents: ReadonlyArray<SyncEvent>
  readonly historyActions: ReadonlyArray<HistoryAction>
  readonly uploadItems: ReadonlyArray<QueueStartUploadItem>
  readonly clearSeed: ClearSeedVerdict
  readonly persistSnapshot: true
}

export interface QueueStartInput {
  readonly metrics: MetricsState | null
  readonly requests: ReadonlyArray<SaveRequest>
  readonly mediaById: ReadonlyMap<string, MediaItem>
  readonly settings: Settings
  readonly startedAt: number
  readonly sweep?: { readonly scope: Scope }
  readonly clearExpect?: ReadonlyArray<{
    readonly tweetId: string
    readonly ids: ReadonlyArray<string>
  }>
}

interface MirrorableRequest {
  readonly request: SaveRequest
  readonly item: MediaItem
}

/** One lookup and one sidecar rule feed every mirror effect. */
function projectMirrorableRequests(
  requests: ReadonlyArray<SaveRequest>,
  mediaById: ReadonlyMap<string, MediaItem>,
): MirrorableRequest[] {
  return requests.flatMap((request) => {
    const item = mediaById.get(request.id)
    return item !== undefined && isMirrorableRequest(request.id, true) ? [{ request, item }] : []
  })
}

export function decideQueueStart(input: QueueStartInput): QueueStartEffects {
  const { metrics, requests, mediaById, settings, startedAt } = input
  const startsFresh = metrics === null || snapshot(metrics, startedAt).active === 0
  const nextMetrics = startsFresh
    ? emptyMetrics({
        total: requests.length,
        concurrencyCap: settings.downloadConcurrency,
        startedAt,
      })
    : extendTotal(metrics, requests.length, settings.downloadConcurrency)
  const mirrorable = projectMirrorableRequests(requests, mediaById)

  return {
    metrics: nextMetrics,
    resetCorrelation: startsFresh,
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
    }),
    persistSnapshot: true,
  }
}
