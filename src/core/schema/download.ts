import { Result, Schema } from 'effect'
import { SweepScope } from './clear'
import { TweetSnowflake } from './tweet'
import {
  MAX_MEDIA_ID_LENGTH,
  MAX_MEDIA_INDEX,
  MAX_MEDIA_POST_ID_LENGTH,
  MAX_MEDIA_URL_LENGTH,
  MediaItem,
  MediaType,
  decodeMediaItem,
  type MediaItem as MediaItemType,
} from './media'
import { hasWireKeys, isWireRecord } from '../wire/exact'
import { isJsonWithinByteBudget } from '../wire/json-budget'
import {
  MAX_SAVE_REQUEST_ID_LENGTH,
  mediaRequestId,
  sidecarRequestId,
} from '../download/request-identity'
import {
  MAX_DOWNLOAD_ITEMS_PER_REQUEST,
  MAX_SWEEP_MEDIA_PER_REQUEST,
  MAX_SWEEP_POSTS_PER_REQUEST,
  MAX_X_MEDIA_PER_SWEEP_POST,
} from '../wire/limits'
import { MAX_DIAGNOSTIC_TEXT_LENGTH } from '../diagnostic-text'

export const MAX_TRANSFER_STARTS_PER_REQUEST = MAX_DOWNLOAD_ITEMS_PER_REQUEST * 2
export const MAX_DOWNLOAD_REQUEST_BYTES = 1_200_000
/**
 * QueueUpdate repeats bounded artifact IDs. With 64 media items, sidecars, and
 * escaped failure text, the exact reply can approach 2 MiB.
 */
export const MAX_DOWNLOAD_REPLY_BYTES = 2_000_000
export const MAX_MONITOR_MESSAGE_BYTES = 4 * 1024
/** One URL code unit may occupy six canonical JSON bytes when escaped. */
export const MAX_REFRESH_MEDIA_URL_RESPONSE_BYTES = MAX_MEDIA_URL_LENGTH * 6 + 128
export const MAX_TRACE_EVENT_BYTES = 4 * 1024
export const MAX_TRACE_EVENTS = 12
export const MAX_TRACE_STAGE_LENGTH = 128
export const MAX_TRACE_DETAIL_LENGTH = MAX_DIAGNOSTIC_TEXT_LENGTH
export const MAX_FAILURE_REASON_LENGTH = MAX_DIAGNOSTIC_TEXT_LENGTH

const nonnegativeSafeInteger = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
)
const boundedText = (maximum: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum))
const boundedOptionalText = (maximum: number) => Schema.String.check(Schema.isMaxLength(maximum))
const HttpsUrl = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_MEDIA_URL_LENGTH),
  Schema.isPattern(/^https:\/\//u),
)

const isHttpsUrl = (value: string): boolean => {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

const decode = <A>(schema: Schema.ConstraintDecoder<A>, value: unknown): A | undefined => {
  const result = Schema.decodeUnknownResult(schema, {
    onExcessProperty: 'error',
  })(value)
  return Result.isSuccess(result) ? result.success : undefined
}

const hasOptionalKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean =>
  hasWireKeys(value, [...required, ...optional.filter((key) => Object.hasOwn(value, key))])

const exactly = <A>(
  value: unknown,
  budget: number,
  tag: string,
  required: readonly string[],
  optional: readonly string[],
  schema: Schema.ConstraintDecoder<A>,
): A | undefined => {
  if (!isJsonWithinByteBudget(value, budget) || !isWireRecord(value) || value._tag !== tag)
    return undefined
  return hasOptionalKeys(value, required, optional) ? decode(schema, value) : undefined
}

const unique = (values: ReadonlyArray<string>): boolean => new Set(values).size === values.length

const isSnowflake = (value: string): boolean => /^\d{1,20}$/u.test(value)

const ClearExpectEntry = Schema.Struct({
  tweetId: TweetSnowflake,
  requestIds: Schema.Array(boundedText(MAX_SAVE_REQUEST_ID_LENGTH)).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_DOWNLOAD_ITEMS_PER_REQUEST),
    Schema.isUnique(),
  ),
})
export type ClearExpectEntry = typeof ClearExpectEntry.Type

