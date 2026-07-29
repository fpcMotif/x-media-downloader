import { Result, Schema } from 'effect'
import { hasWireKeys, isWireRecord, readWireDataProperty, readWireTag } from '../wire/exact'
import { isJsonWithinByteBudget } from '../wire/json-budget'
import { TweetSnowflake } from './tweet'

export const ClearScope = Schema.Literals(['bookmark', 'like', 'notInterested'])
export type ClearScope = typeof ClearScope.Type

const CLEAR_SCOPE_LIMIT = 3
/** At most 100 fixed-shape log rows; this leaves headroom for JSON escaping. */
export const MAX_CLEAR_RESPONSE_BYTES = 32 * 1024
/** Clear logs only link to the canonical X status path. */
export const MAX_CLEAR_PERMALINK_LENGTH = 'https://x.com/i/status/'.length + 20
const safeNonnegativeInteger = Schema.Number.check(
  Schema.isFinite(),
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
)

/** Locate can inspect each scope once. */
export const ClearScopeList = Schema.Array(ClearScope).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(CLEAR_SCOPE_LIMIT),
  Schema.isUnique(),
)
export type ClearScopeList = typeof ClearScopeList.Type

/** Clear may act on exactly one preflighted scope. */
export const SingleClearScopeList = Schema.Array(ClearScope).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1),
)
export type SingleClearScopeList = typeof SingleClearScopeList.Type

/** Manual sweeps are list-only. They cannot target Not interested. */
export const SweepScope = Schema.Literals(['bookmark', 'like'])
export type SweepScope = typeof SweepScope.Type

export const LocateClearTweetRequest = Schema.TaggedStruct('LocateClearTweetRequest', {
  tweetId: TweetSnowflake,
  scopes: ClearScopeList,
  allLists: Schema.Boolean,
})
export type LocateClearTweetRequest = typeof LocateClearTweetRequest.Type

export const LocateClearState = Schema.Literals([
  'actionable',
  'already-clear',
  'not-applicable',
  'unknown',
])
export type LocateClearState = typeof LocateClearState.Type

export const LocateClearScopeResult = Schema.Struct({
  scope: ClearScope,
  state: LocateClearState,
})
export type LocateClearScopeResult = typeof LocateClearScopeResult.Type

export const LocateClearTweetResponse = Schema.TaggedStruct('LocateClearTweetResponse', {
  mounted: Schema.Boolean,
  results: Schema.optional(
    Schema.Array(LocateClearScopeResult).check(Schema.isMaxLength(CLEAR_SCOPE_LIMIT)),
  ),
})
export type LocateClearTweetResponse = typeof LocateClearTweetResponse.Type

/** The destructive command remains separate from read-only Locate. */
export const ClearTweetRequest = Schema.TaggedStruct('ClearTweetRequest', {
  tweetId: TweetSnowflake,
  scopes: SingleClearScopeList,
  allLists: Schema.Boolean,
})
export type ClearTweetRequest = typeof ClearTweetRequest.Type

export const ClearTweetState = Schema.Literals([
  'cleared',
  'already-clear',
  'not-actionable',
  'preflight-failed',
  'uncertain',
])
export type ClearTweetState = typeof ClearTweetState.Type

export const ClearTweetScopeResult = Schema.Struct({
  scope: ClearScope,
  state: ClearTweetState,
})
export type ClearTweetScopeResult = typeof ClearTweetScopeResult.Type

export const ClearTweetResponse = Schema.TaggedStruct('ClearTweetResponse', {
  results: Schema.Array(ClearTweetScopeResult).check(Schema.isMinLength(1), Schema.isMaxLength(1)),
})
export type ClearTweetResponse = typeof ClearTweetResponse.Type

const readWireArray = (value: unknown, maxRows: number): ReadonlyArray<unknown> | undefined => {
  try {
    if (!Number.isSafeInteger(maxRows) || maxRows < 0 || !Array.isArray(value)) return undefined
    const length = Object.getOwnPropertyDescriptor(value, 'length')
    if (
      length === undefined ||
      !('value' in length) ||
      !Number.isSafeInteger(length.value) ||
      length.value > maxRows
    )
      return undefined
    const rows: unknown[] = []
    for (let index = 0; index < length.value; index += 1) {
      const row = Object.getOwnPropertyDescriptor(value, String(index))
      if (row === undefined || !row.enumerable || !('value' in row)) return undefined
      rows.push(row.value)
    }
    return rows
  } catch {
    return undefined
  }
}

type ClearScopeResultSnapshot = { readonly scope: unknown; readonly state: unknown }

const readClearScopeResult = (value: unknown): ClearScopeResultSnapshot | undefined => {
  if (!isWireRecord(value) || !hasWireKeys(value, ['scope', 'state'])) return undefined
  const scope = readWireDataProperty(value, 'scope')
  const state = readWireDataProperty(value, 'state')
  return scope === undefined || state === undefined
    ? undefined
    : { scope: scope.value, state: state.value }
}

