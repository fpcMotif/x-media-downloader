import { Result, Schema } from 'effect'
import { hasWireKeys, isWireRecord } from '../wire/exact'
import { isJsonWithinByteBudget } from '../wire/json-budget'
import { MAX_CLOUD_ACCOUNT_LENGTH, MAX_OAUTH_CLIENT_ID_LENGTH } from './settings'

/** Enough for any JSON encoding of one capped OAuth client id, but not a general payload. */
export const MAX_CLOUD_CONNECT_REQUEST_BYTES = 16 * 1024

const boundedText = (maximum: number) =>
  Schema.String.pipe(Schema.check(Schema.isMaxLength(maximum)))
const nonNegativeSafeInteger = Schema.Number.check(
  Schema.isFinite(),
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
)
const CloudReplyText = boundedText(MAX_CLOUD_ACCOUNT_LENGTH)

// Cloud Sync probe requests share the cloud transport but have no payload.
export const SyncTestRequest = Schema.TaggedStruct('SyncTestRequest', {})
export type SyncTestRequest = typeof SyncTestRequest.Type

export const SyncStatusRequest = Schema.TaggedStruct('SyncStatusRequest', {})
export type SyncStatusRequest = typeof SyncStatusRequest.Type

// `core/cloud/types` derives its provider id from this schema, never the reverse.
export const CLOUD_PROVIDERS = ['gdrive', 'dropbox'] as const
export const CloudProvider = Schema.Literals(CLOUD_PROVIDERS)
export type CloudProvider = typeof CloudProvider.Type

/** Popup → worker OAuth intent. The worker owns token persistence. */
export const CloudConnectRequest = Schema.TaggedStruct('CloudConnectRequest', {
  provider: CloudProvider,
  clientId: boundedText(MAX_OAUTH_CLIENT_ID_LENGTH),
})
export type CloudConnectRequest = typeof CloudConnectRequest.Type

/** Exact UI reply for a completed provider OAuth attempt. */
export const CloudConnectSuccess = Schema.Struct({
  ok: Schema.Literal(true),
  detail: CloudReplyText,
  account: Schema.optional(CloudReplyText),
})
export type CloudConnectSuccess = typeof CloudConnectSuccess.Type

/** Exact UI reply for a declined or failed provider OAuth attempt. */
export const CloudConnectFailure = Schema.Struct({
  ok: Schema.Literal(false),
  detail: CloudReplyText,
})
export type CloudConnectFailure = typeof CloudConnectFailure.Type

export const CloudConnectResponse = Schema.Union([CloudConnectSuccess, CloudConnectFailure])
export type CloudConnectResponse = typeof CloudConnectResponse.Type

export const CloudDisconnectRequest = Schema.TaggedStruct('CloudDisconnectRequest', {
  provider: CloudProvider,
})
export type CloudDisconnectRequest = typeof CloudDisconnectRequest.Type

export const CloudStatusRequest = Schema.TaggedStruct('CloudStatusRequest', {})
export type CloudStatusRequest = typeof CloudStatusRequest.Type

export const CloudRetryRequest = Schema.TaggedStruct('CloudRetryRequest', {})
export type CloudRetryRequest = typeof CloudRetryRequest.Type

export const CloudBackfillRequest = Schema.TaggedStruct('CloudBackfillRequest', {})
export type CloudBackfillRequest = typeof CloudBackfillRequest.Type

/** Exact UI reply for the durable-history cloud-upload enqueue attempt. */
export const CloudBackfillResponse = Schema.Struct({
  ok: Schema.Boolean,
  queued: nonNegativeSafeInteger,
  detail: CloudReplyText,
})
export type CloudBackfillResponse = typeof CloudBackfillResponse.Type

export const CloudRequest = Schema.Union([
  SyncTestRequest,
  SyncStatusRequest,
  CloudConnectRequest,
  CloudDisconnectRequest,
  CloudStatusRequest,
  CloudRetryRequest,
  CloudBackfillRequest,
])
export type CloudRequest = typeof CloudRequest.Type

const decodeNoPayloadRequest = <
  Tag extends
    | SyncTestRequest['_tag']
    | SyncStatusRequest['_tag']
    | CloudStatusRequest['_tag']
    | CloudRetryRequest['_tag']
    | CloudBackfillRequest['_tag'],
