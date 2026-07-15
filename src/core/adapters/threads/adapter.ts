import type { PlatformAdapter } from '../types'
import { detectMediaItems, postCodesInResponse } from '../meta-shared/detect'
import {
  mediaKeyFromMetaCombinedUrl,
  isGrabbableMetaPhotoUrl,
  resolveMetaImageElement,
} from '../meta-shared/dom'
import { findPostContainer, postCodeFromContainer } from '../meta-shared/post-anchor'
import { META_CDN_HOSTS } from '../meta-shared/cdn'
import { postVideoKey, postVideoKeyByDomSlot } from '../detection-store'

/** Threads' post-boundary selector — LIVE-VERIFIED 2026-07-05: zero
 *  <article>/[role=article] elements exist; the real per-post boundary is
 *  `div[data-pressable-container='true']` (confirmed non-nested, 1:1 with one
 *  post link, across 44 live containers). */
const THREADS_POST_SELECTOR = "div[data-pressable-container='true']"

/** Threads' post-permalink link pattern — LIVE-VERIFIED 2026-07-05:
 *  `/@{username}/post/{code}`, optionally suffixed `/media`. Handles a
 *  trailing `-` in the code (seen live: `.../DaXWrlBEyf-`). */
const THREADS_POST_LINK_PATTERN = /^\/@[^/]+\/post\/([^/?#]+)/

/** The postId a hovered element's Threads post resolves to, by walking up to
 *  its nearest pressable-container and reading THAT container's post link
 *  fresh (never a cached reference — Threads' virtualization was confirmed to
 *  recycle a container's contents to a different post between two reads). */
function postIdFromDom(el: Element): string | null {
  const container = findPostContainer(el, THREADS_POST_SELECTOR)
  if (!container) return null
  return postCodeFromContainer(container, 'a[href]', THREADS_POST_LINK_PATTERN)
}

/** The carousel track ancestor of `el` — an inline `transform: translateX(...)`
 *  div (LIVE-VERIFIED 2026-07-05 against a real 2-video/3-photo Threads
 *  carousel: https://www.threads.com/@zuck/post/DZ7eGA1G7wU) — or null if
 *  `el` isn't inside a recognizable carousel track at all (single-media
 *  post). Selecting by inline style rather than Threads' own wrapper class
 *  names is deliberate: those classes are build-obfuscated atomic `x*`
 *  classes with no stable semantic hook, confirmed to differ across
 *  elements/builds, whereas the track's `translateX` positioning is a
 *  structural property of "this is a horizontally-scrolling carousel". */
function trackFor(el: Element): Element | null {
  return el.closest('[style*="translateX"]')
}

/** The direct children of `track` that are actual slide wrappers, excluding
 *  the always-present LEADING spacer (LIVE-VERIFIED: track's first child
 *  carries zero element children of its own — every real slide wrapper has
 *  at least one, the mounted `<img>`/`<video>`). Structural exclusion
 *  (childElementCount, not a class/width check) so this is identical in
 *  happy-dom (no computed layout) and a real browser. */
function mountedSlideWrappers(track: Element): Element[] {
  return [...track.children].filter((c) => c.childElementCount > 0)
}

/** `el`'s own mounted slide-wrapper: the direct child of `track` (see
 *  {@link trackFor}) that contains `el`, excluding the empty leading spacer —
 *  or null if none of `track`'s children actually contain `el` (shouldn't
 *  happen given `track` was found by walking UP from `el`, but fails closed
 *  rather than asserting). */
function slideWrapperFor(el: Element, track: Element): Element | null {
  return [...track.children].find((c) => c.contains(el) && c.childElementCount > 0) ?? null
}

/** The 0-based rank of `el`'s own slide wrapper among ALL of the MOUNTED slide
 *  wrappers (video and photo slides alike) — i.e. "this wrapper's position
 *  walking the currently-mounted track in DOM order". This MUST count every
 *  slide, not just video-containing ones: `detection-store.ts`'s
 *  `syncPostVideoKey` registers `postVideoKeyByDomSlot`/`postVideoKeyIndexed`
 *  keyed by each video's ABSOLUTE `MediaItem.index` (photos included in that
 *  count, since the tee assigns index across the whole carousel) — a
 *  video-only count would drift from the store's absolute-index scheme the
 *  moment a photo slide sits before a 2nd-or-later video (LIVE-VERIFIED
 *  mixed-window shape: [spacer, video, photo, video] — the store indexes the
 *  second video at 2, not 1). Window-relative, not absolute: Threads mounts
 *  only a sliding window of the full carousel (current ± 1, LIVE-VERIFIED)
 *  with no absolute-position indicator anywhere in the DOM (no counter, no
 *  dots, no aria-current) — this is the wrapper's position among whatever's
 *  mounted RIGHT NOW. This only matches the store's absolute index when the
 *  mounted window starts at the carousel's own slide 0 (a fresh mount); a
 *  scrolled-into-view window (current ± 1 starting mid-carousel) still won't
 *  line up with the tee's whole-carousel index — an accepted residual gap
 *  (see the module doc's known v1 scope limits), not one this fix claims to
 *  close. Reads fresh every call — no caching, matching `postIdFromDom`'s own
 *  posture (Threads' virtualization was confirmed to recycle a container's
 *  contents between reads). Takes the already-resolved `wrapper` (from
 *  {@link slideWrapperFor}) rather than re-deriving it, so the caller's own
 *  "does a track exist at all" guard isn't duplicated here — `wrapper` is
 *  always one of `track`'s own mounted children by construction, so the loop
 *  always finds it. */
function videoDomSlotAmongMountedSlides(wrapper: Element, track: Element): number {
  let slot = 0
  for (const slide of mountedSlideWrappers(track)) {
    if (slide === wrapper) return slot
    slot++
  }
  /* v8 ignore next -- wrapper is always one of track's own mounted children (see doc above) */
  return slot
}

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
 * Threads' `PlatformAdapter`. Detection is entirely the shared meta-shared
 * pipeline (`detectMediaItems`, tagged 'threads') — Threads and Instagram are,
 * per research, the same backend media schema, so there is no Threads-only
 * parsing logic here at all.
 */
export const threadsAdapter: PlatformAdapter = {
  platform: 'threads',
  hostMatch: THREADS_HOST_MATCH,
  // Same Meta CDN family as Instagram — see meta-shared/cdn.ts's module doc.
  cdnHosts: META_CDN_HOSTS,
  matchesUrl: isThreadsUrl,
  // Second (`requestHeaders`) param accepted for interface conformance only,
  // unused today — a future revision may switch to header-based matching
  // (e.g. an `x-fb-friendly-name`/doc_id scheme) once a live session confirms
  // which one Threads actually sends; see isTrackedThreadsResponseUrl's doc.
  isTrackedResponseUrl: isTrackedThreadsResponseUrl,
  detectFromResponse: (_url, json) => detectMediaItems(json, 'threads'),
  // Combined photo-or-video key deriver: a hovered <video> with a real,
  // non-blob: `tN`-shaped url (LIVE-VERIFIED 2026-07-05 on a real Threads
  // carousel, @zuck/DZ7eGA1G7wU) now resolves via this url-based path
  // directly — no DOM-anchor/index machinery needed for that case at all.
  // See meta-shared/dom.ts's mediaKeyFromMetaCombinedUrl.
  mediaKeyFromUrl: mediaKeyFromMetaCombinedUrl,
  // Real post-identity DOM detection (a rescan needing pk/code/author) stays
  // deferred for the "initial paint" role `detectRenderedMedia` plays — see
  // `postIdFromDom`/`postKeyFromVideoElement` below for the narrower "map a
  // hovered element to its post" anchor (hover-only, not a rescan).
  // LIVE-VERIFIED 2026-07-05 (Chrome Canary, logged-in Threads): photo <img>
  // elements carry a real, direct cdninstagram.com CDN url (same CDN family
  // as Instagram, confirmed identical host/path-family conventions) in
  // `currentSrc`. Threads' own video/poster DOM shape was NOT independently
  // re-verified this session (only Instagram's reel was checked) — the
  // `data-pressable-container`/`/@user/post/{code}` post-anchor selectors
  // above ARE Threads-specific and live-verified, but the video element's own
  // src/poster shape defaults to the same "no usable identity" assumption as
  // Instagram's, not an independently re-confirmed fact for Threads
  // specifically. `resolveHoverItem`/`canResolveHoverItem` don't need a
  // video-specific branch: `previewKeyFromMedia` (overlay.content/index.tsx)
  // already falls back to `postKeyFromVideoElement`'s `post:{code}`/
  // `post:{code}:slot:{n}` string as `key` for a hovered video, so
  // `detected.get(key)` below transparently resolves it once
  // `detection-store.ts` has registered that key — multi-video (and mixed
  // photo/video) carousels ARE supported via the dom-slot key form
  // (`postVideoKeyByDomSlot`, keyed by `videoDomSlotAmongMountedSlides`'s
  // mounted-window slide position), not just single-video posts; see
  // meta-shared/post-anchor.ts's module doc for the one still-open scope
  // limit (ambiguous first-matching-link inside a container) and this
  // module's own `videoDomSlotAmongMountedSlides` doc for the window-relative
  // (not absolute-position) caveat specific to Threads' virtualized mount.
  detectRenderedMedia: () => [],
  resolveHoverItem: (el, key, detected) => {
    const teed = detected.get(key)
    if (teed !== undefined) return teed
    return el instanceof HTMLImageElement ? resolveMetaImageElement(el, 'threads') : null
  },
  canResolveHoverItem: (el, key, detected) => {
    if (detected.has(key)) return true
    return el instanceof HTMLImageElement && isGrabbableMetaPhotoUrl(el.currentSrc || el.src)
  },
  extractPostCodes: postCodesInResponse,
  // `pathname` accepted for interface conformance only, unused: Threads'
  // own post-boundary DOM anchor (`data-pressable-container`) is present on
  // both feed and permalink pages alike (unlike Instagram's <article>, which
  // is absent on a standalone permalink page) — Threads never needs the
  // pathname-fallback Instagram's adapter implements.
  postKeyFromVideoElement: (video, _pathname) => {
    const code = postIdFromDom(video)
    if (!code) return null
    const track = trackFor(video)
    const wrapper = track ? slideWrapperFor(video, track) : null
    if (!track || !wrapper) return postVideoKey(code) // no track/wrapper found: single-media post
    // Always the indexed/dom-slot form once inside a real carousel track —
    // even at domSlot 0. A DOM walk can't tell "this post has exactly one
    // video" from "this post has 2+ videos and the hovered one happens to be
    // the first" — only the store knows the video count. The store already
    // registers the domSlot-0 alias uniformly regardless of count (see
    // `syncPostVideoKey`'s own doc), so this never regresses the
    // single-video case; using the bare `postVideoKey(code)` shortcut here
    // instead would silently fail to resolve for any multi-video carousel
    // whose first mounted slide is a video, since the store deletes that
    // bare key the moment a post has 2+ videos.
    const domSlot = videoDomSlotAmongMountedSlides(wrapper, track)
    return postVideoKeyByDomSlot(code, domSlot)
  },
  // The post's own `/@user/post/{code}` shortcode for ANY hovered element
  // (photo or video), so the overlay's whole-post grab can map it → the tee's
  // real postId even when a hovered photo's `<img>` basename never matched a
  // tee item. Same DOM anchor `postKeyFromVideoElement` uses (pathname unused,
  // as above), just returning the raw code.
  postCodeFromElement: (el, _pathname) => postIdFromDom(el),
  // findMediaNeedingRecovery intentionally omitted: no public/no-auth
  // recovery fallback exists for Threads (oEmbed is Meta-app-registration-
  // gated), confirmed by the design spec's research — not merely unbuilt.
}
