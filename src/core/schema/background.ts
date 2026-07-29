import { Result, Schema } from 'effect'
import {
  CaptureEpochRequest,
  CaptureSummaryRequest,
  CaptureTweets,
  ClearCaptureRequest,
  ExportCaptureRequest,
  decodeCaptureEpochRequest,
  decodeCaptureSummaryRequest,
  decodeCaptureTweets,
  decodeClearCaptureRequest,
  decodeExportCaptureRequest,
} from './capture'
import { ClearLogRequest, ClearVisibilityPulse, decodeClearLogRequest } from './clear'
import {
  CloudBackfillRequest,
  CloudConnectRequest,
  CloudDisconnectRequest,
  CloudRetryRequest,
  CloudStatusRequest,
  SyncStatusRequest,
  SyncTestRequest,
  decodeCloudBackfillRequest,
  decodeCloudConnectRequest,
  decodeCloudDisconnectRequest,
  decodeCloudRetryRequest,
  decodeCloudStatusRequest,
  decodeSyncStatusRequest,
  decodeSyncTestRequest,
} from './cloud'
import {
  DailyBudgetReadRequest,
  DailyBudgetResetRequest,
  decodeDailyBudgetReadRequest,
  decodeDailyBudgetResetRequest,
} from './daily-budget'
import { TweetSnowflake } from './tweet'
import {
  ClearDownloadMonitorRequest,
  DownloadRequest,
  DownloadTraceEvent,
  MetricsRequest,
  SweepEnqueueRequest,
  decodeClearDownloadMonitorRequest,
  decodeDownloadRequest,
  decodeDownloadTraceEvent,
  decodeMetricsRequest,
  decodeSweepEnqueueRequest,
} from './download'
import {
  ClearHistoryRequest,
  HistoryRequest,
  decodeClearHistoryRequest,
  decodeHistoryRequest,
} from './history'
import {
  SettingsReadRequest,
  SettingsUpdateRequest,
  decodeSettingsReadRequest,
  decodeSettingsUpdateRequest,
} from './settings'
import { SettingsRecoveryRequest, decodeSettingsRecoveryRequest } from './settings-recovery'
import { SavedStatusRequest, decodeSavedStatusRequest } from './saved-status'
import { TransferRecoveryRequest, decodeTransferRecoveryRequest } from './transfer-recovery'
import { hasWireKeys, isWireRecord, readWireTag } from '../wire/exact'
import { isJsonWithinByteBudget } from '../wire/json-budget'
import { utf8ByteLengthAtMost } from '../wire/utf8'
import { MAX_SYNDICATION_BODY_BYTES } from '../wire/limits'
import { MAX_CAPTURE_MESSAGE_BYTES } from '../capture/contract'

/** Largest worker-bound request. Each selected decoder applies its narrower cap. */
export const MAX_BACKGROUND_REQUEST_BYTES = MAX_CAPTURE_MESSAGE_BYTES
const SMALL_REQUEST_BYTES = 64 * 1024
export const MAX_RECOVER_TWEET_MEDIA_BODY_BYTES = MAX_SYNDICATION_BODY_BYTES
export const MAX_RECOVER_TWEET_MEDIA_RESPONSE_BYTES = MAX_RECOVER_TWEET_MEDIA_BODY_BYTES * 6 + 128

/** Content → worker: request bounded syndication recovery for one X post. */
export const RecoverTweetMediaRequest = Schema.TaggedStruct('RecoverTweetMediaRequest', {
  tweetId: TweetSnowflake,
})
export type RecoverTweetMediaRequest = typeof RecoverTweetMediaRequest.Type
export const RecoverTweetMediaResponse = Schema.TaggedStruct('RecoverTweetMediaResponse', {
  body: Schema.optional(
    Schema.String.check(Schema.isMaxLength(MAX_RECOVER_TWEET_MEDIA_BODY_BYTES)),
  ),
})
export type RecoverTweetMediaResponse = typeof RecoverTweetMediaResponse.Type

export const BackgroundRequest = Schema.Union([
  SettingsUpdateRequest,
  SettingsReadRequest,
  SettingsRecoveryRequest,
  DownloadRequest,
  MetricsRequest,
  DownloadTraceEvent,
  ClearDownloadMonitorRequest,
  HistoryRequest,
  ClearHistoryRequest,
  TransferRecoveryRequest,
  DailyBudgetReadRequest,
  DailyBudgetResetRequest,
  ClearLogRequest,
  SyncTestRequest,
  SyncStatusRequest,
  CloudConnectRequest,
  CloudDisconnectRequest,
  CloudStatusRequest,
  CloudRetryRequest,
  CloudBackfillRequest,
  SweepEnqueueRequest,
  ClearVisibilityPulse,
  RecoverTweetMediaRequest,
  SavedStatusRequest,
  CaptureEpochRequest,
  CaptureTweets,
  CaptureSummaryRequest,
  ExportCaptureRequest,
  ClearCaptureRequest,
])
export type BackgroundRequest = typeof BackgroundRequest.Type

const decodeExact = <A>(schema: Schema.ConstraintDecoder<A>, value: unknown): A | undefined => {
  const decoded = Schema.decodeUnknownResult(schema, {
    onExcessProperty: 'error',
  })(value)
  return Result.isSuccess(decoded) ? decoded.success : undefined
}
const isSmallRequest = (value: unknown): boolean =>
  isJsonWithinByteBudget(value, SMALL_REQUEST_BYTES)
