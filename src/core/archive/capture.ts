import { resolveTweetMedia, type RawMedia } from '../resolver'
import type { MediaItem } from '../schema'
import { extractLinks, type ArchivedLink } from './links'

/**
 * Tweet-candidate extraction from captured Bookmarks/Likes GraphQL responses
 * (ADR-0010). Pure: parses the tee's JSON only. Keeps strictly the tweets the
 * payload marks as the viewer's own (bookmarked/favorited), so quoted
 * strangers' tweets and retweet wrappers never enter the archive job.
 */

export type ArchiveSource = 'bookmarks' | 'likes'

export interface TweetCandidate {
  readonly tweetId: string
  readonly handle: string
  readonly source: ArchiveSource
  readonly text: string
  readonly createdAt?: string
  readonly links: ReadonlyArray<ArchivedLink>
  readonly items: ReadonlyArray<MediaItem>
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null

/** Depth-first visit of every object node in an arbitrary JSON tree. */
function walk(node: unknown, visit: (obj: Obj) => void): void {
  if (Array.isArray(node)) {
    for (const v of node) walk(v, visit)
    return
  }
  if (isObj(node)) {
    visit(node)
    for (const v of Object.values(node)) walk(v, visit)
  }
}

/** First `screen_name` found anywhere under a node (the tweet author). */
function findScreenName(node: unknown): string | undefined {
  let found: string | undefined
  walk(node, (obj) => {
    if (found === undefined && typeof obj['screen_name'] === 'string') {
      found = obj['screen_name']
    }
  })
  return found
}

/**
 * Map a tee'd pathname to its archive source by FINAL path segment only:
 * `…/graphql/{qid}/Bookmarks` ⇒ `'bookmarks'`, `…/Likes` ⇒ `'likes'`. Anything
 * else (including `/BookmarksFoo`) ⇒ `null`.
 */
export function sourceFromPath(path: string): ArchiveSource | null {
  const clean = (path.split('?')[0] ?? path).replace(/\/+$/, '')
  const op = clean.slice(clean.lastIndexOf('/') + 1)
  if (op === 'Bookmarks') return 'bookmarks'
  if (op === 'Likes') return 'likes'
  return null
}

/** The viewer flag a node must carry to belong to this source. */
const VIEWER_FLAG: Record<ArchiveSource, string> = {
  bookmarks: 'bookmarked',
  likes: 'favorited',
}

/**
 * Extract tweet candidates from a captured response. A node qualifies iff its
 * `legacy` carries the source's viewer flag set to `true` and a tweet id;
 * retweet wrappers (`legacy.retweeted_status_result`) are skipped so the inner
 * original is archived on its own. Deduped by tweetId (first wins). Media may
 * be empty — text-only tweets are still archived.
 */
export function detectCandidates(json: unknown, source: ArchiveSource): TweetCandidate[] {
  const flag = VIEWER_FLAG[source]
  const out: TweetCandidate[] = []
  const seen = new Set<string>()
  walk(json, (obj) => {
    const legacy = obj['legacy']
    if (!isObj(legacy)) return
    if (legacy[flag] !== true) return
    if (legacy['retweeted_status_result'] !== undefined) return
    const idStr = typeof legacy['id_str'] === 'string' ? legacy['id_str'] : undefined
    const tweetId = String(obj['rest_id'] ?? idStr ?? '')
    if (tweetId === '' || seen.has(tweetId)) return
    seen.add(tweetId)

    const handle = findScreenName(obj) ?? ''
    const text = typeof legacy['full_text'] === 'string' ? legacy['full_text'] : ''
    const createdAt = typeof legacy['created_at'] === 'string' ? legacy['created_at'] : undefined
    const links = extractLinks(legacy['entities'])

    const ee = legacy['extended_entities']
    const media = isObj(ee) ? ee['media'] : undefined
    const items = Array.isArray(media)
      ? resolveTweetMedia({ tweetId, handle, media: media as ReadonlyArray<RawMedia> })
      : []

    out.push({
      tweetId,
      handle,
      source,
      text,
      links,
      items,
      ...(createdAt !== undefined ? { createdAt } : {}),
    })
  })
  return out
}