const readRequestedScopeSet = (
  value: unknown,
  scopes: readonly ClearScope[],
): ReadonlyArray<ClearScopeResultSnapshot> | undefined => {
  const results = readWireArray(value, scopes.length)
  if (results === undefined || results.length !== scopes.length) return undefined
  const decoded = results.map(readClearScopeResult)
  if (
    decoded.some((result) => result === undefined) ||
    decoded.some((result) => result === undefined || !scopes.includes(result.scope as ClearScope))
  )
    return undefined
  const exact = decoded as ClearScopeResultSnapshot[]
  return new Set(exact.map((result) => result.scope)).size === exact.length ? exact : undefined
}

type LocateClearTweetResponseSnapshot =
  | { readonly _tag: 'LocateClearTweetResponse'; readonly mounted: false }
  | {
      readonly _tag: 'LocateClearTweetResponse'
      readonly mounted: true
      readonly results: ReadonlyArray<ClearScopeResultSnapshot>
    }

const snapshotLocateClearTweetResponse = (
  value: unknown,
  scopes: readonly ClearScope[],
): LocateClearTweetResponseSnapshot | undefined => {
  if (!isWireRecord(value) || readWireTag(value) !== 'LocateClearTweetResponse') return undefined
  const mounted = readWireDataProperty(value, 'mounted')
  if (mounted?.value === false && hasWireKeys(value, ['_tag', 'mounted']))
    return { _tag: 'LocateClearTweetResponse', mounted: false }
  if (mounted?.value !== true || !hasWireKeys(value, ['_tag', 'mounted', 'results']))
    return undefined
  const results = readWireDataProperty(value, 'results')
  const snapshot = results === undefined ? undefined : readRequestedScopeSet(results.value, scopes)
  return snapshot === undefined
    ? undefined
    : { _tag: 'LocateClearTweetResponse', mounted: true, results: snapshot }
}

type ClearTweetResponseSnapshot = {
  readonly _tag: 'ClearTweetResponse'
  readonly results: ReadonlyArray<ClearScopeResultSnapshot>
}

const snapshotClearTweetResponse = (
  value: unknown,
  scopes: readonly ClearScope[],
): ClearTweetResponseSnapshot | undefined => {
  if (
    !isWireRecord(value) ||
    readWireTag(value) !== 'ClearTweetResponse' ||
    !hasWireKeys(value, ['_tag', 'results'])
  )
    return undefined
  const results = readWireDataProperty(value, 'results')
  const snapshot = results === undefined ? undefined : readRequestedScopeSet(results.value, scopes)
  return snapshot === undefined ? undefined : { _tag: 'ClearTweetResponse', results: snapshot }
}

/** Exact read-only reply. Bad replies cannot select a destructive target. */
export const decodeLocateClearTweetResponse = (
  value: unknown,
  scopes: readonly ClearScope[],
): LocateClearTweetResponse | undefined => {
  const snapshot = snapshotLocateClearTweetResponse(value, scopes)
  if (snapshot === undefined || !isJsonWithinByteBudget(snapshot, MAX_CLEAR_RESPONSE_BYTES))
    return undefined
  const decoded = Schema.decodeUnknownResult(LocateClearTweetResponse, {
    onExcessProperty: 'error',
  })(snapshot)
  return Result.isSuccess(decoded) ? decoded.success : undefined
}

/** Exact destructive reply. Malformed means uncertain to the caller. */
export const decodeClearTweetResponse = (
  value: unknown,
  scopes: readonly ClearScope[],
): ClearTweetResponse | undefined => {
  const snapshot = snapshotClearTweetResponse(value, scopes)
  if (snapshot === undefined || !isJsonWithinByteBudget(snapshot, MAX_CLEAR_RESPONSE_BYTES))
    return undefined
  const decoded = Schema.decodeUnknownResult(ClearTweetResponse, { onExcessProperty: 'error' })({
    ...snapshot,
  })
  return Result.isSuccess(decoded) ? decoded.success : undefined
}

export const ClearLogRequest = Schema.TaggedStruct('ClearLogRequest', {})
export type ClearLogRequest = typeof ClearLogRequest.Type

export const CLEAR_LOG_LIMIT = 100

export const ClearLogRecord = Schema.Struct({
  tweetId: TweetSnowflake,
  scope: ClearScope,
  at: safeNonnegativeInteger,
  mechanism: Schema.Literals(['dom-click']),
  permalink: Schema.String.check(Schema.isMaxLength(MAX_CLEAR_PERMALINK_LENGTH)),
})
export type ClearLogRecord = typeof ClearLogRecord.Type

export const ClearLogSuccess = Schema.TaggedStruct('ClearLogSuccess', {
  records: Schema.Array(ClearLogRecord).check(Schema.isMaxLength(CLEAR_LOG_LIMIT)),
})
export type ClearLogSuccess = typeof ClearLogSuccess.Type

export const ClearLogUnavailable = Schema.TaggedStruct('ClearLogUnavailable', {})
export type ClearLogUnavailable = typeof ClearLogUnavailable.Type

