import { Result, Schema } from 'effect'
import { hasWireKeys, isWireRecord } from '../wire/exact'
import { isJsonWithinByteBudget } from '../wire/json-budget'
import { MAX_MEDIA_ID_LENGTH } from '../wire/limits'

export const MAX_MEDIA_ITEM_BYTES = 16 * 1024
export { MAX_MEDIA_ID_LENGTH } from '../wire/limits'
export const MAX_MEDIA_POST_ID_LENGTH = 128
export const MAX_MEDIA_AUTHOR_LENGTH = 256
export const MAX_MEDIA_URL_LENGTH = 8 * 1024
export const MAX_MEDIA_EXTENSION_LENGTH = 16
export const MAX_MEDIA_INDEX = 1023
export const MAX_MEDIA_DIMENSION = 1_000_000
export const MAX_MEDIA_BITRATE = 1_000_000_000

const boundedString = (maxLength: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maxLength))

const safeInteger = (maximum: number) => Schema.Int.check(Schema.isBetween({ minimum: 0, maximum }))

export const MediaId = boundedString(MAX_MEDIA_ID_LENGTH)
export const MediaPostId = boundedString(MAX_MEDIA_POST_ID_LENGTH)
export const MediaAuthor = Schema.String.check(Schema.isMaxLength(MAX_MEDIA_AUTHOR_LENGTH))
export const MediaUrl = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_MEDIA_URL_LENGTH),
  Schema.isPattern(/^https:\/\//u),
)
export const MediaExtension = boundedString(MAX_MEDIA_EXTENSION_LENGTH)
export const MediaIndex = safeInteger(MAX_MEDIA_INDEX)

/** Bounded, parseable HTTPS media URL. Shared by untrusted media ingress. */
export const isHttpsMediaUrl = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_MEDIA_URL_LENGTH) {
    return false
  }
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

export const MediaType = Schema.Literals(['photo', 'video', 'gif'])
export type MediaType = typeof MediaType.Type

/** Which site a Media Item was detected on. Drives adapter dispatch and sync tags. */
export const Platform = Schema.Literals(['x', 'instagram', 'threads'])
export type Platform = typeof Platform.Type

/**
 * The persisted and wire-safe media description. Exactness belongs to
 * `decodeMediaItem`; internal producers use this structural schema directly.
 */
export const MediaItem = Schema.Struct({
  id: MediaId,
  platform: Platform,
  postId: MediaPostId,
  author: MediaAuthor,
  type: MediaType,
  url: MediaUrl,
  previewUrl: Schema.optional(MediaUrl),
  ext: MediaExtension,
  index: MediaIndex,
  width: Schema.optional(safeInteger(MAX_MEDIA_DIMENSION)),
  height: Schema.optional(safeInteger(MAX_MEDIA_DIMENSION)),
  bitrate: Schema.optional(safeInteger(MAX_MEDIA_BITRATE)),
})
export type MediaItem = typeof MediaItem.Type

const mediaItemKeys = [
  'id',
  'platform',
  'postId',
  'author',
  'type',
  'url',
  'ext',
  'index',
  'previewUrl',
  'width',
  'height',
  'bitrate',
] as const

/** Exact, size-limited, HTTPS-only Media Item decoder for untrusted transport. */
export const decodeMediaItem = (value: unknown): MediaItem | undefined => {
  if (!isJsonWithinByteBudget(value, MAX_MEDIA_ITEM_BYTES) || !isWireRecord(value)) return undefined
  const keys = mediaItemKeys.filter((key) =>
    key === 'previewUrl' || key === 'width' || key === 'height' || key === 'bitrate'
      ? Object.hasOwn(value, key)
      : true,
  )
  if (!hasWireKeys(value, keys)) return undefined
  const decoded = Schema.decodeUnknownResult(MediaItem, { onExcessProperty: 'error' })(value)
  if (Result.isFailure(decoded) || !isHttpsMediaUrl(decoded.success.url)) return undefined
  if (decoded.success.previewUrl !== undefined && !isHttpsMediaUrl(decoded.success.previewUrl))
    return undefined
  return decoded.success
}
