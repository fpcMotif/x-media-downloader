import { Schema } from 'effect'
import { findAuthor, type Author } from '@/core/adapters/x/walk'
import { resolveTweetMedia, type RawMedia } from '@/packages/resolver'
// Imported from the dependency-free leaf module, not the `@/packages/schema`
// barrel: that barrel imports `TweetRecord` FROM this file, so importing it back
// here (even type-only) creates a cycle that breaks Effect Schema's module-init
// order (`schema/index.ts`'s `Schema.Array(TweetRecord)` reads `TweetRecord`
// before this module finishes evaluating).
import type { JsonObject, JsonValue } from '@/packages/schema/json'
import { cardMeta, expandText, linksFromEntities, type Link, type UrlEntity } from './lib/card'

/** The tee path a record came from; ranks a rich TweetDetail over a thin timeline. */
export type Source = 'tweetDetail' | 'timeline' | 'other'

/** TweetDetail outranks every timeline/other sighting (spec §6.4 merge rule). */
export function sourceRank(source: Source): number {
  return source === 'tweetDetail' ? 2 : 1
}

const AuthorSchema = Schema.Struct({
  handle: Schema.String,
  name: Schema.optional(Schema.String),
  userId: Schema.optional(Schema.String),
})

const LinkSchema = Schema.Struct({
  expandedUrl: Schema.String,
  displayUrl: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  domain: Schema.optional(Schema.String),
})

/** Media identity carried from the shared traversal's resolution (ADR-0016), with
 *  only the description fields — no download-lifecycle concerns. */
export const MediaRef = Schema.Struct({
  id: Schema.String,
  type: Schema.Literals(['photo', 'video', 'gif']),
  url: Schema.String,
  ext: Schema.String,
  index: Schema.Number,
  width: Schema.optional(Schema.Number),
  height: Schema.optional(Schema.Number),
})
export type MediaRef = typeof MediaRef.Type

/** A normalized, self-consistent snapshot of one captured tweet (spec §6.1). */
export const TweetRecord = Schema.Struct({
  tweetId: Schema.String,
  conversationId: Schema.String,
  inReplyToTweetId: Schema.optional(Schema.String),
  inReplyToHandle: Schema.optional(Schema.String),
  author: AuthorSchema,
  text: Schema.String,
  rawText: Schema.String,
  createdAt: Schema.optional(Schema.Number),
  lang: Schema.optional(Schema.String),
  links: Schema.Array(LinkSchema),
  media: Schema.Array(MediaRef),
  mentions: Schema.Array(Schema.String),
  hashtags: Schema.Array(Schema.String),
  quotedTweetId: Schema.optional(Schema.String),
  retweetOf: Schema.optional(Schema.String),
  source: Schema.Literals(['tweetDetail', 'timeline', 'other']),
  sourceRank: Schema.Number,
  capturedAt: Schema.Number,
})
export type TweetRecord = typeof TweetRecord.Type

const isObj = (v: JsonValue | undefined): v is JsonObject => typeof v === 'object' && v !== null

const isString = (v: JsonValue | undefined): v is string => typeof v === 'string'

const str = (v: JsonValue | undefined): string | undefined => (isString(v) ? v : undefined)

const optionalEntry = <K extends string, V>(key: K, v: V | undefined): Record<K, V> | object =>
  v !== undefined ? { [key]: v } : {}

const nestedRestId = (node: JsonObject, key: string): string | undefined => {
  const wrap = node[key]
  const result = isObj(wrap) ? wrap['result'] : undefined
  return isObj(result) ? str(result['rest_id']) : undefined
}

const arr = (v: JsonValue | undefined): ReadonlyArray<JsonValue> => (Array.isArray(v) ? v : [])

const urlEntities = (legacy: JsonObject): UrlEntity[] => {
  const entities = legacy['entities']
  const urls = isObj(entities) ? entities['urls'] : undefined
  // SAFETY: every UrlEntity field but `url`/`expanded_url` is optional, so this
  // only asserts the array holds JSON object nodes — `.filter(isObj)` on the
  // line above already proved that. Callers (`linksFromEntities`, `expandText`)
  // read each field defensively, so an entity missing `url`/`expanded_url`
  // degrades to `undefined` reads rather than a bad access.
  return arr(urls).filter(isObj) as UrlEntity[]
}

const mentions = (legacy: JsonObject): string[] => {
  const entities = legacy['entities']
  const ms = isObj(entities) ? entities['user_mentions'] : undefined
  return arr(ms)
    .map((m) => (isObj(m) ? str(m['screen_name']) : undefined))
    .filter((s): s is string => s !== undefined)
}

