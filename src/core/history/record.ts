import { Result, Schema } from 'effect'
import { MAX_SAVE_REQUEST_ID_LENGTH, mediaRequestId } from '../download/request-identity'
import { MediaId, type MediaItem } from '../schema/media'
import {
  LegacySyncMediaMeta,
  SyncMediaMeta,
  syncMediaFromItem,
  syncMediaFromLegacy,
} from '../sync/events'
import { hasWireKeys, isWireRecord } from '../wire/exact'
import { isJsonWithinByteBudget } from '../wire/json-budget'
import { MAX_TRANSFER_FILENAME_LENGTH } from '../wire/limits'

/**
 * Durable local download record (the local-first twin of a Convex `media_state`
 * row): same `requestId` key and the same `SyncMediaMeta` provenance payload
 * (incl. `url`, the original link), so the local store and the opt-in Convex
 * mirror cannot drift.
 */
export const DownloadStatus = Schema.Literals(['queued', 'completed', 'failed'])
export type DownloadStatus = typeof DownloadStatus.Type

export const MAX_DOWNLOAD_HISTORY_FILENAME_LENGTH = MAX_TRANSFER_FILENAME_LENGTH
export const MAX_DOWNLOAD_HISTORY_RECORD_BYTES = 32 * 1024

const boundedFilename = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_DOWNLOAD_HISTORY_FILENAME_LENGTH),
)
const SaveRequestId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_SAVE_REQUEST_ID_LENGTH),
)
const nonnegativeSafeInteger = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
)

const recordFields = {
  filename: boundedFilename,
  status: DownloadStatus,
  media: SyncMediaMeta,
  bytesReceived: Schema.optional(nonnegativeSafeInteger),
  bytesTotal: Schema.optional(nonnegativeSafeInteger),
  queuedAt: nonnegativeSafeInteger,
  finishedAt: Schema.optional(nonnegativeSafeInteger),
} as const

export const DownloadRecord = Schema.Struct({
  requestId: SaveRequestId,
  mediaKey: MediaId,
  ...recordFields,
})
export type DownloadRecord = typeof DownloadRecord.Type

const LegacyDownloadRecord = Schema.Struct({
  requestId: MediaId,
  ...recordFields,
})
type LegacyDownloadRecord = typeof LegacyDownloadRecord.Type

const PrePlatformDownloadRecord = Schema.Struct({
  requestId: MediaId,
  ...recordFields,
  media: LegacySyncMediaMeta,
})

const requiredRecordKeys = [
  'requestId',
  'mediaKey',
  'filename',
  'status',
  'media',
  'queuedAt',
] as const
const legacyRequiredRecordKeys = ['requestId', 'filename', 'status', 'media', 'queuedAt'] as const
const optionalRecordKeys = ['bytesReceived', 'bytesTotal', 'finishedAt'] as const

const hasValidLifecycle = (record: DownloadRecord): boolean => {
  const hasReceived = record.bytesReceived !== undefined
  const hasTotal = record.bytesTotal !== undefined
  if (hasReceived !== hasTotal) return false
  return record.status === 'queued'
    ? record.finishedAt === undefined && !hasReceived
    : record.finishedAt !== undefined && record.finishedAt >= record.queuedAt
}

/** Exact, bounded decoder shared by durable storage and the popup reply contract. */
export const decodeDownloadRecord = (value: unknown): DownloadRecord | undefined => {
  if (!isJsonWithinByteBudget(value, MAX_DOWNLOAD_HISTORY_RECORD_BYTES) || !isWireRecord(value))
    return undefined
  const keys = [
    ...requiredRecordKeys,
    ...optionalRecordKeys.filter((key) => Object.hasOwn(value, key)),
  ]
  if (!hasWireKeys(value, keys)) return undefined
  const decoded = Schema.decodeUnknownResult(DownloadRecord, { onExcessProperty: 'error' })(value)
  if (Result.isFailure(decoded)) return undefined
  try {
    if (!hasValidLifecycle(decoded.success)) return undefined
    if (new URL(decoded.success.media.url).protocol !== 'https:') return undefined
    return decoded.success.requestId ===
      mediaRequestId({
        platform: decoded.success.media.platform,
        id: decoded.success.mediaKey,
      })
      ? decoded.success
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Decode one unversioned row. Its request id is always the legacy adapter-local
 * Media Key, even when the text resembles a current encoded request id.
 */
export const decodeLegacyDownloadRecord = (value: unknown): DownloadRecord | undefined => {
  if (!isJsonWithinByteBudget(value, MAX_DOWNLOAD_HISTORY_RECORD_BYTES) || !isWireRecord(value))
    return undefined
  const keys = [
    ...legacyRequiredRecordKeys,
    ...optionalRecordKeys.filter((key) => Object.hasOwn(value, key)),
  ]
  if (!hasWireKeys(value, keys)) return undefined
  const current = Schema.decodeUnknownResult(LegacyDownloadRecord, {
    onExcessProperty: 'error',
  })(value)
  let record: LegacyDownloadRecord
  if (Result.isSuccess(current)) record = current.success
  else {
    const legacy = Schema.decodeUnknownResult(PrePlatformDownloadRecord, {
      onExcessProperty: 'error',
    })(value)
    if (Result.isFailure(legacy)) return undefined
    record = { ...legacy.success, media: syncMediaFromLegacy(legacy.success.media) }
  }
  const mediaKey = record.requestId
  return decodeDownloadRecord({
    ...record,
    mediaKey,
    requestId: mediaRequestId({
      platform: record.media.platform,
      id: mediaKey,
    }),
  })
}

const assertCanonicalRequestId = (item: MediaItem, requestId: string): void => {
  if (requestId !== mediaRequestId(item))
    throw new TypeError(`History request id does not match ${item.platform} Media Key ${item.id}`)
}

/** A Save Request entered the queue; carries the original link + provenance. */
export function recordFromMediaItem(
  item: MediaItem,
  filename: string,
  at: number,
  requestId = mediaRequestId(item),
): DownloadRecord {
  assertCanonicalRequestId(item, requestId)
  return {
    requestId,
    mediaKey: item.id,
    filename,
    status: 'queued',
    media: syncMediaFromItem(item),
    queuedAt: at,
  }
}

/** A request reached a terminal state; updates status/finishedAt without mutating the input. */
export function applyOutcome(
  record: DownloadRecord,
  kind: 'completed' | 'failed',
  at: number,
  bytes?: { received: number; total: number },
): DownloadRecord {
  return {
    ...record,
    status: kind,
    finishedAt: Math.max(record.queuedAt, at),
    ...(bytes !== undefined ? { bytesReceived: bytes.received, bytesTotal: bytes.total } : {}),
  }
}
