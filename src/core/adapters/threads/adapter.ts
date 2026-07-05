import type { PlatformAdapter } from '../types'
import { detectMediaItems } from '../meta-shared/detect'
import { mediaKeyFromMetaUrl, isGrabbableMetaPhotoUrl, extFromMetaImgUrl } from '../meta-shared/dom'
import type { MediaItem } from '../../schema'

/** Host-match patterns for Threads tabs — both the pre- and post-migration
 *  domains. Threads moved `threads.net` → `threads.com` in April 2025; both
 *  hosts serve the same backend behind the redirect (research-confirmed), so
 *  one adapter covers both — no per-domain branching. */
export const THREADS_HOST_MATCH = ['*://www.threads.net/*', '*://www.threads.com/*'] as const

/** Whether a URL is a www.threads.net / www.threads.com page. */
export const isThreadsUrl = (url: string): boolean =>
  /^https?:\/\/www\.threads\.(net|com)\//.test(url)

/**
 * Whether a network response URL may carry Threads post/media data.
 *
 * LIVE-VERIFIED 2026-07-04 (Chrome Canary, logged-in session, via claude-in-
 * chrome network inspection — see the as-built plan doc): Threads' web client
 * actually dispatches through BOTH `POST /api/graphql` AND `POST
 * /graphql/query` in the same browsing session (unlike Instagram, which was
 * observed using only `/api/graphql`) — match either, or real traffic is
 * silently missed.
 *
 * Filtering this loosely is deliberate and safe by construction:
 * `detectFromResponse` is entirely shape-driven (it structurally walks the
 * JSON for post-shaped nodes), never URL-driven. A false-positive match here
 * only costs one wasted JSON parse that structurally finds nothing and
 * returns `[]` — it can never cause a media item to be mis-attributed to the
 * wrong post, because the URL plays no role in resolving WHICH post a media
 * node belongs to. Compare X, where a missed/looser URL filter risks parsing
 * the wrong response shape entirely; here the shape-driven walker is itself
 * the correctness backstop.
 */
export function isTrackedThreadsResponseUrl(
  url: string,
  requestHeaders?: Readonly<Record<string, string>>,
): boolean {
  void requestHeaders
  return url.includes('/api/graphql') || url.includes('/graphql/query')
}

/**
 * Resolve one hovered `<img>` into a placeholder photo MediaItem when the tee
 * hasn't already seen it. Identical shape to Instagram's own resolver — same
 * shared CDN, same key rule (`meta-shared/dom.ts`), no Threads-specific
 * variant. See `instagram/adapter.ts`'s `resolveMetaImageElement` for the
 * full carousel-transient-grouping caveat (applies here too, unchanged).
 */
function resolveMetaImageElement(img: HTMLImageElement): MediaItem | null {
  const src = img.currentSrc || img.src
  const key = mediaKeyFromMetaUrl(src)
  if (!key) return null
  return {
    id: key,
    platform: 'threads',
    postId: key,
    author: '',
    type: 'photo',
    url: src,
    ext: extFromMetaImgUrl(src),
    index: 0,
  }
}

/**
 * Threads' `PlatformAdapter`. Detection is entirely the shared meta-shared
 * pipeline (`detectMediaItems`, tagged 'threads') — Threads and Instagram are,
 * per research, the same backend media schema, so there is no Threads-only
 * parsing logic here at all.
 */
export const threadsAdapter: PlatformAdapter = {
  platform: 'threads',
  hostMatch: THREADS_HOST_MATCH,
  matchesUrl: isThreadsUrl,
  // Second (`requestHeaders`) param accepted for interface conformance only,
  // unused today — a future revision may switch to header-based matching
  // (e.g. an `x-fb-friendly-name`/doc_id scheme) once a live session confirms
  // which one Threads actually sends; see isTrackedThreadsResponseUrl's doc.
  isTrackedResponseUrl: isTrackedThreadsResponseUrl,
  detectFromResponse: (_url, json) => detectMediaItems(json, 'threads'),
  mediaKeyFromUrl: mediaKeyFromMetaUrl,
  // Real post-identity DOM detection (a rescan needing pk/code/author) stays
  // deferred — no anchor-walk for Threads was live-verified this session
  // either. Hover resolution is strictly narrower (map a key to whatever the
  // tee already resolved with correct identity, or — photos only — a
  // self-contained DOM fallback) and doesn't have that problem.
  // LIVE-VERIFIED 2026-07-05 (Chrome Canary, logged-in Threads): photo <img>
  // elements carry a real, direct cdninstagram.com CDN url (same CDN family
  // as Instagram, confirmed identical host/path-family conventions) in
  // `currentSrc`. Threads' own video/poster DOM shape was NOT independently
  // re-verified this session (only Instagram's reel was checked) — defaults
  // to the same tee-map-only posture as a reasoned default, not a verified
  // fact for Threads specifically. Video DOM-hover is NOT attempted below
  // (gated on `HTMLImageElement`).
  detectRenderedMedia: () => [],
  resolveHoverItem: (el, key, detected) => {
    const teed = detected.get(key)
    if (teed !== undefined) return teed
    return el instanceof HTMLImageElement ? resolveMetaImageElement(el) : null
  },
  canResolveHoverItem: (el, key, detected) => {
    if (detected.has(key)) return true
    return el instanceof HTMLImageElement && isGrabbableMetaPhotoUrl(el.currentSrc || el.src)
  },
  // findMediaNeedingRecovery intentionally omitted: no public/no-auth
  // recovery fallback exists for Threads (oEmbed is Meta-app-registration-
  // gated), confirmed by the design spec's research — not merely unbuilt.
}