export const DownloadRequest = Schema.TaggedStruct('DownloadRequest', {
  items: Schema.Array(MediaItem).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_DOWNLOAD_ITEMS_PER_REQUEST),
  ),
  clearExpect: Schema.optional(
    Schema.Array(ClearExpectEntry).check(Schema.isMaxLength(MAX_DOWNLOAD_ITEMS_PER_REQUEST)),
  ),
})
export type DownloadRequest = typeof DownloadRequest.Type

const decodeClearExpect = (
  value: unknown,
  items: ReadonlyArray<MediaItemType>,
): ReadonlyArray<ClearExpectEntry> | undefined => {
  if (!Array.isArray(value) || value.length > MAX_DOWNLOAD_ITEMS_PER_REQUEST) return undefined
  const entries: ClearExpectEntry[] = []
  const tweetIds = new Set<string>()
  const ids = new Set<string>()
  const currentXPosts = new Set<string>()
  for (const item of items) {
    if (item.platform === 'x' && isSnowflake(item.postId)) currentXPosts.add(item.postId)
  }
  for (const raw of value) {
    if (!isWireRecord(raw) || !hasWireKeys(raw, ['tweetId', 'requestIds'])) return undefined
    const entry = decode(ClearExpectEntry, raw)
    if (entry === undefined || tweetIds.has(entry.tweetId)) return undefined
    if (!currentXPosts.has(entry.tweetId) || entry.requestIds.some((id) => ids.has(id)))
      return undefined
    tweetIds.add(entry.tweetId)
    entry.requestIds.forEach((id) => ids.add(id))
    entries.push(entry)
  }
  return ids.size <= MAX_DOWNLOAD_ITEMS_PER_REQUEST ? entries : undefined
}

/** Exact ingress. Clear expectations may widen a current X post to its full media set. */
export const decodeDownloadRequest = (value: unknown): DownloadRequest | undefined => {
  if (
    !isJsonWithinByteBudget(value, MAX_DOWNLOAD_REQUEST_BYTES) ||
    !isWireRecord(value) ||
    value._tag !== 'DownloadRequest' ||
    !hasOptionalKeys(value, ['_tag', 'items'], ['clearExpect']) ||
    !Array.isArray(value.items) ||
    value.items.length === 0 ||
    value.items.length > MAX_DOWNLOAD_ITEMS_PER_REQUEST
  )
    return undefined
  const items = value.items.map(decodeMediaItem)
  if (items.some((item) => item === undefined)) return undefined
  const exactItems = items as MediaItemType[]
  if (!unique(exactItems.map(mediaRequestId))) return undefined
  const clearExpect = Object.hasOwn(value, 'clearExpect')
    ? decodeClearExpect(value.clearExpect, exactItems)
    : undefined
  if (Object.hasOwn(value, 'clearExpect') && clearExpect === undefined) return undefined
  return decode(DownloadRequest, {
    _tag: 'DownloadRequest',
    items: exactItems,
    ...(clearExpect === undefined ? {} : { clearExpect }),
  })
}

export const SkipReason = Schema.Literals([
  'duplicate',
  'filtered-type',
  'too-small',
  'too-big',
  'daily-budget',
  'unsafe-url',
])
export type SkipReason = typeof SkipReason.Type

const QueueArtifactId = boundedText(MAX_SAVE_REQUEST_ID_LENGTH)
const QueueArtifactIds = Schema.Array(QueueArtifactId).check(
  Schema.isMaxLength(MAX_TRANSFER_STARTS_PER_REQUEST),
  Schema.isUnique(),
)
const QueueMediaIds = Schema.Array(QueueArtifactId).check(
  Schema.isMaxLength(MAX_DOWNLOAD_ITEMS_PER_REQUEST),
  Schema.isUnique(),
)
/** Duplicate is an acknowledged success, never a skipped request. */
const QueueSkipReason = Schema.Literals([
  'filtered-type',
  'too-small',
  'too-big',
  'daily-budget',
  'unsafe-url',
])
const QueueSkip = Schema.Struct({ requestId: QueueArtifactId, reason: QueueSkipReason })
const QueueFailure = Schema.Struct({
  requestId: QueueArtifactId,
  reason: boundedText(MAX_FAILURE_REASON_LENGTH),
})

