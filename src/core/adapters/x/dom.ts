import type { MediaItem } from '../../schema'
import type { Registry } from '../../selection'

/** The final path segment of a URL pathname (everything after the last `/`). */
const lastSegment = (pathname: string): string => pathname.slice(pathname.lastIndexOf('/') + 1)

/** A `[href*="/status/"]` anchor — X's tweet permalink, the source of author +
 *  tweetId context for a rendered media element. */
export const STATUS_LINK_SEL = 'a[href*="/status/"]'

/**
 * Extract the stable media key from a twimg URL — the final path segment without
 * its extension. A rendered `<img>` on the page and a detected MediaItem's
 * resolved `url` share this key, so hovering a DOM element can be matched back to
 * its MediaItem. Returns null for anything that isn't a twimg media URL.
 */
export function mediaKeyFromUrl(url: string): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  // Exact host or a real `.twimg.com` subdomain — `endsWith('twimg.com')` alone
  // would also accept a spoofed `evil-twimg.com`.
  if (u.hostname !== 'pbs.twimg.com' && !u.hostname.endsWith('.twimg.com')) return null
  const base = lastSegment(u.pathname)
  const dot = base.lastIndexOf('.')
  const key = dot >= 0 ? base.slice(0, dot) : base
  return key.length > 0 ? key : null
}

/**
 * Whether a URL is a grabbable original-quality X *photo*: a `pbs.twimg.com`-style
 * twimg host under the `/media/` path only. This deliberately excludes avatars
 * (`/profile_images/`), link-card thumbnails (`/card_img/`), emoji, and video
 * poster frames (`/*_video_thumb/`) — none of which live under `/media/`. Quick
 * Grab needs this because hovering surfaces *any* `<img>`, not just media ones.
 */
export function isGrabbablePhotoUrl(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  // Photos are served only from `pbs.twimg.com`; pin the host exactly so neither a
  // spoofed `evil-twimg.com` nor `video.twimg.com/media/*` slips through.
  if (u.hostname !== 'pbs.twimg.com') return false
  return u.pathname.startsWith('/media/')
}

/**
 * The `pbs.twimg.com` path sections that serve a video/GIF *poster frame* — the
 * grabbable preview tiles that are NOT photos under `/media/`. The single source
 * for which video previews are grabbable: the predicate below tests membership,
 * and the overlay's grab-cursor CSS projects each into an `img[src]`/`video[poster]`
 * selector, so a new poster section is added in one place, not two.
 */
export const VIDEO_PREVIEW_SECTIONS = [
  'tweet_video_thumb',
  'ext_tw_video_thumb',
  'amplify_video_thumb',
] as const

/**
 * URLs that represent a media tile the user can hover: original photo renditions
 * plus X's poster frames for videos/GIFs. The poster maps back to a detected
 * MediaItem through `previewUrl`; the saved URL can still be a best-bitrate MP4.
 */
export function isGrabbableMediaPreviewUrl(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.hostname !== 'pbs.twimg.com') return false
  /* v8 ignore next -- `URL.pathname` is always >= '/', so split('/')[1] is never undefined */
  const section = u.pathname.split('/')[1] ?? ''
  return (
    u.pathname.startsWith('/media/') ||
    (VIDEO_PREVIEW_SECTIONS as readonly string[]).includes(section)
  )
}

/**
 * The file extension for a *live* `<img>` photo. X serves the rendition format as
 * a `?format=` query param (`jpg|png|webp`) rather than a path extension, so read
 * that first; fall back to a dotted path segment, then to `jpg`. (The resolver's
 * own ext logic reads only the path dot — correct for raw `media_url_https`, wrong
 * for a rendered `<img>.src` whose path has no extension.)
 */
export function extFromImgUrl(url: string): string {
  try {
    const u = new URL(url)
    const fmt = u.searchParams.get('format')
    if (fmt) return fmt.toLowerCase()
    const base = lastSegment(u.pathname)
    const dot = base.lastIndexOf('.')
    return dot >= 0 ? base.slice(dot + 1) : 'jpg'
  } catch {
    return 'jpg'
  }
}

/** X renders its video/GIF player under one of these testids. The real `<video>`
 *  is `visibility:hidden` with no `poster` (its `currentSrc` is a `blob:` MSE url),
 *  so it never appears in `elementsFromPoint`; the grabbable poster lives on a
 *  hidden sibling `…_video_thumb…` `<img>` inside the same container. */
export const VIDEO_PLAYER_SEL = '[data-testid="videoPlayer"], [data-testid="videoComponent"]'

/**
 * The grabbable poster URL for an X `<video>` — its own `poster` if that is a
 * twimg preview url, else the hidden `…_video_thumb…` `<img>` X renders in the
 * same player container. Returns null when neither yields a grabbable url. The
 * key from this poster matches the detected MediaItem's `previewUrl` key, so a
 * hovered video resolves to its tee-detected MP4 item.
 */
export function videoPosterUrl(video: HTMLVideoElement): string | null {
  const poster = video.poster || video.getAttribute('poster') || ''
  if (isGrabbableMediaPreviewUrl(poster)) return poster
  const container = video.closest(VIDEO_PLAYER_SEL) ?? video.parentElement
  const img = container?.querySelector<HTMLImageElement>(
    'img[src*="_video_thumb"], img[srcset*="_video_thumb"]',
  )
  const src = img ? img.currentSrc || img.src : ''
  return isGrabbableMediaPreviewUrl(src) ? src : null
}

/**
 * Group flat detected items into a per-tweet Registry (for the selection model),
 * de-duplicated by id, preserving first-seen order of both tweets and items.
 */
export function groupByTweet(items: ReadonlyArray<MediaItem>): Registry {
  const order: string[] = []
  const groups = new Map<string, MediaItem[]>()
  const seen = new Set<string>()
  for (const item of items) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    let group = groups.get(item.postId)
    if (group === undefined) {
      group = []
      groups.set(item.postId, group)
      order.push(item.postId)
    }
    group.push(item)
  }
  return order.map((tweetId) => ({ tweetId, items: groups.get(tweetId)! }))
}
