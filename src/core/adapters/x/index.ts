import { TWEET_ARTICLE_SEL } from '../../clear/clearer'
import { resolveTweetMedia, upgradePhotoUrl, type RawMedia } from '../../resolver'
import type { MediaItem } from '../../schema'
import {
  mediaKeyFromUrl,
  isGrabbablePhotoUrl,
  isGrabbableMediaPreviewUrl,
  extFromImgUrl,
  videoPosterUrl,
  STATUS_LINK_SEL,
  VIDEO_PLAYER_SEL,
} from './dom'

/** Host-match patterns for X tabs — the single source of truth used by the
 *  manifest content-script globs and `browser.tabs.query`. */
export const X_HOST_MATCH = ['*://x.com/*', '*://twitter.com/*'] as const

/** Whether a URL is an x.com / twitter.com page. */
export const isXUrl = (url: string): boolean => /https?:\/\/(x|twitter)\.com\//.test(url)

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

/** Keys whose subtree describes a DIFFERENT tweet (a quote or a retweet), never
 *  the author of the node being attributed. Skipped when locating the author. */
const NESTED_TWEET_KEYS = new Set(['quoted_status_result', 'retweeted_status_result'])

/** The `screen_name` of THIS tweet's author. A plain depth-first scan returns the
 *  first `screen_name` anywhere under the node, but a quoted/retweeted tweet nests
 *  its OWN author there — and X serializes `quoted_status_result` as a sibling of
 *  `core`, often first in key order — so an unpruned walk mis-files the outer
 *  tweet's media under the quoted author. Prune those subtrees (each is visited
 *  separately by {@link detectFromJson} and keeps its own author). */
