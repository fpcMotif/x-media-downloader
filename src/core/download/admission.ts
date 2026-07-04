import type { MediaItem, MediaType } from '../schema'

export type SkipReason = 'duplicate' | 'filtered-type' | 'too-small' | 'too-big' | 'daily-budget'

export interface FilterSettings {
  readonly preventDuplicateDownloads: boolean
  readonly skipTypes: ReadonlyArray<MediaType>
  readonly minWidth: number
  readonly minHeight: number
  readonly maxFileSizeBytes: number
  readonly dailyMaxBytes: number
  readonly dailyMaxCount: number
}

export type AdmissionDecision = { admit: true } | { admit: false; reason: SkipReason }

export function freeReason(
  item: MediaItem,
  settings: FilterSettings,
  savedTweetIds: ReadonlySet<string>,
): SkipReason | null {
  if (settings.skipTypes.includes(item.type)) return 'filtered-type'
  if (item.width !== undefined && settings.minWidth > 0 && item.width < settings.minWidth)
    return 'too-small'
  if (item.height !== undefined && settings.minHeight > 0 && item.height < settings.minHeight)
    return 'too-small'
  if (settings.preventDuplicateDownloads && savedTweetIds.has(item.postId)) return 'duplicate'
  return null
}

export function sizeReason(sizeBytes: number | null, maxFileSizeBytes: number): SkipReason | null {
  if (maxFileSizeBytes <= 0 || sizeBytes === null) return null
  return sizeBytes > maxFileSizeBytes ? 'too-big' : null
}

export function budgetReason(
  running: { bytes: number; count: number },
  add: { bytes: number; count: number },
  limits: { dailyMaxBytes: number; dailyMaxCount: number },
): SkipReason | null {
  if (limits.dailyMaxBytes > 0 && running.bytes + add.bytes > limits.dailyMaxBytes)
    return 'daily-budget'
  if (limits.dailyMaxCount > 0 && running.count + add.count > limits.dailyMaxCount)
    return 'daily-budget'
  return null
}

export interface AdmissionContext {
  readonly settings: FilterSettings
  readonly savedTweetIds: ReadonlySet<string>
  readonly sizeBytes: number | null
  readonly running: { bytes: number; count: number }
}

export function evaluateAdmission(item: MediaItem, ctx: AdmissionContext): AdmissionDecision {
  const { settings, savedTweetIds, sizeBytes, running } = ctx
  const free = freeReason(item, settings, savedTweetIds)
  if (free) return { admit: false, reason: free }
  const size = sizeReason(sizeBytes, settings.maxFileSizeBytes)
  if (size) return { admit: false, reason: size }
  const budget = budgetReason(running, { bytes: sizeBytes ?? 0, count: 1 }, settings)
  if (budget) return { admit: false, reason: budget }
  return { admit: true }
}
