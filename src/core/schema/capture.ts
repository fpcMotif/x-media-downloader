import { Result, Schema } from 'effect'
import {
  DEFAULT_CAPTURE_SUMMARY_LIMIT,
  MAX_CAPTURE_BATCH,
  MAX_CAPTURE_MESSAGE_BYTES,
  MAX_CAPTURE_SUMMARY_LIMIT,
  MAX_CAPTURE_SUMMARY_RESPONSE_BYTES,
  MAX_CAPTURE_SUMMARY_ROOT_TEXT_LENGTH,
} from '../capture/contract'
import { CaptureEpoch } from '../capture/epoch'
import { TweetRecord } from '../capture/record-schema'
import { hasWireKeys, isWireRecord, readWireTag } from '../wire/exact'
import { isJsonWithinByteBudget } from '../wire/json-budget'

const Snowflake = Schema.String.check(Schema.isPattern(/^\d{1,20}$/))
const CaptureReceiptCount = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: MAX_CAPTURE_BATCH }),
)

/** Content → worker: one bounded, canonical capture batch. */
export const CaptureTweets = Schema.TaggedStruct('CaptureTweets', {
  epoch: CaptureEpoch,
  records: Schema.Array(TweetRecord).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_CAPTURE_BATCH),
  ),
})
export type CaptureTweets = typeof CaptureTweets.Type

/** Worker → content: exact terminal receipt for one capture batch. */
export const CaptureStored = Schema.TaggedStruct('CaptureStored', {
  epoch: CaptureEpoch,
  stored: CaptureReceiptCount,
  mirror: Schema.Literals(['not-requested', 'accepted', 'unavailable']),
})
export type CaptureStored = typeof CaptureStored.Type
export const CaptureDiscarded = Schema.TaggedStruct('CaptureDiscarded', {
  epoch: CaptureEpoch,
  discarded: CaptureReceiptCount,
})
export type CaptureDiscarded = typeof CaptureDiscarded.Type
export const CaptureTweetsResult = Schema.Union([CaptureStored, CaptureDiscarded])
export type CaptureTweetsResult = typeof CaptureTweetsResult.Type

/** Content → worker: bind future batches to the current durable erase epoch. */
export const CaptureEpochRequest = Schema.TaggedStruct('CaptureEpochRequest', {})
export type CaptureEpochRequest = typeof CaptureEpochRequest.Type
export const CaptureEpochResult = Schema.TaggedStruct('CaptureEpoch', {
  epoch: CaptureEpoch,
})
export type CaptureEpochResult = typeof CaptureEpochResult.Type
/** Worker → tabs: epoch changed; pull canonical truth before advancing. */
export const CaptureEpochChanged = Schema.TaggedStruct('CaptureEpochChanged', {})
export type CaptureEpochChanged = typeof CaptureEpochChanged.Type

/** Panel → worker: counts plus a bounded recent-thread projection. */
export const CaptureSummaryRequest = Schema.TaggedStruct('CaptureSummaryRequest', {
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_CAPTURE_SUMMARY_LIMIT })),
  ),
})
export type CaptureSummaryRequest = typeof CaptureSummaryRequest.Type

const NonnegativeSafeInteger = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
)
const SummaryHandle = Schema.String.check(Schema.isMaxLength(64))
const SummaryText = Schema.String.check(Schema.isMaxLength(MAX_CAPTURE_SUMMARY_ROOT_TEXT_LENGTH))
export const CaptureSummaryRow = Schema.Struct({
  conversationId: Snowflake,
  rootHandle: SummaryHandle,
  rootText: SummaryText,
  count: NonnegativeSafeInteger,
  lastAt: NonnegativeSafeInteger,
})
export type CaptureSummaryRow = typeof CaptureSummaryRow.Type
export const CaptureSummary = Schema.Struct({
  tweets: NonnegativeSafeInteger,
  conversations: NonnegativeSafeInteger,
  recent: Schema.Array(CaptureSummaryRow).check(Schema.isMaxLength(MAX_CAPTURE_SUMMARY_LIMIT)),
})
export type CaptureSummary = typeof CaptureSummary.Type

/** Panel → worker: a whole archive or one exact X conversation. */
export const CaptureExportKind = Schema.Literals(['jsonl', 'tree', 'markdown'])
export type CaptureExportKind = typeof CaptureExportKind.Type

