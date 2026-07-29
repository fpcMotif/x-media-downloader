import { findAuthor } from '../adapters/x/walk'
import { normalizeRawMediaList } from '../adapters/x/raw-media'
import { resolveTweetMedia } from '../resolver'
import { cardMeta, expandText, linksFromEntities, type UrlEntity } from './card'
import type { Author, Link, MediaRef, TweetRecord } from './record-schema'

export { Author, Link, MediaRef, TweetRecord } from './record-schema'

/** The tee path a record came from; ranks a rich TweetDetail over a thin timeline. */
export type Source = 'tweetDetail' | 'timeline' | 'other'

/** TweetDetail outranks every timeline/other sighting (spec §6.4 merge rule). */
export function sourceRank(source: Source): 1 | 2 {
  return source === 'tweetDetail' ? 2 : 1
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

const optionalEntry = <K extends string, V>(key: K, v: V | undefined): Record<K, V> | object =>
  v !== undefined ? ({ [key]: v } as Record<K, V>) : {}

const nestedRestId = (node: Obj, key: string): string | undefined => {
  const wrap = node[key]
  const result = isObj(wrap) ? wrap['result'] : undefined
  return isObj(result) ? str(result['rest_id']) : undefined
}

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** Keep the first external entity for a stable, schema-valid record. */
const firstBy = <T>(values: ReadonlyArray<T>, key: (value: T) => string | number): T[] => {
  const seen = new Set<string | number>()
  return values.filter((value) => {
    const identity = key(value)
    if (seen.has(identity)) return false
    seen.add(identity)
    return true
  })
}

const firstFolded = (values: ReadonlyArray<string>): string[] =>
  firstBy(values, (value) => value.toLowerCase())

const urlEntities = (legacy: Obj): UrlEntity[] => {
  const entities = legacy['entities']
  const urls = isObj(entities) ? entities['urls'] : undefined
  return arr(urls).filter(isObj) as UrlEntity[]
}

const mentions = (legacy: Obj): string[] => {
  const entities = legacy['entities']
  const ms = isObj(entities) ? entities['user_mentions'] : undefined
  return firstFolded(
    arr(ms)
      .map((m) => (isObj(m) ? str(m['screen_name']) : undefined))
      .filter((s): s is string => s !== undefined),
  )
}

const hashtags = (legacy: Obj): string[] => {
  const entities = legacy['entities']
  const hs = isObj(entities) ? entities['hashtags'] : undefined
  return firstFolded(
    arr(hs)
      .map((h) => (isObj(h) ? str(h['text']) : undefined))
      .filter((s): s is string => s !== undefined),
  )
}

/** Join each card's `{ title, description, domain }` onto the link whose source
 *  `t.co` matches the card url (`card.legacy.url`). */
const joinedLinks = (legacy: Obj, card: unknown): Link[] => {
  const entities = urlEntities(legacy)
  const links = linksFromEntities(entities)
  const cardLegacy = isObj(card) && isObj(card['legacy']) ? (card['legacy'] as Obj) : undefined
  const cardUrl = cardLegacy ? str(cardLegacy['url']) : undefined
  const target = entities.findIndex((e) => e.url === cardUrl)
  if (cardUrl === undefined || target < 0) return firstBy(links, (link) => link.expandedUrl)
  const meta = cardMeta(card)
  const targetUrl = links[target]?.expandedUrl
  return firstBy(
    links.map((link) => (link.expandedUrl === targetUrl ? Object.assign({}, link, meta) : link)),
    (link) => link.expandedUrl,
  )
}

const createdAtMs = (legacy: Obj): number | undefined => {
  const raw = str(legacy['created_at'])
  if (raw === undefined) return undefined
  const ms = Date.parse(raw)
  return Number.isNaN(ms) ? undefined : ms
}

const mediaRefs = (tweetId: string, handle: string, mediaRaw: unknown[]): MediaRef[] => {
  const refs = resolveTweetMedia({
    tweetId,
    handle,
    media: normalizeRawMediaList(mediaRaw),
  }).map((m) =>
    Object.assign(
      { id: m.id, type: m.type, url: m.url, ext: m.ext, index: m.index },
      optionalEntry('width', m.width),
      optionalEntry('height', m.height),
    ),
  )
  const ids = new Set<string>()
  const indexes = new Set<number>()
  return refs.filter((media) => {
    if (ids.has(media.id) || indexes.has(media.index)) return false
    ids.add(media.id)
    indexes.add(media.index)
    return true
  })
}

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