>(
  value: unknown,
  tag: Tag,
): { readonly _tag: Tag } | undefined =>
  isWireRecord(value) && value._tag === tag && hasWireKeys(value, ['_tag'])
    ? { _tag: tag }
    : undefined

export const decodeSyncTestRequest = (value: unknown): SyncTestRequest | undefined =>
  decodeNoPayloadRequest(value, 'SyncTestRequest')

export const decodeSyncStatusRequest = (value: unknown): SyncStatusRequest | undefined =>
  decodeNoPayloadRequest(value, 'SyncStatusRequest')

/** Decode the bounded OAuth request exactly; never strip an unrecognised field. */
export const decodeCloudConnectRequest = (value: unknown): CloudConnectRequest | undefined => {
  if (
    !isWireRecord(value) ||
    value._tag !== 'CloudConnectRequest' ||
    !hasWireKeys(value, ['_tag', 'provider', 'clientId']) ||
    !isJsonWithinByteBudget(value, MAX_CLOUD_CONNECT_REQUEST_BYTES)
  )
    return undefined
  const decoded = Schema.decodeUnknownResult(CloudConnectRequest)(value)
  return Result.isSuccess(decoded) ? decoded.success : undefined
}

export const decodeCloudDisconnectRequest = (
  value: unknown,
): CloudDisconnectRequest | undefined => {
  if (
    !isWireRecord(value) ||
    value._tag !== 'CloudDisconnectRequest' ||
    !hasWireKeys(value, ['_tag', 'provider'])
  )
    return undefined
  const decoded = Schema.decodeUnknownResult(CloudDisconnectRequest)(value)
  return Result.isSuccess(decoded) ? decoded.success : undefined
}

export const decodeCloudStatusRequest = (value: unknown): CloudStatusRequest | undefined =>
  decodeNoPayloadRequest(value, 'CloudStatusRequest')

export const decodeCloudRetryRequest = (value: unknown): CloudRetryRequest | undefined =>
  decodeNoPayloadRequest(value, 'CloudRetryRequest')

export const decodeCloudBackfillRequest = (value: unknown): CloudBackfillRequest | undefined =>
  decodeNoPayloadRequest(value, 'CloudBackfillRequest')

/** Decode one exact cloud request. */
export const decodeCloudRequest = (value: unknown): CloudRequest | undefined => {
  if (!isWireRecord(value) || typeof value._tag !== 'string') return undefined
  switch (value._tag) {
    case 'SyncTestRequest':
      return decodeSyncTestRequest(value)
    case 'SyncStatusRequest':
      return decodeSyncStatusRequest(value)
    case 'CloudConnectRequest':
      return decodeCloudConnectRequest(value)
    case 'CloudDisconnectRequest':
      return decodeCloudDisconnectRequest(value)
    case 'CloudStatusRequest':
      return decodeCloudStatusRequest(value)
    case 'CloudRetryRequest':
      return decodeCloudRetryRequest(value)
    case 'CloudBackfillRequest':
      return decodeCloudBackfillRequest(value)
    default:
      return undefined
  }
}

/** Decode only the current, exact OAuth reply. */
export const decodeCloudConnectResponse = (value: unknown): CloudConnectResponse | undefined => {
  if (!isWireRecord(value)) return undefined
  if (value.ok === true) {
    const hasAccount = Object.hasOwn(value, 'account')
    const keys = hasAccount ? ['ok', 'detail', 'account'] : ['ok', 'detail']
    if (!hasWireKeys(value, keys)) return undefined
    if (hasAccount && typeof value.account !== 'string') return undefined
  } else if (value.ok === false) {
    if (!hasWireKeys(value, ['ok', 'detail'])) return undefined
  } else return undefined
  const decoded = Schema.decodeUnknownResult(CloudConnectResponse)(value)
  return Result.isSuccess(decoded) ? decoded.success : undefined
}

/** Decode only the current, exact backfill reply. */
export const decodeCloudBackfillResponse = (value: unknown): CloudBackfillResponse | undefined => {
  if (!isWireRecord(value) || !hasWireKeys(value, ['ok', 'queued', 'detail'])) return undefined
  const decoded = Schema.decodeUnknownResult(CloudBackfillResponse)(value)
  return Result.isSuccess(decoded) ? decoded.success : undefined
}