export const ExportCaptureRequest = Schema.TaggedStruct('ExportCaptureRequest', {
  kind: CaptureExportKind,
  conversationId: Schema.optional(Snowflake),
})
export type ExportCaptureRequest = typeof ExportCaptureRequest.Type

export const MAX_CAPTURE_EXPORT_FILENAME_LENGTH = 128
export const MAX_CAPTURE_EXPORT_RESULT_BYTES = 512

const CaptureExportStarted = Schema.TaggedStruct('CaptureExportStarted', {
  filename: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_CAPTURE_EXPORT_FILENAME_LENGTH),
  ),
})
const CaptureExportEmpty = Schema.TaggedStruct('CaptureExportEmpty', {})
const CaptureExportTooLarge = Schema.TaggedStruct('CaptureExportTooLarge', {})
const CaptureExportUnavailable = Schema.TaggedStruct('CaptureExportUnavailable', {})
const CaptureExportUncertain = Schema.TaggedStruct('CaptureExportUncertain', {})
const CaptureExportFailed = Schema.TaggedStruct('CaptureExportFailed', {})

/** Worker → panel: terminal outcome for one export request. */
export const CaptureExportResult = Schema.Union([
  CaptureExportStarted,
  CaptureExportEmpty,
  CaptureExportTooLarge,
  CaptureExportUnavailable,
  CaptureExportUncertain,
  CaptureExportFailed,
])
export type CaptureExportResult = typeof CaptureExportResult.Type

/** Panel → worker: erase the local capture archive. */
export const ClearCaptureRequest = Schema.TaggedStruct('ClearCaptureRequest', {})
export type ClearCaptureRequest = typeof ClearCaptureRequest.Type
export const MAX_CAPTURE_ERASE_RESULT_BYTES = 256
export const CaptureEraseResult = Schema.Struct({
  cleared: NonnegativeSafeInteger,
  epoch: CaptureEpoch,
})
export type CaptureEraseResult = typeof CaptureEraseResult.Type

const decode = <A>(schema: Schema.ConstraintDecoder<A>, value: unknown): A | undefined => {
  const result = Schema.decodeUnknownResult(schema, { onExcessProperty: 'error' })(value)
  return Result.isSuccess(result) ? result.success : undefined
}

/** Exact capture ingress. The whole-message byte check must precede Effect decode. */
export const decodeCaptureTweets = (value: unknown): CaptureTweets | undefined => {
  if (
    !isWireRecord(value) ||
    !hasWireKeys(value, ['_tag', 'epoch', 'records']) ||
    !isJsonWithinByteBudget(value, MAX_CAPTURE_MESSAGE_BYTES) ||
    value._tag !== 'CaptureTweets'
  )
    return undefined
  return decode(CaptureTweets, value)
}

/** Exact capture receipt decoder for the content-side FIFO. */
export const decodeCaptureTweetsResult = (
  value: unknown,
  sentCount: number,
): CaptureTweetsResult | undefined => {
  if (!Number.isSafeInteger(sentCount) || sentCount < 1 || sentCount > MAX_CAPTURE_BATCH)
    return undefined
  if (!isWireRecord(value)) return undefined
  if (value._tag === 'CaptureStored' && hasWireKeys(value, ['_tag', 'epoch', 'stored', 'mirror']))
    return value.stored === sentCount ? decode(CaptureStored, value) : undefined
  if (value._tag === 'CaptureDiscarded' && hasWireKeys(value, ['_tag', 'epoch', 'discarded']))
    return value.discarded === sentCount ? decode(CaptureDiscarded, value) : undefined
  return undefined
}

export const decodeCaptureEpochRequest = (value: unknown): CaptureEpochRequest | undefined =>
  isWireRecord(value) && value._tag === 'CaptureEpochRequest' && hasWireKeys(value, ['_tag'])
    ? decode(CaptureEpochRequest, value)
    : undefined

export const decodeCaptureEpochResult = (value: unknown): CaptureEpochResult | undefined =>
  isJsonWithinByteBudget(value, MAX_CAPTURE_ERASE_RESULT_BYTES) &&
  isWireRecord(value) &&
  value._tag === 'CaptureEpoch' &&
  hasWireKeys(value, ['_tag', 'epoch'])
    ? decode(CaptureEpochResult, value)
    : undefined