export const QueueUpdate = Schema.TaggedStruct('QueueUpdate', {
  /** Every fresh main artifact and its optional sidecar. */
  planned: QueueArtifactIds,
  started: QueueArtifactIds,
  /** Artifacts retained by the durable Fetched capacity scheduler. */
  deferred: QueueArtifactIds,
  /** Already-owned requested main media. This is success-equivalent. */
  duplicates: QueueMediaIds,
  failures: Schema.Array(QueueFailure).check(Schema.isMaxLength(MAX_TRANSFER_STARTS_PER_REQUEST)),
  /** Requested main media rejected before registry ownership. */
  skipped: Schema.Array(QueueSkip).check(Schema.isMaxLength(MAX_DOWNLOAD_ITEMS_PER_REQUEST)),
})
export type QueueUpdate = typeof QueueUpdate.Type

/** Exact start acknowledgement, bound to the request that caused it. */
export const decodeQueueUpdate = (
  value: unknown,
  requestedItems: ReadonlyArray<Pick<MediaItemType, 'id' | 'platform'>>,
): QueueUpdate | undefined => {
  if (
    !Array.isArray(requestedItems) ||
    requestedItems.length === 0 ||
    requestedItems.length > MAX_DOWNLOAD_ITEMS_PER_REQUEST
  )
    return undefined
  const mainIds = requestedItems.map(mediaRequestId)
  if (!unique(mainIds)) return undefined
  const mediaIds = new Set(mainIds)
  const sidecarToMain = new Map(
    requestedItems.map((item) => [sidecarRequestId(item), mediaRequestId(item)] as const),
  )
  const sidecarIds = new Set(sidecarToMain.keys())
  const artifactIds = new Set([...mediaIds, ...sidecarIds])
  if (
    sidecarToMain.size !== requestedItems.length ||
    artifactIds.size !== mainIds.length + sidecarIds.size
  )
    return undefined
  const reply = exactly(
    value,
    MAX_DOWNLOAD_REPLY_BYTES,
    'QueueUpdate',
    ['_tag', 'planned', 'started', 'deferred', 'duplicates', 'failures', 'skipped'],
    [],
    QueueUpdate,
  )
  if (reply === undefined) return undefined

  const planned = new Set(reply.planned)
  if (planned.size !== reply.planned.length || reply.planned.some((id) => !artifactIds.has(id)))
    return undefined
  if (
    reply.planned.some((id) => {
      const mainId = sidecarToMain.get(id)
      return mainId !== undefined && !planned.has(mainId)
    })
  )
    return undefined
  const duplicateIds = reply.duplicates
  const skippedIds = reply.skipped.map((entry) => entry.requestId)
  if (
    !unique(skippedIds) ||
    duplicateIds.some((id) => !mediaIds.has(id)) ||
    skippedIds.some((id) => !mediaIds.has(id))
  )
    return undefined
  for (const id of mainIds) {
    const plannedMain = planned.has(id) ? 1 : 0
    const duplicate = duplicateIds.includes(id) ? 1 : 0
    const skipped = skippedIds.includes(id) ? 1 : 0
    if (plannedMain + duplicate + skipped !== 1) return undefined
  }

  const failureIds = reply.failures.map((failure) => failure.requestId)
  if (!unique(failureIds)) return undefined
  const outcomes = [...reply.started, ...reply.deferred, ...failureIds]
  if (
    !unique(outcomes) ||
    outcomes.length !== reply.planned.length ||
    outcomes.some((id) => !planned.has(id))
  )
    return undefined
  return reply
}

export const MetricsRequest = Schema.TaggedStruct('MetricsRequest', {})
export type MetricsRequest = typeof MetricsRequest.Type

export const DownloadTraceSource = Schema.Literals(['quickgrab', 'badge', 'background', 'clear'])
export type DownloadTraceSource = typeof DownloadTraceSource.Type