const decodeClearVisibilityPulse = (value: unknown): ClearVisibilityPulse | undefined =>
  isSmallRequest(value) &&
  isWireRecord(value) &&
  value._tag === 'ClearVisibilityPulse' &&
  hasWireKeys(value, ['_tag', 'tweetIds'])
    ? decodeExact(ClearVisibilityPulse, value)
    : undefined
const decodeRecoverTweetMediaRequest = (value: unknown): RecoverTweetMediaRequest | undefined =>
  isSmallRequest(value) &&
  isWireRecord(value) &&
  value._tag === 'RecoverTweetMediaRequest' &&
  hasWireKeys(value, ['_tag', 'tweetId'])
    ? decodeExact(RecoverTweetMediaRequest, value)
    : undefined

/** Exact bounded reply decoder for content recovery callers. */
export const decodeRecoverTweetMediaResponse = (
  value: unknown,
): RecoverTweetMediaResponse | undefined => {
  if (
    !isJsonWithinByteBudget(value, MAX_RECOVER_TWEET_MEDIA_RESPONSE_BYTES) ||
    !isWireRecord(value) ||
    value._tag !== 'RecoverTweetMediaResponse'
  )
    return undefined
  const keys = Object.hasOwn(value, 'body') ? ['_tag', 'body'] : ['_tag']
  if (!hasWireKeys(value, keys)) return undefined
  const reply = decodeExact(RecoverTweetMediaResponse, value)
  return reply === undefined ||
    reply.body === undefined ||
    utf8ByteLengthAtMost(reply.body, MAX_RECOVER_TWEET_MEDIA_BODY_BYTES) !== undefined
    ? reply
    : undefined
}

/** Cheap dispatch only. The selected decoder proves shape and byte bounds. */
export const readBackgroundRequestTag = readWireTag

/**
 * The sole worker ingress decoder. It rejects invalid tags, wrong directions,
 * excess keys, hostile records, and over-budget payloads before Effect decoding.
 */
export const decodeBackgroundRequest = (
  value: unknown,
): Result.Result<BackgroundRequest, Error> => {
  const tag = readBackgroundRequestTag(value)
  if (tag === undefined) return Result.fail(new Error('Invalid background message'))
  const decoded = (() => {
    switch (tag) {
      case 'SettingsUpdateRequest':
        return decodeSettingsUpdateRequest(value)
      case 'SettingsReadRequest':
        return isSmallRequest(value) ? decodeSettingsReadRequest(value) : undefined
      case 'SettingsRecoveryRequest':
        return isSmallRequest(value) ? decodeSettingsRecoveryRequest(value) : undefined
      case 'DownloadRequest':
        return decodeDownloadRequest(value)
      case 'MetricsRequest':
        return decodeMetricsRequest(value)
      case 'DownloadTraceEvent':
        return decodeDownloadTraceEvent(value)
      case 'ClearDownloadMonitorRequest':
        return decodeClearDownloadMonitorRequest(value)
      case 'HistoryRequest':
        return decodeHistoryRequest(value)
      case 'ClearHistoryRequest':
        return decodeClearHistoryRequest(value)
      case 'TransferRecoveryRequest':
        return isSmallRequest(value) ? decodeTransferRecoveryRequest(value) : undefined
      case 'DailyBudgetReadRequest':
        return isSmallRequest(value) ? decodeDailyBudgetReadRequest(value) : undefined
      case 'DailyBudgetResetRequest':
        return isSmallRequest(value) ? decodeDailyBudgetResetRequest(value) : undefined
      case 'ClearLogRequest':
        return isSmallRequest(value) ? decodeClearLogRequest(value) : undefined
      case 'SyncTestRequest':
        return isSmallRequest(value) ? decodeSyncTestRequest(value) : undefined
      case 'SyncStatusRequest':
        return isSmallRequest(value) ? decodeSyncStatusRequest(value) : undefined
      case 'CloudConnectRequest':
        return decodeCloudConnectRequest(value)
      case 'CloudDisconnectRequest':
        return isSmallRequest(value) ? decodeCloudDisconnectRequest(value) : undefined
      case 'CloudStatusRequest':
        return isSmallRequest(value) ? decodeCloudStatusRequest(value) : undefined
      case 'CloudRetryRequest':
        return isSmallRequest(value) ? decodeCloudRetryRequest(value) : undefined
      case 'CloudBackfillRequest':
        return isSmallRequest(value) ? decodeCloudBackfillRequest(value) : undefined
      case 'SweepEnqueueRequest':
        return decodeSweepEnqueueRequest(value)
      case 'ClearVisibilityPulse':
        return decodeClearVisibilityPulse(value)
      case 'RecoverTweetMediaRequest':
        return decodeRecoverTweetMediaRequest(value)
      case 'SavedStatusRequest':
        return decodeSavedStatusRequest(value)
      case 'CaptureEpochRequest':
        return isSmallRequest(value) ? decodeCaptureEpochRequest(value) : undefined
      case 'CaptureTweets':
        return decodeCaptureTweets(value)
      case 'CaptureSummaryRequest':
        return isSmallRequest(value) ? decodeCaptureSummaryRequest(value) : undefined
      case 'ExportCaptureRequest':
        return isSmallRequest(value) ? decodeExportCaptureRequest(value) : undefined
      case 'ClearCaptureRequest':
        return isSmallRequest(value) ? decodeClearCaptureRequest(value) : undefined
      default:
        return undefined
    }
  })()
  return decoded === undefined
    ? Result.fail(new Error(`Invalid ${tag}`))
    : Result.succeed(decoded as BackgroundRequest)
}
