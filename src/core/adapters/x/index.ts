import { resolveTweetMedia, upgradePhotoUrl, type RawMedia } from '../../resolver'
import type { MediaItem } from '../../schema'
import { mediaKeyFromUrl, isGrabbablePhotoUrl, extFromImgUrl } from './dom'

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
    if (!isObj(legacy)) return
    const ee = legacy['extended_entities']
    if (!isObj(ee)) return
    const media = ee['media']
    if (!Array.isArray(media)) return
    const tweetId = String(obj['rest_id'] ?? legacy['id_str'] ?? '')
    if (tweetId === '' || seen.has(tweetId)) return
    seen.add(tweetId)
    const handle = findScreenName(obj) ?? ''
    out.push(...resolveTweetMedia({ tweetId, handle, media: media as ReadonlyArray<RawMedia> }))
  })
  return out
}

/** X's internal permalinks `/i/web/status/{id}` and `/i/status/{id}` — no author. */
const I_STATUS_RE = /\/i\/(?:web\/)?status\/(\d+)(?:\/photo\/(\d+))?/
/** A real author permalink `/{handle}/status/{id}` (+ optional `/photo/{n}`). The
 *  handle charset (X's `\w{1,15}`) stops `/i/web/status/` capturing `web` as one. */
const STATUS_RE = /\/([A-Za-z0-9_]{1,15})\/status\/(\d+)(?:\/photo\/(\d+))?/

interface TweetContext {
  readonly handle: string
  readonly tweetId: string
  /** 1-based `/photo/{n}` mapped to a 0-based index, when the path carries one. */
  readonly index?: number
}

function contextFromPath(path: string): TweetContext | null {
  const i = I_STATUS_RE.exec(path)
  if (i) {
    const base: TweetContext = { handle: '', tweetId: i[1]! }
    return i[2] ? { ...base, index: Math.max(0, Number(i[2]) - 1) } : base
  }
  const m = STATUS_RE.exec(path)
  if (!m) return null
  const base: TweetContext = { handle: m[1]!, tweetId: m[2]! }
  return m[3] ? { ...base, index: Math.max(0, Number(m[3]) - 1) } : base
}

const linkContext = (a: Element | null): TweetContext | null =>
  a ? contextFromPath(String(a.getAttribute('href'))) : null

/** First status link with a real author, else the first author-less (`/i/`) link. */
function contextFromArticle(article: Element): TweetContext | null {
  let fallback: TweetContext | null = null
  for (const a of article.querySelectorAll('a[href*="/status/"]')) {
    const ctx = contextFromPath(String(a.getAttribute('href')))
    if (ctx?.handle) return ctx
    fallback ??= ctx
  }
  return fallback
}

/**
 * Resolve one hovered `<img>` into a single Original-quality photo Media Item —
 * the Quick Grab unit — or `null` if it isn't a grabbable X photo.
 *
 * Quality reuses {@link upgradePhotoUrl} (forces `name=orig`). Tweet context for
 * the filename comes from the enclosing `article[data-testid="tweet"]` (author
 * handle + tweetId via its status permalink); failing that, from the page
 * `pathname` (covers the `/photo/` lightbox route); failing that, the media key
 * stands in as the tweetId so `renderFilename` still yields a valid relative path.
 * `index` is the photo's position among the tweet's grabbable images, or the
 * `/photo/{n}` ordinal when the path provides one.
 */
export function resolveImageElement(img: HTMLImageElement, pathname = ''): MediaItem | null {
  const src = img.currentSrc || img.src
  if (!isGrabbablePhotoUrl(src)) return null
  const key = mediaKeyFromUrl(src)
  if (!key) return null

  const article = img.closest('article[data-testid="tweet"]')
  // The photo's OWN `/status/.../photo/{n}` anchor is the most specific source and
  // carries the exact index. X's quote preview card is an anchor-less
  // `div[role="link"]`: a photo inside one belongs to the quoted tweet, whose id
  // appears nowhere in that subtree — fall through to the media-key identity
  // rather than mis-attribute it to the outer tweet (or the page permalink).
  const quoteCard = article ? img.closest('div[role="link"]') : null
  const quote = quoteCard && article!.contains(quoteCard) ? quoteCard : null
  const ctx =
    linkContext(img.closest('a[href*="/status/"]')) ??
    (quote ? null : ((article ? contextFromArticle(article) : null) ?? contextFromPath(pathname)))

  let index = ctx?.index ?? 0
  if (article && ctx?.index === undefined) {
    const photos = Array.from(article.querySelectorAll('img')).filter((el) => {
      if (!isGrabbablePhotoUrl(el.currentSrc || el.src)) return false
      const elCtx = linkContext(el.closest('a[href*="/status/"]'))
      return (elCtx?.tweetId ?? ctx?.tweetId) === ctx?.tweetId
    })
    const pos = photos.indexOf(img)
    index = Math.max(0, pos)
  }

  const tweetId = ctx?.tweetId ?? key
  // Ext follows the UPGRADED url: `upgradePhotoUrl` rewrites webp renditions to
  // jpg originals, and the saved file's extension must match what's fetched.
  const url = upgradePhotoUrl(src)
  return {
    id: ctx ? `${tweetId}-${index}` : key,
    tweetId,
    handle: ctx?.handle ?? '',
    type: 'photo',
    url,
    ext: extFromImgUrl(url),
    index,
  }
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
    url: upgradePhotoUrl(String(img.getAttribute('src'))),
    ext: 'jpg',
    index,
  }))
}