const traceFields = {
  source: DownloadTraceSource,
  stage: boundedText(MAX_TRACE_STAGE_LENGTH),
  t: nonnegativeSafeInteger,
  itemId: Schema.optional(boundedOptionalText(MAX_SAVE_REQUEST_ID_LENGTH)),
  tweetId: Schema.optional(boundedOptionalText(MAX_MEDIA_POST_ID_LENGTH)),
  type: Schema.optional(MediaType),
  elapsedMs: Schema.optional(nonnegativeSafeInteger),
  detail: Schema.optional(boundedOptionalText(MAX_TRACE_DETAIL_LENGTH)),
}
const traceRequiredKeys = ['source', 'stage', 't'] as const
const traceOptionalKeys = ['itemId', 'tweetId', 'type', 'elapsedMs', 'detail'] as const

export const DownloadTraceEntry = Schema.Struct(traceFields)
export type DownloadTraceEntry = typeof DownloadTraceEntry.Type

export const DownloadTraceEvent = Schema.TaggedStruct('DownloadTraceEvent', traceFields)
export type DownloadTraceEvent = typeof DownloadTraceEvent.Type

const decodeTraceEntry = (value: unknown): DownloadTraceEntry | undefined => {
  if (!isWireRecord(value) || !hasOptionalKeys(value, traceRequiredKeys, traceOptionalKeys))
    return undefined
  return decode(DownloadTraceEntry, value)
}

/** Exact content telemetry. It has no authority and still gets a hard byte cap. */
export const decodeDownloadTraceEvent = (value: unknown): DownloadTraceEvent | undefined =>
  exactly(
    value,
    MAX_TRACE_EVENT_BYTES,
    'DownloadTraceEvent',
    ['_tag', ...traceRequiredKeys],
    traceOptionalKeys,
    DownloadTraceEvent,
  )

export const MetricsSnapshot = Schema.Struct({
  total: nonnegativeSafeInteger,
  completed: nonnegativeSafeInteger,
  failed: nonnegativeSafeInteger,
  active: nonnegativeSafeInteger,
  retries: nonnegativeSafeInteger,
  concurrencyCap: nonnegativeSafeInteger,
  bytesReceived: nonnegativeSafeInteger,
  bytesTotal: nonnegativeSafeInteger,
  throughputBps: Schema.Number.check(
    Schema.isFinite(),
    Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  etaSeconds: Schema.optional(
    Schema.Number.check(
      Schema.isFinite(),
      Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    ),
  ),
  elapsedMs: nonnegativeSafeInteger,
  events: Schema.optional(
    Schema.Array(DownloadTraceEntry).check(Schema.isMaxLength(MAX_TRACE_EVENTS)),
  ),
})
export type MetricsSnapshot = typeof MetricsSnapshot.Type

/** Exact advisory snapshot. Counters cannot claim more terminal work than total. */
export const decodeMetricsSnapshot = (value: unknown): MetricsSnapshot | undefined => {
  if (!isJsonWithinByteBudget(value, MAX_DOWNLOAD_REPLY_BYTES) || !isWireRecord(value))
    return undefined
  const required = [
    'total',
    'completed',
    'failed',
    'active',
    'retries',
    'concurrencyCap',
    'bytesReceived',
    'bytesTotal',
    'throughputBps',
    'elapsedMs',
  ]
  if (!hasOptionalKeys(value, required, ['etaSeconds', 'events'])) return undefined
  if (!Array.isArray(value.events) && Object.hasOwn(value, 'events')) return undefined
  if (
    Array.isArray(value.events) &&
    value.events.some((event) => decodeTraceEntry(event) === undefined)
  )
    return undefined
  const snapshot = decode(MetricsSnapshot, value)
  if (snapshot === undefined) return undefined
  return snapshot.completed + snapshot.failed + snapshot.active <= snapshot.total
    ? snapshot
    : undefined
}

export const ClearDownloadMonitorRequest = Schema.TaggedStruct('ClearDownloadMonitorRequest', {
  clearStaleLocks: Schema.optional(Schema.Boolean),
})
export type ClearDownloadMonitorRequest = typeof ClearDownloadMonitorRequest.Type

export const ClearDownloadMonitorResponse = Schema.TaggedStruct('ClearDownloadMonitorResponse', {
  ok: Schema.Boolean,
  active: nonnegativeSafeInteger,
  clearedMetrics: Schema.Boolean,
  clearedLocks: nonnegativeSafeInteger,
  reason: Schema.optional(boundedOptionalText(MAX_FAILURE_REASON_LENGTH)),
})
export type ClearDownloadMonitorResponse = typeof ClearDownloadMonitorResponse.Type

export const decodeMetricsRequest = (value: unknown): MetricsRequest | undefined =>
  exactly(value, MAX_MONITOR_MESSAGE_BYTES, 'MetricsRequest', ['_tag'], [], MetricsRequest)

export const decodeClearDownloadMonitorRequest = (
  value: unknown,
): ClearDownloadMonitorRequest | undefined =>
  exactly(
    value,
    MAX_MONITOR_MESSAGE_BYTES,
    'ClearDownloadMonitorRequest',
    ['_tag'],
    ['clearStaleLocks'],
    ClearDownloadMonitorRequest,
  )

export const decodeClearDownloadMonitorResponse = (
  value: unknown,
): ClearDownloadMonitorResponse | undefined =>
  exactly(
    value,
    MAX_MONITOR_MESSAGE_BYTES,
    'ClearDownloadMonitorResponse',
    ['_tag', 'ok', 'active', 'clearedMetrics', 'clearedLocks'],
    ['reason'],
    ClearDownloadMonitorResponse,
  )

const SweepPost = Schema.Struct({
  tweetId: TweetSnowflake,
  items: Schema.Array(MediaItem).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_X_MEDIA_PER_SWEEP_POST),
  ),
})

