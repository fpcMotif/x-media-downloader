import { resolveTweetMedia, upgradePhotoUrl, type RawMedia } from '../../resolver'
import type { MediaItem } from '../../schema'

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
 * Extract MediaItems from a captured X GraphQL response by finding every tweet
 * node carrying `legacy.extended_entities.media`, regardless of endpoint shape.
 */
export function detectFromJson(json: unknown): MediaItem[] {
  const out: MediaItem[] = []
  const seen = new Set<string>()
  walk(json, (obj) => {
    const legacy = obj['legacy']
    const ee = isObj(legacy) ? legacy['extended_entities'] : undefined
    const media = isObj(ee) ? ee['media'] : undefined
    if (!Array.isArray(media)) return
    const idStr = isObj(legacy) ? legacy['id_str'] : undefined
    const tweetId = String(obj['rest_id'] ?? idStr ?? '')
    if (tweetId === '' || seen.has(tweetId)) return
    seen.add(tweetId)
    const handle = findScreenName(obj) ?? ''
    out.push(...resolveTweetMedia({ tweetId, handle, media: media as ReadonlyArray<RawMedia> }))
  })
  return out
}

/** DOM fallback: photos already rendered as pbs.twimg.com/media images. */
export function detectFromDom(
  root: ParentNode,
  ctx: { readonly tweetId: string; readonly handle: string },
): MediaItem[] {
  const imgs = Array.from(root.querySelectorAll('img[src*="pbs.twimg.com/media"]'))
  return imgs.map((img, index) => ({
    id: `${ctx.tweetId}-${index}`,
    tweetId: ctx.tweetId,
    handle: ctx.handle,
    type: 'photo' as const,
    url: upgradePhotoUrl(img.getAttribute('src') ?? ''),
    ext: 'jpg',
    index,
  }))
}
