import type { MediaItem, Settings } from '../core/schema'
import {
  type FilterSettings,
  type SkipReason,
  freeReason,
  sizeReason,
  budgetReason,
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
      const free = freeReason(item, filter, savedTweetIds)
      if (free) {
        skipped.push({ item, reason: free })
        continue
      }
      const sizeBytes = probeActive ? await deps.sizeProbe.probe(item.url) : null
      const size = sizeReason(sizeBytes, filter.maxFileSizeBytes)
      if (size) {
        skipped.push({ item, reason: size })
        continue
      }
      const budget = budgetReason(
        running,
        { bytes: sizeBytes ?? 0, count: 1 },
        { dailyMaxBytes: filter.dailyMaxBytes, dailyMaxCount: filter.dailyMaxCount },
      )
      if (budget) {
        skipped.push({ item, reason: budget })
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
