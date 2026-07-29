import { Schema } from 'effect'
import { MAX_CAPTURE_RECORD_BYTES } from './contract'
import { isJsonWithinByteBudget } from '../wire/json-budget'

export const MAX_CAPTURE_URL_LENGTH = 8_192
export const MAX_CAPTURE_HANDLE_LENGTH = 64
const MAX_NAME_LENGTH = 256
const MAX_LANGUAGE_TAG_LENGTH = 64
const MAX_MEDIA_ID_LENGTH = 512
const MAX_EXTENSION_LENGTH = 32
export const MAX_CAPTURE_LINKS = 100
const MAX_MENTIONS = 100
const MAX_HASHTAGS = 100

const Snowflake = Schema.String.check(Schema.isPattern(/^\d{1,20}$/))
const Handle = Schema.String.check(Schema.isMaxLength(MAX_CAPTURE_HANDLE_LENGTH))
const Url = Schema.String.check(Schema.isMaxLength(MAX_CAPTURE_URL_LENGTH))
const SafeNonNegativeInteger = Schema.Number.check(
  Schema.isFinite(),
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
)

const uniqueBy = <T>(key: (value: T) => string | number) =>
  Schema.makeFilter<ReadonlyArray<T>>((items) =>
    new Set(items.map(key)).size === items.length ? undefined : 'items must be unique',
  )

const uniqueText = Schema.makeFilter<ReadonlyArray<string>>((items) =>
  new Set(items.map((item) => item.toLowerCase())).size === items.length
    ? undefined
    : 'items must be unique',
)

/** Stable author fields carried by a normalized captured tweet. */
export const Author = Schema.Struct({
  // The parser may not find an author on a partial X response, so empty remains
  // representable; the bound still limits untrusted metadata.
  handle: Handle,
  name: Schema.optional(Schema.String.check(Schema.isMaxLength(MAX_NAME_LENGTH))),
  userId: Schema.optional(Snowflake),
})
export type Author = typeof Author.Type

/** Normalized link fields, independent of X's raw entity shape. */
export const Link = Schema.Struct({
  expandedUrl: Url,
  displayUrl: Schema.optional(Schema.String.check(Schema.isMaxLength(MAX_CAPTURE_URL_LENGTH))),
  title: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(8_192))),
  domain: Schema.optional(Schema.String.check(Schema.isMaxLength(255))),
})
export type Link = typeof Link.Type

const Links = Schema.Array(Link).check(
  Schema.isMaxLength(MAX_CAPTURE_LINKS),
  uniqueBy((link) => link.expandedUrl),
)

/** Media identity and description fields, with no download-lifecycle state. */
export const MediaRef = Schema.Struct({
  id: Schema.String.check(Schema.isMaxLength(MAX_MEDIA_ID_LENGTH)),
  type: Schema.Literals(['photo', 'video', 'gif']),
  url: Url,
  ext: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_EXTENSION_LENGTH)),
  index: SafeNonNegativeInteger,
  width: Schema.optional(SafeNonNegativeInteger),
  height: Schema.optional(SafeNonNegativeInteger),
})
export type MediaRef = typeof MediaRef.Type

const Media = Schema.Array(MediaRef).check(
  Schema.isMaxLength(4),
  uniqueBy((media) => media.id),
  uniqueBy((media) => media.index),
)
const Mentions = Schema.Array(Handle).check(Schema.isMaxLength(MAX_MENTIONS), uniqueText)
const Hashtags = Schema.Array(Schema.String.check(Schema.isMaxLength(256))).check(
  Schema.isMaxLength(MAX_HASHTAGS),
  uniqueText,
)
const Source = Schema.Literals(['tweetDetail', 'timeline', 'other'])

/** A normalized, self-consistent snapshot of one captured tweet (spec §6.1). */
export const TweetRecord = Schema.Struct({
  tweetId: Snowflake,
  conversationId: Snowflake,
  inReplyToTweetId: Schema.optional(Snowflake),
  inReplyToHandle: Schema.optional(Handle),
  author: Author,
  // Long-form text is bounded by the whole-record JSON budget below, not an
  // arbitrary character cap that could reject valid Unicode-heavy posts.
  text: Schema.String,
  rawText: Schema.String,
  createdAt: Schema.optional(SafeNonNegativeInteger),
  lang: Schema.optional(Schema.String.check(Schema.isMaxLength(MAX_LANGUAGE_TAG_LENGTH))),
  links: Links,
  media: Media,
  mentions: Mentions,
  hashtags: Hashtags,
  quotedTweetId: Schema.optional(Snowflake),
  retweetOf: Schema.optional(Snowflake),
  source: Source,
  sourceRank: Schema.Literals([1, 2]),
  capturedAt: SafeNonNegativeInteger,
}).check(
  Schema.makeFilter((record) => {
    const issues: Schema.FilterIssue[] = []
    if (!isJsonWithinByteBudget(record, MAX_CAPTURE_RECORD_BYTES))
      issues.push('capture record exceeds the JSON byte budget')
    const expectedRank = record.source === 'tweetDetail' ? 2 : 1
    if (record.sourceRank !== expectedRank)
      issues.push({ path: ['sourceRank'], issue: 'sourceRank must match source' })
    return issues
  }),
)
export type TweetRecord = typeof TweetRecord.Type
