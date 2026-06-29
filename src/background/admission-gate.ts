import type { MediaItem, Settings } from '../core/schema'
import {
  type FilterSettings,
  type SkipReason,
  evaluateAdmission,
  freeReason,
} from '../core/download/admission'
import type { SizeProbePort } from '../core/download/size-probe'
import type { SavedIndex, QueryConvex } from '../core/sync/saved-index'

const MiB = 1024 * 1024

export interface AdmissionResult {
  readonly admitted: MediaItem[]
  readonly skipped: ReadonlyArray<{ item: MediaItem; reason: SkipReason }>
}

export interface AdmissionGate {
  readonly admit: (items: ReadonlyArray<MediaItem>) => Promise<AdmissionResult>
}

export function makeAdmissionGate(deps: {
  getSettings: () => Promise<Settings>
  savedIndex: SavedIndex
  queryConvex: QueryConvex
  sizeProbe: SizeProbePort
  readTodayBudget: () => Promise<{ bytes: number; count: number }>
}): AdmissionGate {
  const admit: AdmissionGate['admit'] = async (items) => {
    const settings = await deps.getSettings()
    const filter: FilterSettings = {
      preventDuplicateDownloads: settings.preventDuplicateDownloads,
      skipTypes: settings.skipTypes,
      minWidth: settings.minWidth,
      minHeight: settings.minHeight,
      maxFileSizeBytes: settings.maxFileSizeMB * MiB,
      dailyMaxBytes: settings.dailyMaxMB * MiB,
      dailyMaxCount: settings.dailyMaxCount,
    }

    const savedTweetIds = filter.preventDuplicateDownloads
      ? new Set(
          await deps.savedIndex.resolve(
            [...new Set(items.map((i) => i.tweetId))],
            deps.queryConvex,
          ),
        )
      : new Set<string>()

    const probeActive = filter.maxFileSizeBytes > 0 || filter.dailyMaxBytes > 0
    const running =
      filter.dailyMaxBytes > 0 || filter.dailyMaxCount > 0
        ? { ...(await deps.readTodayBudget()) }
        : { bytes: 0, count: 0 }

    const admitted: MediaItem[] = []
    const skipped: { item: MediaItem; reason: SkipReason }[] = []

    for (const item of items) {
      // `freeReason` runs here ONLY to gate the expensive HEAD probe — a type-filtered or
      // duplicate item must never reach the network. The admission verdict itself is the
      // pure `evaluateAdmission`, which re-runs `freeReason` (cheap, pure, idempotent), so
      // the free → size → budget decision now lives in exactly one place.
      const free = freeReason(item, filter, savedTweetIds)
      const sizeBytes = free === null && probeActive ? await deps.sizeProbe.probe(item.url) : null
      const decision = evaluateAdmission(item, {
        settings: filter,
        savedTweetIds,
        sizeBytes,
        running,
      })
      if (!decision.admit) {
        skipped.push({ item, reason: decision.reason })
        continue
      }
      admitted.push(item)
      running.bytes += sizeBytes ?? 0
      running.count += 1
    }

    return { admitted, skipped }
  }

  return { admit }
}