export const SweepEnqueueRequest = Schema.TaggedStruct('SweepEnqueueRequest', {
  scope: SweepScope,
  posts: Schema.Array(SweepPost).check(Schema.isMaxLength(MAX_SWEEP_POSTS_PER_REQUEST)),
})
export type SweepEnqueueRequest = typeof SweepEnqueueRequest.Type

export const SweepEnqueueResponse = Schema.TaggedStruct('SweepEnqueueResponse', {
  queued: nonnegativeSafeInteger,
  skipped: nonnegativeSafeInteger,
})
export type SweepEnqueueResponse = typeof SweepEnqueueResponse.Type

export const SweepEnqueueUnavailable = Schema.TaggedStruct('SweepEnqueueUnavailable', {})
export type SweepEnqueueUnavailable = typeof SweepEnqueueUnavailable.Type

/** Exact X-only list sweep. Posts and item identities remain one-to-one. */
export const decodeSweepEnqueueRequest = (value: unknown): SweepEnqueueRequest | undefined => {
  if (
    !isJsonWithinByteBudget(value, MAX_DOWNLOAD_REQUEST_BYTES) ||
    !isWireRecord(value) ||
    value._tag !== 'SweepEnqueueRequest' ||
    !hasWireKeys(value, ['_tag', 'scope', 'posts']) ||
    !Array.isArray(value.posts) ||
    value.posts.length > MAX_SWEEP_POSTS_PER_REQUEST
  )
    return undefined
  const postIds = new Set<string>()
  const itemIds = new Set<string>()
  let itemCount = 0
  const posts: Array<{
    readonly tweetId: string
    readonly items: ReadonlyArray<MediaItemType>
  }> = []
  for (const rawPost of value.posts) {
    if (
      !isWireRecord(rawPost) ||
      !hasWireKeys(rawPost, ['tweetId', 'items']) ||
      !Array.isArray(rawPost.items)
    )
      return undefined
    const tweetId = rawPost.tweetId
    if (typeof tweetId !== 'string' || !isSnowflake(tweetId) || postIds.has(tweetId))
      return undefined
    if (rawPost.items.length === 0 || rawPost.items.length > MAX_X_MEDIA_PER_SWEEP_POST)
      return undefined
    const items = rawPost.items.map(decodeMediaItem)
    if (
      items.some((item) => item === undefined) ||
      items.some((item) => item?.platform !== 'x' || item.postId !== tweetId)
    )
      return undefined
    const exactItems = items as MediaItemType[]
    if (exactItems.some((item) => itemIds.has(item.id))) return undefined
    exactItems.forEach((item) => itemIds.add(item.id))
    itemCount += exactItems.length
    if (itemCount > MAX_SWEEP_MEDIA_PER_REQUEST) return undefined
    postIds.add(tweetId)
    posts.push({ tweetId, items: exactItems })
  }
  return decode(SweepEnqueueRequest, {
    _tag: 'SweepEnqueueRequest',
    scope: value.scope,
    posts,
  })
}

