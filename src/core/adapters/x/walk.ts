import type { RawMedia } from '@/packages/resolver'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null

/** The author of a tweet node, resolved from its `core.user_results.result`. */
export type Author = { handle: string; name?: string; userId?: string }

/** Keys whose subtree describes a DIFFERENT tweet (a quote or a retweet), never
 *  the author of the node being attributed. Skipped when locating the author and
 *  visited as their own tweet nodes by {@link forEachTweetNode}. */
export const NESTED_TWEET_KEYS: ReadonlySet<string> = new Set([
  'quoted_status_result',
  'retweeted_status_result',
])

/** A `core.user_results.result` carries an author when its `legacy.screen_name`
 *  is a string; X serializes a quoted/retweeted tweet's own author there too, so
 *  {@link NESTED_TWEET_KEYS} subtrees are pruned before this stop fires. */
const isUserResult = (n: Obj): boolean => {
  const legacy = n['legacy']
  return isObj(legacy) && typeof legacy['screen_name'] === 'string'
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
export function findAuthor(node: unknown): Author {
  let found: Author | undefined
  const scan = (n: unknown): void => {
    if (found !== undefined) return
    if (Array.isArray(n)) {
      for (const v of n) scan(v)
      return
    }
    if (!isObj(n)) return
    if (isUserResult(n)) {
      const legacy = n['legacy'] as Obj
      const name = legacy['name']
      const userId = n['rest_id']
      found = {
        handle: legacy['screen_name'] as string,
        ...(typeof name === 'string' ? { name } : {}),
        ...(typeof userId === 'string' ? { userId } : {}),
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
const tweetLegacy = (n: Obj): Obj | null => {
  const legacy = n['legacy']
  return isObj(legacy) && typeof legacy['screen_name'] !== 'string' ? legacy : null
}

const tweetIdOf = (n: Obj, legacy: Obj): string => String(n['rest_id'] ?? legacy['id_str'] ?? '')

const mediaOf = (legacy: Obj): RawMedia[] => {
  const ee = legacy['extended_entities']
  const media = isObj(ee) ? ee['media'] : undefined
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
  json: unknown,
  visit: (n: {
    node: Obj
    tweetId: string
    handle: string
    author: Author
    mediaRaw: RawMedia[]
  }) => void,
): void {
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const v of node) walk(v)
      return
    }
    if (!isObj(node)) return
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
export function timelineTweetIds(json: unknown): ReadonlySet<string> {
  const ids = new Set<string>()
  forEachTweetNode(json, ({ tweetId }) => ids.add(tweetId))
  return ids
}
