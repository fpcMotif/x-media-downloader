import type { RawMedia } from '../../resolver'
import { normalizeRawMediaList } from './raw-media'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null

/** Gas limits for one hostile Raw Capture traversal. Exhaustion drops the whole capture. */
export const MAX_TRAVERSAL_NODES = 10_000
export const MAX_TRAVERSAL_DEPTH = 128
export const MAX_TRAVERSAL_OUTPUTS = 1_000

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
const findAuthorWithinGas = (node: unknown): Author | undefined => {
  let found: Author | undefined
  const stack: Array<{ readonly node: unknown; readonly depth: number }> = [{ node, depth: 0 }]
  const visited = new WeakSet<Obj>()
  let nodes = 0
  try {
    while (stack.length > 0 && found === undefined) {
      const current = stack.pop()!
      if (current.depth > MAX_TRAVERSAL_DEPTH || ++nodes > MAX_TRAVERSAL_NODES) return undefined
      if (Array.isArray(current.node)) {
        if (current.node.length > MAX_TRAVERSAL_NODES) return undefined
        for (let index = current.node.length - 1; index >= 0; index -= 1)
          stack.push({ node: current.node[index], depth: current.depth + 1 })
        continue
      }
      if (!isObj(current.node) || visited.has(current.node)) continue
      visited.add(current.node)
      if (isUserResult(current.node)) {
        const legacy = current.node['legacy'] as Obj
        const name = legacy['name']
        const userId = current.node['rest_id']
        found = {
          handle: legacy['screen_name'] as string,
          ...(typeof name === 'string' ? { name } : {}),
          ...(typeof userId === 'string' ? { userId } : {}),
        }
        continue
      }
      const entries = Object.entries(current.node)
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [key, value] = entries[index]!
        if (!NESTED_TWEET_KEYS.has(key)) stack.push({ node: value, depth: current.depth + 1 })
      }
    }
  } catch {
    return undefined
  }
  return found ?? { handle: '' }
}

/** Reads an author for standalone callers; exhausted hostile input has no author. */
export function findAuthor(node: unknown): Author {
  return findAuthorWithinGas(node) ?? { handle: '' }
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
  return normalizeRawMediaList(media)
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
): boolean {
  const stack: Array<{ readonly node: unknown; readonly depth: number }> = [
    { node: json, depth: 0 },
  ]
  const visited = new WeakSet<Obj>()
  const results: Array<{
    readonly node: Obj
    readonly tweetId: string
    readonly handle: string
    readonly author: Author
    readonly mediaRaw: RawMedia[]
  }> = []
  let nodes = 0
  try {
    while (stack.length > 0) {
      const current = stack.pop()!
      if (current.depth > MAX_TRAVERSAL_DEPTH || ++nodes > MAX_TRAVERSAL_NODES) return false
      if (Array.isArray(current.node)) {
        if (current.node.length > MAX_TRAVERSAL_NODES) return false
        for (let index = current.node.length - 1; index >= 0; index -= 1)
          stack.push({ node: current.node[index], depth: current.depth + 1 })
        continue
      }
      if (!isObj(current.node) || visited.has(current.node)) continue
      visited.add(current.node)
      if (current.node['__typename'] === 'TweetTombstone') continue
      if (current.node['__typename'] === 'TweetWithVisibilityResults') {
        stack.push({ node: current.node['tweet'], depth: current.depth + 1 })
        continue
      }
      const legacy = tweetLegacy(current.node)
      if (legacy) {
        if (results.length >= MAX_TRAVERSAL_OUTPUTS) return false
        const author = findAuthorWithinGas(current.node)
        if (author === undefined) return false
        results.push({
          node: current.node,
          tweetId: tweetIdOf(current.node, legacy),
          handle: author.handle,
          author,
          mediaRaw: mediaOf(legacy),
        })
      }
      const values = Object.values(current.node)
      for (let index = values.length - 1; index >= 0; index -= 1)
        stack.push({ node: values[index], depth: current.depth + 1 })
    }
  } catch {
    return false
  }
  for (const result of results) visit(result)
  return true
}
