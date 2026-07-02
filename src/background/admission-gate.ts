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

/** HEAD probes go to the media CDN (~250ms RTT each); a serial per-item await
 *  stalls a 30-item sweep ~7.5s before the first download starts. Probed in
 *  parallel, bounded so a bulk sweep never opens an unbounded connection fan-out. */
export const PROBE_CONCURRENCY = 8

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

    // Pre-probe phase: HEAD every item that passes the free gate, in parallel with a
    // bounded worker pool. `freeReason` runs here ONLY to gate the expensive probe — a
    // type-filtered or duplicate item must never reach the network — and the probes
    // carry no cross-item dependency (the budget fold below consumes their results
    // sequentially), so nothing about the verdicts changes; only the wall-clock does.
    const sizeById = new Map<string, number | null>()
    if (probeActive) {
      const targets = items.filter((i) => freeReason(i, filter, savedTweetIds) === null)
      let cursor = 0
      await Promise.all(
        Array.from({ length: Math.min(PROBE_CONCURRENCY, targets.length) }, async () => {
          // oxlint-disable no-await-in-loop -- each worker IS one lane of the parallel pool
          for (;;) {
            const target = targets[cursor++]
            if (target === undefined) return
            sizeById.set(target.id, await deps.sizeProbe.probe(target.url))
          }
          // oxlint-enable no-await-in-loop
        }),
      )
    }

    const admitted: MediaItem[] = []
    const skipped: { item: MediaItem; reason: SkipReason }[] = []

    for (const item of items) {
      // The admission verdict itself is the pure `evaluateAdmission`, which re-runs
      // `freeReason` (cheap, pure, idempotent), so the free → size → budget decision
      // lives in exactly one place; the probe result is read from the parallel phase.
      const free = freeReason(item, filter, savedTweetIds)
      const sizeBytes = free === null && probeActive ? (sizeById.get(item.id) ?? null) : null
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