export const ClearLogResponse = Schema.Union([ClearLogSuccess, ClearLogUnavailable])
export type ClearLogResponse = typeof ClearLogResponse.Type

export const decodeClearLogRequest = (value: unknown): ClearLogRequest | undefined =>
  isWireRecord(value) && readWireTag(value) === 'ClearLogRequest' && hasWireKeys(value, ['_tag'])
    ? { _tag: 'ClearLogRequest' }
    : undefined

type ClearLogRecordSnapshot = {
  readonly tweetId: unknown
  readonly scope: unknown
  readonly at: unknown
  readonly mechanism: unknown
  readonly permalink: unknown
}

const snapshotClearLogRecord = (value: unknown): ClearLogRecordSnapshot | undefined => {
  if (
    !isWireRecord(value) ||
    !hasWireKeys(value, ['tweetId', 'scope', 'at', 'mechanism', 'permalink'])
  )
    return undefined
  const tweetId = readWireDataProperty(value, 'tweetId')
  const scope = readWireDataProperty(value, 'scope')
  const at = readWireDataProperty(value, 'at')
  const mechanism = readWireDataProperty(value, 'mechanism')
  const permalink = readWireDataProperty(value, 'permalink')
  if (
    tweetId === undefined ||
    scope === undefined ||
    at === undefined ||
    mechanism === undefined ||
    permalink === undefined
  )
    return undefined
  return {
    tweetId: tweetId.value,
    scope: scope.value,
    at: at.value,
    mechanism: mechanism.value,
    permalink: permalink.value,
  }
}

const decodeClearLogRecord = (value: ClearLogRecordSnapshot): ClearLogRecord | undefined => {
  const decoded = Schema.decodeUnknownResult(ClearLogRecord, { onExcessProperty: 'error' })(value)
  return Result.isSuccess(decoded) &&
    decoded.success.permalink === `https://x.com/i/status/${decoded.success.tweetId}`
    ? decoded.success
    : undefined
}

const isClearLogNewestFirst = (records: readonly ClearLogRecord[]): boolean =>
  records.every((record, index) => {
    const previous = records[index - 1]
    if (previous === undefined) return true
    if (previous.at !== record.at) return previous.at > record.at
    const byTweet = previous.tweetId.localeCompare(record.tweetId)
    return byTweet < 0 || (byTweet === 0 && previous.scope.localeCompare(record.scope) < 0)
  })

type ClearLogResponseSnapshot =
  | { readonly _tag: 'ClearLogUnavailable' }
  | { readonly _tag: 'ClearLogSuccess'; readonly records: ReadonlyArray<ClearLogRecordSnapshot> }

const snapshotClearLogResponse = (value: unknown): ClearLogResponseSnapshot | undefined => {
  if (!isWireRecord(value)) return undefined
  const tag = readWireTag(value)
  if (tag === 'ClearLogUnavailable')
    return hasWireKeys(value, ['_tag']) ? { _tag: 'ClearLogUnavailable' } : undefined
  if (tag !== 'ClearLogSuccess' || !hasWireKeys(value, ['_tag', 'records'])) return undefined
  const rawRecords = readWireDataProperty(value, 'records')
  const rows =
    rawRecords === undefined ? undefined : readWireArray(rawRecords.value, CLEAR_LOG_LIMIT)
  if (rows === undefined) return undefined
  const records = rows.map(snapshotClearLogRecord)
  return records.some((record) => record === undefined)
    ? undefined
    : { _tag: 'ClearLogSuccess', records: records as ClearLogRecordSnapshot[] }
}

/** Exact, bounded, verified newest-first Clear Log projection. */
export const decodeClearLogResponse = (value: unknown): ClearLogResponse | undefined => {
  const snapshot = snapshotClearLogResponse(value)
  if (snapshot === undefined || !isJsonWithinByteBudget(snapshot, MAX_CLEAR_RESPONSE_BYTES))
    return undefined
  if (snapshot._tag === 'ClearLogUnavailable') return snapshot
  const records = snapshot.records.map(decodeClearLogRecord)
  if (records.some((record) => record === undefined)) return undefined
  const decoded = records as ClearLogRecord[]
  if (
    !isClearLogNewestFirst(decoded) ||
    new Set(decoded.map((record) => `${record.tweetId}/${record.scope}`)).size !== decoded.length
  )
    return undefined
  return { _tag: 'ClearLogSuccess', records: decoded }
}

export const CLEAR_VISIBILITY_PULSE_LIMIT = 100

/** Content hint only; it cannot authorize a Clear. */
export const ClearVisibilityPulse = Schema.TaggedStruct('ClearVisibilityPulse', {
  tweetIds: Schema.Array(TweetSnowflake).check(
    Schema.isMaxLength(CLEAR_VISIBILITY_PULSE_LIMIT),
    Schema.isUnique(),
  ),
})
export type ClearVisibilityPulse = typeof ClearVisibilityPulse.Type
