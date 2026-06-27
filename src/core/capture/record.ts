import { Schema } from 'effect'
import { findAuthor, type Author } from '../adapters/x/walk'
import { resolveTweetMedia, type RawMedia } from '../resolver'
import { cardMeta, expandText, linksFromEntities, type Link, type UrlEntity } from './card'

/** The tee path a record came from; ranks a rich TweetDetail over a thin timeline. */
export type Source = 'tweetDetail' | 'timeline' | 'other'

/** TweetDetail outranks every timeline/other sighting (spec §6.4 merge rule). */
export function sourceRank(source: Source): number {
  return source === 'tweetDetail' ? 2 : 1
}

const MetricsSchema = Schema.Struct({
  replies: Schema.optional(Schema.Number),
  retweets: Schema.optional(Schema.Number),
  likes: Schema.optional(Schema.Number),
  quotes: Schema.optional(Schema.Number),
  bookmarks: Schema.optional(Schema.Number),
  views: Schema.optional(Schema.Number),
})

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
  metrics: MetricsSchema,
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

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)

/** `views.count` is a numeric string sibling of `legacy` at the result node. */
const viewsCount = (node: Obj): number | undefined => {
  const views = node['views']
  const raw = isObj(views) ? str(views['count']) : undefined
  if (raw === undefined) return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

const optionalEntry = <K extends string, V>(key: K, v: V | undefined): Record<K, V> | object =>
  v !== undefined ? ({ [key]: v } as Record<K, V>) : {}

const nestedRestId = (node: Obj, key: string): string | undefined => {
  const wrap = node[key]
  const result = isObj(wrap) ? wrap['result'] : undefined
  return isObj(result) ? str(result['rest_id']) : undefined
}

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

const urlEntities = (legacy: Obj): UrlEntity[] => {
  const entities = legacy['entities']
  const urls = isObj(entities) ? entities['urls'] : undefined
  return arr(urls).filter(isObj) as UrlEntity[]
}

const mentions = (legacy: Obj): string[] => {
  const entities = legacy['entities']
  const ms = isObj(entities) ? entities['user_mentions'] : undefined
  return arr(ms)
    .map((m) => (isObj(m) ? str(m['screen_name']) : undefined))
    .filter((s): s is string => s !== undefined)
}

const hashtags = (legacy: Obj): string[] => {
  const entities = legacy['entities']
  const hs = isObj(entities) ? entities['hashtags'] : undefined
  return arr(hs)
    .map((h) => (isObj(h) ? str(h['text']) : undefined))
    .filter((s): s is string => s !== undefined)
}

/** Join each card's `{ title, description, domain }` onto the link whose source
 *  `t.co` matches the card url (`card.legacy.url`). */
const joinedLinks = (legacy: Obj, card: unknown): Link[] => {
  const entities = urlEntities(legacy)
  const links = linksFromEntities(entities)
  const cardLegacy = isObj(card) && isObj(card['legacy']) ? (card['legacy'] as Obj) : undefined
  const cardUrl = cardLegacy ? str(cardLegacy['url']) : undefined
  const target = entities.findIndex((e) => e.url === cardUrl)
  if (cardUrl === undefined || target < 0) return links
  const meta = cardMeta(card)
  return links.map((link, i) => (i === target ? Object.assign({}, link, meta) : link))
}

const createdAtMs = (legacy: Obj): number | undefined => {
  const raw = str(legacy['created_at'])
  if (raw === undefined) return undefined
  const ms = Date.parse(raw)
  return Number.isNaN(ms) ? undefined : ms
}

const mediaRefs = (tweetId: string, handle: string, mediaRaw: unknown[]): MediaRef[] =>
  resolveTweetMedia({
    tweetId,
    handle,
    media: mediaRaw.filter(isObj) as unknown as RawMedia[],
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
  mediaRaw: unknown[]
  source: Source
  capturedAt: number
}): TweetRecord | null {
  const { node, author, mediaRaw, source, capturedAt } = args
  const tweet = node as Obj
  const legacy = tweet['legacy']
  if (!isObj(legacy)) return null

  const tweetId = str(tweet['rest_id']) ?? str(legacy['id_str']) ?? ''
  const rawText = str(legacy['full_text']) ?? ''

  const metrics = {
    ...optionalEntry('replies', num(legacy['reply_count'])),
    ...optionalEntry('retweets', num(legacy['retweet_count'])),
    ...optionalEntry('likes', num(legacy['favorite_count'])),
    ...optionalEntry('quotes', num(legacy['quote_count'])),
    ...optionalEntry('bookmarks', num(legacy['bookmark_count'])),
    ...optionalEntry('views', viewsCount(tweet)),
  }

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
    metrics,
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