const hashtags = (legacy: JsonObject): string[] => {
  const entities = legacy['entities']
  const hs = isObj(entities) ? entities['hashtags'] : undefined
  return arr(hs)
    .map((h) => (isObj(h) ? str(h['text']) : undefined))
    .filter((s): s is string => s !== undefined)
}

/** Join each card's `{ title, description, domain }` onto the link whose source
 *  `t.co` matches the card url (`card.legacy.url`). */
const joinedLinks = (legacy: JsonObject, card: JsonValue | undefined): Link[] => {
  const entities = urlEntities(legacy)
  const links = linksFromEntities(entities)
  const cardLegacy = isObj(card) && isObj(card['legacy']) ? card['legacy'] : undefined
  const cardUrl = cardLegacy ? str(cardLegacy['url']) : undefined
  const target = entities.findIndex((e) => e.url === cardUrl)
  if (cardUrl === undefined || target < 0) return links
  const meta = cardMeta(card)
  return links.map((link, i) => (i === target ? Object.assign({}, link, meta) : link))
}

const createdAtMs = (legacy: JsonObject): number | undefined => {
  const raw = str(legacy['created_at'])
  if (raw === undefined) return undefined
  const ms = Date.parse(raw)
  return Number.isNaN(ms) ? undefined : ms
}

/** Runtime guard against a malformed media entry: `x/walk.ts`'s `mediaOf` only
 *  proves the `media` field is an array, not that every element is really an
 *  object — a bad entry here degrades to "skipped" rather than a crash below. */
const isMediaObject = (v: RawMedia): v is RawMedia => typeof v === 'object' && v !== null

const mediaRefs = (
  tweetId: string,
  handle: string,
  mediaRaw: ReadonlyArray<RawMedia>,
): MediaRef[] =>
  resolveTweetMedia({
    tweetId,
    handle,
    media: mediaRaw.filter(isMediaObject),
  }).map((m) =>
    Object.assign(
      { id: m.id, type: m.type, url: m.url, ext: m.ext, index: m.index },
      optionalEntry('width', m.width),
      optionalEntry('height', m.height),
    ),
  )

/**
 * Normalize one visited tweet node into an immutable {@link TweetRecord}. The
 * `author` is resolved by the caller via {@link findAuthor} (the outer tweet's
 * author, never a quoted/retweeted tweet's), and media rides in pre-resolved as
 * `mediaRaw` (no re-walk, ADR-0016 identity preserved). Returns `null` when the
 * node carries no tweet `legacy`.
 */
export function tweetRecordFromNode(args: {
  node: object
  author: Author
  mediaRaw: ReadonlyArray<RawMedia>
  source: Source
  capturedAt: number
}): TweetRecord | null {
  const { node, author, mediaRaw, source, capturedAt } = args
  // SAFETY: every read on `tweet` below is defensive (`isObj`/`str`/optional
  // chaining), so a node whose fields don't match JsonObject's shape degrades to
  // `undefined` reads rather than a bad access — the same loose contract `object`
  // already promised the caller.
  const tweet = node as JsonObject
  const legacy = tweet['legacy']
  if (!isObj(legacy)) return null

  const tweetId = str(tweet['rest_id']) ?? str(legacy['id_str']) ?? ''
  const rawText = str(legacy['full_text']) ?? ''

  return {
    tweetId,
    conversationId: str(legacy['conversation_id_str']) ?? tweetId,
    ...optionalEntry('inReplyToTweetId', str(legacy['in_reply_to_status_id_str'])),
    ...optionalEntry('inReplyToHandle', str(legacy['in_reply_to_screen_name'])),
    author: findAuthor(tweet),
    text: expandText(rawText, urlEntities(legacy)),
    rawText,
    ...optionalEntry('createdAt', createdAtMs(legacy)),
    ...optionalEntry('lang', str(legacy['lang'])),
    links: joinedLinks(legacy, tweet['card']),
    media: mediaRefs(tweetId, author.handle, mediaRaw),
    mentions: mentions(legacy),
    hashtags: hashtags(legacy),
    ...optionalEntry('quotedTweetId', nestedRestId(tweet, 'quoted_status_result')),
    ...optionalEntry('retweetOf', nestedRestId(tweet, 'retweeted_status_result')),
    source,
    sourceRank: sourceRank(source),
    capturedAt,
  }
}