export const decodeCaptureEpochChanged = (value: unknown): CaptureEpochChanged | undefined =>
  isJsonWithinByteBudget(value, MAX_CAPTURE_ERASE_RESULT_BYTES) &&
  isWireRecord(value) &&
  value._tag === 'CaptureEpochChanged' &&
  hasWireKeys(value, ['_tag'])
    ? decode(CaptureEpochChanged, value)
    : undefined

/** Exact panel request decoder. */
export const decodeCaptureSummaryRequest = (value: unknown): CaptureSummaryRequest | undefined => {
  if (!isWireRecord(value) || value._tag !== 'CaptureSummaryRequest') return undefined
  const keys = Object.hasOwn(value, 'limit') ? ['_tag', 'limit'] : ['_tag']
  return hasWireKeys(value, keys) ? decode(CaptureSummaryRequest, value) : undefined
}

const isSummaryLimit = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0 && value <= MAX_CAPTURE_SUMMARY_LIMIT

const isNewestFirst = (rows: readonly CaptureSummaryRow[]): boolean =>
  rows.every((row, index) => {
    const previous = rows[index - 1]
    return previous === undefined || previous.lastAt >= row.lastAt
  })

/** Exact, bounded reply decoder. A reply cannot exceed its request's list cap. */
export const decodeCaptureSummary = (
  value: unknown,
  requestedLimit = DEFAULT_CAPTURE_SUMMARY_LIMIT,
): CaptureSummary | undefined => {
  if (
    !isSummaryLimit(requestedLimit) ||
    !isWireRecord(value) ||
    !hasWireKeys(value, ['tweets', 'conversations', 'recent']) ||
    !isJsonWithinByteBudget(value, MAX_CAPTURE_SUMMARY_RESPONSE_BYTES) ||
    !Array.isArray(value.recent) ||
    value.recent.some(
      (row) =>
        !isWireRecord(row) ||
        !hasWireKeys(row, ['conversationId', 'rootHandle', 'rootText', 'count', 'lastAt']),
    )
  )
    return undefined
  const summary = decode(CaptureSummary, value)
  if (
    summary === undefined ||
    summary.recent.length > requestedLimit ||
    summary.recent.length > summary.conversations ||
    summary.conversations > summary.tweets ||
    !isNewestFirst(summary.recent) ||
    new Set(summary.recent.map((row) => row.conversationId)).size !== summary.recent.length
  )
    return undefined
  return summary
}

/** Exact panel request decoder. */
export const decodeExportCaptureRequest = (value: unknown): ExportCaptureRequest | undefined => {
  if (!isWireRecord(value) || value._tag !== 'ExportCaptureRequest') return undefined
  const keys = Object.hasOwn(value, 'conversationId')
    ? ['_tag', 'kind', 'conversationId']
    : ['_tag', 'kind']
  return hasWireKeys(value, keys) ? decode(ExportCaptureRequest, value) : undefined
}

/** Exact, bounded export outcome decoder. */
export const decodeCaptureExportResult = (value: unknown): CaptureExportResult | undefined => {
  if (!isJsonWithinByteBudget(value, MAX_CAPTURE_EXPORT_RESULT_BYTES)) return undefined
  const tag = readWireTag(value)
  if (tag === 'CaptureExportStarted')
    return hasWireKeys(value, ['_tag', 'filename']) ? decode(CaptureExportResult, value) : undefined
  if (
    tag === 'CaptureExportEmpty' ||
    tag === 'CaptureExportTooLarge' ||
    tag === 'CaptureExportUnavailable' ||
    tag === 'CaptureExportUncertain' ||
    tag === 'CaptureExportFailed'
  )
    return hasWireKeys(value, ['_tag']) ? decode(CaptureExportResult, value) : undefined
  return undefined
}

/** Exact no-payload panel request decoder. */
export const decodeClearCaptureRequest = (value: unknown): ClearCaptureRequest | undefined =>
  isWireRecord(value) && value._tag === 'ClearCaptureRequest' && hasWireKeys(value, ['_tag'])
    ? decode(ClearCaptureRequest, value)
    : undefined

/** Exact worker acknowledgement after the archive and pending mirror purge settle. */
export const decodeCaptureEraseResult = (value: unknown): CaptureEraseResult | undefined =>
  isJsonWithinByteBudget(value, MAX_CAPTURE_ERASE_RESULT_BYTES) &&
  hasWireKeys(value, ['cleared', 'epoch'])
    ? decode(CaptureEraseResult, value)
    : undefined
