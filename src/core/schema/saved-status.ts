import { Result, Schema } from 'effect'
import { hasWireKeys, isWireRecord } from '../wire/exact'
import { isJsonWithinByteBudget } from '../wire/json-budget'
import { MAX_SAVED_TWEET_IDS_PER_REQUEST } from '../wire/limits'
import { TweetSnowflake } from './tweet'

const SavedTweetIds = Schema.Array(TweetSnowflake).pipe(
  Schema.check(Schema.isMaxLength(MAX_SAVED_TWEET_IDS_PER_REQUEST), Schema.isUnique()),
)

/** Largest valid request: 100 quoted, 20-digit snowflakes plus its fixed JSON envelope. */
export const MAX_SAVED_STATUS_REQUEST_BYTES =
  '{"_tag":"SavedStatusRequest","tweetIds":['.length +
  MAX_SAVED_TWEET_IDS_PER_REQUEST * 22 +
  (MAX_SAVED_TWEET_IDS_PER_REQUEST - 1) +
  ']}'.length

/** Content → background: probe these known X post IDs. */
export const SavedStatusRequest = Schema.TaggedStruct('SavedStatusRequest', {
  tweetIds: SavedTweetIds,
})
export type SavedStatusRequest = typeof SavedStatusRequest.Type

/** Background → content: saved IDs from one specific probe. */
export const SavedStatusResponse = Schema.TaggedStruct('SavedStatusResponse', {
  saved: SavedTweetIds,
})
export type SavedStatusResponse = typeof SavedStatusResponse.Type

/** Background → content broadcast: late saved IDs from cross-device refresh. */
export const SavedStatusUpdate = Schema.TaggedStruct('SavedStatusUpdate', {
  saved: SavedTweetIds,
})
export type SavedStatusUpdate = typeof SavedStatusUpdate.Type

/** Exact, bounded Saved-status request decoder. */
export const decodeSavedStatusRequest = (value: unknown): SavedStatusRequest | undefined => {
  if (
    !isJsonWithinByteBudget(value, MAX_SAVED_STATUS_REQUEST_BYTES) ||
    !isWireRecord(value) ||
    !hasWireKeys(value, ['_tag', 'tweetIds'])
  )
    return undefined
  const parsed = Schema.decodeUnknownResult(SavedStatusRequest)(value)
  return Result.isSuccess(parsed) ? parsed.success : undefined
}

/** Exact reply decoder. A reply cannot claim an ID outside its probe. */
export const decodeSavedStatusResponse = (
  value: unknown,
  requestedTweetIds?: ReadonlyArray<string>,
): SavedStatusResponse | undefined => {
  if (!isWireRecord(value) || !hasWireKeys(value, ['_tag', 'saved'])) return undefined
  const parsed = Schema.decodeUnknownResult(SavedStatusResponse)(value)
  if (Result.isFailure(parsed)) return undefined
  if (requestedTweetIds === undefined) return parsed.success
  const requested = new Set(requestedTweetIds)
  return parsed.success.saved.every((tweetId) => requested.has(tweetId))
    ? parsed.success
    : undefined
}

/** Exact, bounded decoder for late Saved-status broadcasts. */
export const decodeSavedStatusUpdate = (value: unknown): SavedStatusUpdate | undefined => {
  if (!isWireRecord(value) || !hasWireKeys(value, ['_tag', 'saved'])) return undefined
  const parsed = Schema.decodeUnknownResult(SavedStatusUpdate)(value)
  return Result.isSuccess(parsed) ? parsed.success : undefined
}
