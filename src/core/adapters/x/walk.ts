import type { RawMedia } from '@/packages/resolver'
import type { JsonObject, JsonValue } from '@/packages/schema/json'
import { isJsonNumber, isJsonObject, isJsonString } from '../json-predicates'

/** Tweet ids arrive as strings (`id_str`) or numbers. Anything else is a malformed
 *  node, and must read as absent rather than stringify to `[object Object]`. */
const idString = (v: JsonValue | undefined): string =>
  isJsonString(v) ? v : isJsonNumber(v) ? String(v) : ''

/** The author of a tweet node, resolved from its `core.user_results.result`. */
export type Author = { handle: string; name?: string; userId?: string }

/** Keys whose subtree describes a DIFFERENT tweet (a quote or a retweet), never
 *  the author of the node being attributed. Skipped when locating the author and
 *  visited as their own tweet nodes by {@link forEachTweetNode}. */
export const NESTED_TWEET_KEYS: ReadonlySet<string> = new Set([
  'quoted_status_result',
  'retweeted_status_result',
])

/** `n`'s `handle`/`legacy` when `n` is a `core.user_results.result` node — i.e.
 *  its `legacy.screen_name` is a string; X serializes a quoted/retweeted tweet's
 *  own author there too, so {@link NESTED_TWEET_KEYS} subtrees are pruned before
 *  this stop fires. Carries `legacy` back out already narrowed, so the caller
 *  never has to re-check `screen_name`'s type to read `name`/`rest_id` from the
 *  same subtree. */
const userResultAuthor = (n: JsonObject): { handle: string; legacy: JsonObject } | undefined => {
  const legacy = n['legacy']
  if (!isJsonObject(legacy)) return undefined
  const screenName = legacy['screen_name']
  return isJsonString(screenName) ? { handle: screenName, legacy } : undefined
}

/**
 * THIS tweet's author. A plain depth-first scan returns the first author anywhere
 * under the node, but a quoted/retweeted tweet nests its OWN author there — and X
 * serializes `quoted_status_result` as a sibling of `core`, often first in key
 * order — so an unpruned walk mis-attributes the outer tweet. Prune those subtrees
 * (each is visited separately and keeps its own author), then read `screen_name`,
 * `name`, and `rest_id` from the SAME `core.user_results.result` subtree so a
 * quoted tweet's name/userId can never leak into the outer record.
 */
export function findAuthor(node: JsonValue): Author {
  let found: Author | undefined
  const scan = (n: JsonValue): void => {
    if (found !== undefined) return
    if (Array.isArray(n)) {
      for (const v of n) scan(v)
      return
    }
    if (!isJsonObject(n)) return
    const userResult = userResultAuthor(n)
    if (userResult) {
      const { handle, legacy } = userResult
      const name = legacy['name']
      const userId = n['rest_id']
      found = {
        handle,
        ...(isJsonString(name) ? { name } : {}),
        ...(isJsonString(userId) ? { userId } : {}),
      }
      return
    }
    for (const [key, v] of Object.entries(n)) {
      if (NESTED_TWEET_KEYS.has(key)) continue
      scan(v)
      if (found !== undefined) return
    }
  }
  scan(node)
  return found ?? { handle: '' }
}

/** A tweet result node's own `legacy` object, or `null` when `n` is not a tweet
 *  node. A tweet's `legacy` is NOT a user's (no `screen_name`) — the discriminator
 *  between a Tweet result and the nested `user_results.result` (a User) that also
 *  has `rest_id` + `legacy`. */
const tweetLegacy = (n: JsonObject): JsonObject | null => {
  const legacy = n['legacy']
  return isJsonObject(legacy) && !isJsonString(legacy['screen_name']) ? legacy : null
}

const tweetIdOf = (n: JsonObject, legacy: JsonObject): string =>
  idString(n['rest_id']) || idString(legacy['id_str'])

const mediaOf = (legacy: JsonObject): RawMedia[] => {
  const ee = legacy['extended_entities']
  const media = isJsonObject(ee) ? ee['media'] : undefined
  // SAFETY: `media` is only ever X's own `extended_entities.media` array — each
  // entry is a `type`/`media_url_https`(+ optional `video_info`) object per X's
  // GraphQL schema. This walker reads it defensively (never assumes a caller
  // already validated it), same posture as the module doc's "walk, don't
  // schema-decode" stance for undocumented third-party payloads.
  return Array.isArray(media) ? (media as RawMedia[]) : []
}

/**
 * One depth-first walk of a captured X GraphQL response yielding exactly one
 * `visit` per tweet node. Unwraps `TweetWithVisibilityResults` to its `.tweet`,
 * skips `TweetTombstone`, derives `tweetId` (`rest_id` → `legacy.id_str`), resolves
 * the author via {@link findAuthor}, and collects `legacy.extended_entities.media`.
 * Quoted/retweeted tweets are visited independently as their own tweet nodes.
 */
export function forEachTweetNode(
  json: JsonValue,
  visit: (n: {
    node: JsonObject
    tweetId: string
    handle: string
    author: Author
    mediaRaw: RawMedia[]
  }) => void,
): void {
  const walk = (node: JsonValue | undefined): void => {
    if (Array.isArray(node)) {
      for (const v of node) walk(v)
      return
    }
    if (!isJsonObject(node)) return
    if (node['__typename'] === 'TweetTombstone') return
    if (node['__typename'] === 'TweetWithVisibilityResults') {
      walk(node['tweet'])
      return
    }
    const legacy = tweetLegacy(node)
    if (legacy) {
      const author = findAuthor(node)
      visit({
        node,
        tweetId: tweetIdOf(node, legacy),
        handle: author.handle,
        author,
        mediaRaw: mediaOf(legacy),
      })
    }
    for (const v of Object.values(node)) walk(v)
  }
  walk(json)
}

/**
 * Every tweet id present in a captured X GraphQL response — a thin door onto
 * {@link forEachTweetNode} that ignores media entirely (unlike `harvestTweets`,
 * which the Capture feature gates on `mediaRaw`/`includeTextOnly`). Built for the
 * Release re-appearance watchdog's ghost-vs-real discriminator (spec #59 ticket
 * #64): ANY tweet present in the freshest captured `Bookmarks`/`Likes` timeline
 * response is a genuine server-side member of that list, whether or not it
 * carries downloadable media — a text-only bookmarked post must still count.
 */
export function timelineTweetIds(json: JsonValue): ReadonlySet<string> {
  const ids = new Set<string>()
  forEachTweetNode(json, ({ tweetId }) => ids.add(tweetId))
  return ids
}