function findScreenName(node: unknown): string | undefined {
  let found: string | undefined
  const scan = (n: unknown): void => {
    if (found !== undefined) return
    if (Array.isArray(n)) {
      for (const v of n) scan(v)
      return
    }
    if (!isObj(n)) return
    if (typeof n['screen_name'] === 'string') {
      found = n['screen_name']
      return
    }
    for (const [key, v] of Object.entries(n)) {
      if (NESTED_TWEET_KEYS.has(key)) continue
      scan(v)
      if (found !== undefined) return
    }
  }
  scan(node)
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
    /* v8 ignore next -- media[] exists only when `legacy` is an object (checked at line 62), so the else arm is dead */
    const idStr = isObj(legacy) ? legacy['id_str'] : undefined
    const tweetId = String(obj['rest_id'] ?? idStr ?? '')
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
  /* v8 ignore start -- `a` always matches `a[href*="/status/"]`, so getAttribute('href') is never null */
  a ? contextFromPath(a.getAttribute('href') ?? '') : null
/* v8 ignore stop */

/** First status link with a real author, else the first author-less (`/i/`) link. */
function contextFromArticle(article: Element): TweetContext | null {
  let fallback: TweetContext | null = null
  for (const a of article.querySelectorAll(STATUS_LINK_SEL)) {
    /* v8 ignore next -- `a` matches `a[href*="/status/"]`, so getAttribute('href') is never null */
    const ctx = contextFromPath(a.getAttribute('href') ?? '')
    if (ctx?.handle) return ctx
    fallback ??= ctx
  }
  return fallback
}

/**
 * Three-tier tweet context for a hovered photo `<img>`: its OWN
 * `/status/.../photo/{n}` anchor (most specific, carries the exact index), else
 * the enclosing article's permalink, else the page `pathname`. Returns null for a
 * photo inside X's anchor-less quote preview card (`div[role="link"]` scoped to
 * the article): that media belongs to the quoted tweet, whose id appears nowhere
 * in the subtree, so the caller falls through to the media-key identity rather
 * than mis-attribute it to the outer tweet or the page permalink.
 */
function resolveTweetContext(
  img: HTMLImageElement,
  article: Element | null,
  pathname: string,
): TweetContext | null {
  const own = linkContext(img.closest(STATUS_LINK_SEL))
  if (own) return own
  const quoteCard = article ? img.closest('div[role="link"]') : null
  const quote = quoteCard && article!.contains(quoteCard) ? quoteCard : null
  if (quote) return null
  return (article ? contextFromArticle(article) : null) ?? contextFromPath(pathname)
}

/** Position of `img` among the article's grabbable photos sharing `tweetId`
 *  (or 0). The DOM-order fallback index when no `/photo/{n}` ordinal is known. */
function photoIndexInArticle(
  article: Element,
  img: HTMLImageElement,
  tweetId: string | undefined,
): number {
  const photos = Array.from(article.querySelectorAll('img')).filter((el) => {
    if (!isGrabbablePhotoUrl(el.currentSrc || el.src)) return false
    const elCtx = linkContext(el.closest(STATUS_LINK_SEL))
    return (elCtx?.tweetId ?? tweetId) === tweetId
  })
  const pos = photos.indexOf(img)
  /* v8 ignore next -- the hovered img always passes the same filter, so it is always found (pos >= 0) */
  return pos >= 0 ? pos : 0
}

/**
 * Resolve one hovered `<img>` into a single Original-quality photo Media Item —
 * the Quick Grab unit — or `null` if it isn't a grabbable X photo.
 *
 * Quality reuses {@link upgradePhotoUrl} (forces `name=orig`). Tweet context for
 * the filename comes from {@link resolveTweetContext} (own anchor, else article,
 * else page `pathname`); failing that, the media key stands in as the tweetId so
 * `renderFilename` still yields a valid relative path. `index` is the photo's
 * position among the tweet's grabbable images, or the `/photo/{n}` ordinal when
 * the path provides one.
 */
export function resolveImageElement(img: HTMLImageElement, pathname = ''): MediaItem | null {
  const src = img.currentSrc || img.src
  if (!isGrabbablePhotoUrl(src)) return null
  const key = mediaKeyFromUrl(src)
  if (!key) return null

  const article = img.closest(TWEET_ARTICLE_SEL)
  const ctx = resolveTweetContext(img, article, pathname)
  const index = ctx?.index ?? (article ? photoIndexInArticle(article, img, ctx?.tweetId) : 0)

  const tweetId = ctx?.tweetId ?? key
  // Ext follows the UPGRADED url: `upgradePhotoUrl` rewrites webp renditions to
  // jpg originals, and the saved file's extension must match what's fetched.
  const url = upgradePhotoUrl(src)
  return {
    // Identity is the media key, so this photo is the SAME item whether the tee,
    // syndication, or this DOM resolver surfaced it (ADR-0016). `tweetId`/`index`
    // still drive the filename.
    id: key,
    tweetId,
    handle: ctx?.handle ?? '',
    type: 'photo',
    url,
    ext: extFromImgUrl(url),
    index,
  }
}

/** Resolve rendered X photo images already present in a timeline/list DOM. */
export function detectRenderedImageElements(root: ParentNode, pathname = ''): MediaItem[] {
  const out: MediaItem[] = []
  const seen = new Set<string>()
  for (const img of root.querySelectorAll<HTMLImageElement>('img')) {
    const item = resolveImageElement(img, pathname)
    /* v8 ignore next -- item.url is always a grabbable /media/ photo with a valid key, so the `?? item.id` arm is dead */
    const key = item ? (mediaKeyFromUrl(item.url) ?? item.id) : null
    if (!item || !key || seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

/**
 * Resolve one hovered media element into its Media Item for the Overlay fast paths
 * (Quick Grab / per-item badge). The tee-detected map (media-key → item, populated
 * from captured GraphQL) is authoritative: a hovered `<video>` has no DOM-derivable
 * URL, so it resolves ONLY through the tee, and even a photo prefers the tee item
 * (richer provenance) over DOM resolution. When the key is unknown, an `<img>`
 * falls back to {@link resolveImageElement} (Original-quality photo) and anything
 * else yields `null`.
 */
export function resolveHoverItem(
  element: Element,
  key: string,
  detected: ReadonlyMap<string, MediaItem>,
  pathname = '',
): MediaItem | null {
  const teed = detected.get(key)
  if (teed !== undefined) return teed
  if (element instanceof HTMLImageElement) return resolveImageElement(element, pathname)
  return null
}

/**
 * Whether {@link resolveHoverItem} would yield an item — the cheap predicate the
 * overlay gates badge/Quick-Grab rendering on (it runs on every hover), so a badge
 * never flashes on hover then vanishes on click. True when the tee knows the key,
 * or the element is a grabbable photo `<img>`. Mirrors {@link resolveImageElement}'s
 * own URL gate rather than calling it: a full resolve (article walk + photo-index
 * scan) is wasted work on a mousemove hot path when only the yes/no is needed.
 */
export function canResolveHoverItem(
  element: Element,
  key: string,
  detected: ReadonlyMap<string, MediaItem>,
): boolean {
  if (detected.has(key)) return true
  return (
    element instanceof HTMLImageElement && isGrabbablePhotoUrl(element.currentSrc || element.src)
  )
}

/** The grabbable poster url for a rendered X video player — via its hidden
 *  `<video>` if present, else the `…_video_thumb…` `<img>` X paints in the same
 *  container before the player mounts. Null when neither yields a twimg preview. */
function playerPosterUrl(player: Element): string | null {
  const video = player.querySelector('video')
  if (video) return videoPosterUrl(video)
  const img = player.querySelector<HTMLImageElement>(
    'img[src*="_video_thumb"], img[srcset*="_video_thumb"]',
  )
  const src = img ? img.currentSrc || img.src : ''
  return isGrabbableMediaPreviewUrl(src) ? src : null
}

/**
 * Tweet ids on the page whose video/GIF the passive tee never captured: a
 * rendered X video player whose poster media-key is absent from the already
 * detected keys. These are exactly the tweets the syndication fallback should
 * fetch — the DOM surfaces the player but never the MP4, so without recovery the
 * video stays uncounted and un-downloadable (a "video + N photos" tweet reads as
 * N). A teed video already contributes its poster key (its MediaItem's
 * `previewUrl`), so it is correctly skipped. De-duplicated by tweet id.
 */
export function videoTweetsNeedingRecovery(
  root: ParentNode,
  detectedKeys: ReadonlySet<string>,
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const player of root.querySelectorAll(VIDEO_PLAYER_SEL)) {
    const poster = playerPosterUrl(player)
    if (!poster) continue
    const key = mediaKeyFromUrl(poster)
    if (!key || detectedKeys.has(key)) continue
    const article = player.closest(TWEET_ARTICLE_SEL)
    const tweetId = article ? contextFromArticle(article)?.tweetId : undefined
    if (!tweetId || seen.has(tweetId)) continue
    seen.add(tweetId)
    out.push(tweetId)
  }
  return out
}