/** Exact count reply. A worker cannot claim more classifications than sent posts. */
export const decodeSweepEnqueueResponse = (
  value: unknown,
  requestedPosts = MAX_SWEEP_POSTS_PER_REQUEST,
): SweepEnqueueResponse | undefined => {
  if (
    !Number.isSafeInteger(requestedPosts) ||
    requestedPosts < 0 ||
    requestedPosts > MAX_SWEEP_POSTS_PER_REQUEST
  )
    return undefined
  const reply = exactly(
    value,
    MAX_MONITOR_MESSAGE_BYTES,
    'SweepEnqueueResponse',
    ['_tag', 'queued', 'skipped'],
    [],
    SweepEnqueueResponse,
  )
  return reply !== undefined && reply.queued + reply.skipped <= requestedPosts ? reply : undefined
}

export const decodeSweepEnqueueUnavailable = (
  value: unknown,
): SweepEnqueueUnavailable | undefined =>
  exactly(
    value,
    MAX_MONITOR_MESSAGE_BYTES,
    'SweepEnqueueUnavailable',
    ['_tag'],
    [],
    SweepEnqueueUnavailable,
  )

export const RefreshMediaUrlRequest = Schema.TaggedStruct('RefreshMediaUrlRequest', {
  itemId: boundedText(MAX_MEDIA_ID_LENGTH),
  tweetId: TweetSnowflake,
  index: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_MEDIA_INDEX })),
  ),
  type: Schema.optional(MediaType),
})
export type RefreshMediaUrlRequest = typeof RefreshMediaUrlRequest.Type

export const RefreshMediaUrlResponse = Schema.TaggedStruct('RefreshMediaUrlResponse', {
  url: Schema.optional(HttpsUrl),
})
export type RefreshMediaUrlResponse = typeof RefreshMediaUrlResponse.Type

export const decodeRefreshMediaUrlRequest = (value: unknown): RefreshMediaUrlRequest | undefined =>
  exactly(
    value,
    MAX_MONITOR_MESSAGE_BYTES,
    'RefreshMediaUrlRequest',
    ['_tag', 'itemId', 'tweetId'],
    ['index', 'type'],
    RefreshMediaUrlRequest,
  )

export const decodeRefreshMediaUrlResponse = (
  value: unknown,
): RefreshMediaUrlResponse | undefined => {
  const reply = exactly(
    value,
    MAX_REFRESH_MEDIA_URL_RESPONSE_BYTES,
    'RefreshMediaUrlResponse',
    ['_tag'],
    ['url'],
    RefreshMediaUrlResponse,
  )
  return reply === undefined || reply.url === undefined || isHttpsUrl(reply.url) ? reply : undefined
}

export const TransferOutcome = Schema.TaggedStruct('TransferOutcome', {
  requestId: boundedText(MAX_SAVE_REQUEST_ID_LENGTH),
  outcome: Schema.Literals(['complete', 'failed']),
  at: nonnegativeSafeInteger,
})
export type TransferOutcome = typeof TransferOutcome.Type

export const decodeTransferOutcome = (value: unknown): TransferOutcome | undefined =>
  exactly(
    value,
    MAX_MONITOR_MESSAGE_BYTES,
    'TransferOutcome',
    ['_tag', 'requestId', 'outcome', 'at'],
    [],
    TransferOutcome,
  )
