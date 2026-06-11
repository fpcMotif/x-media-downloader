import type { MediaItem } from '../../schema'
import type { Registry } from '../../selection'

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
  const base = u.pathname.slice(u.pathname.lastIndexOf('/') + 1)
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
  const section = u.pathname.split('/')[1] ?? ''
  return (
    u.pathname.startsWith('/media/') ||
    section === 'tweet_video_thumb' ||
    section === 'ext_tw_video_thumb' ||
    section === 'amplify_video_thumb'
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
    const base = u.pathname.slice(u.pathname.lastIndexOf('/') + 1)
    const dot = base.lastIndexOf('.')
    return dot >= 0 ? base.slice(dot + 1) : 'jpg'
  } catch {
    return 'jpg'
  }
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
    let group = groups.get(item.tweetId)
    if (group === undefined) {
      group = []
      groups.set(item.tweetId, group)
      order.push(item.tweetId)
    }
    group.push(item)
  }
  return order.map((tweetId) => ({ tweetId, items: groups.get(tweetId)! }))
}
