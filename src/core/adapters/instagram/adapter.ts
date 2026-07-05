import { detectMediaItems, postCodesInResponse } from '../meta-shared/detect'
import { mediaKeyFromMetaUrl, isGrabbableMetaPhotoUrl, extFromMetaImgUrl } from '../meta-shared/dom'
import { findPostContainer, postCodeFromContainer } from '../meta-shared/post-anchor'
import { postVideoKey } from '../detection-store'
import type { MediaItem } from '../../schema'
import type { PlatformAdapter } from '../types'

/** Instagram's post-boundary selector — the confirmed stable ancestor
 *  (LIVE-VERIFIED 2026-07-05): a real <article>, no id/data-attr/role of its own. */
const INSTAGRAM_POST_SELECTOR = 'article'

/** The universal post-shortcode link every Instagram feed post carries
 *  (LIVE-VERIFIED 2026-07-05): `<a href="/p/{code}/">`, present on every post
 *  regardless of media type — NOT the video-specific `/reels/{code}/` link,
 *  which is additive-only on video posts and therefore unnecessary: `/p/`
 *  alone is sufficient and simpler. */
const INSTAGRAM_POST_LINK_PATTERN = /^\/p\/([A-Za-z0-9_-]+)\//

/** The postId a hovered element's Instagram post resolves to, by walking up
 *  to its nearest <article> and reading that article's `/p/{code}/` link
 *  fresh — or null if `el` isn't inside a post, or the post carries no such
 *  link (shouldn't happen per research, but fails closed rather than throws). */
function postIdFromDom(el: Element): string | null {
  const container = findPostContainer(el, INSTAGRAM_POST_SELECTOR)
  if (!container) return null
  return postCodeFromContainer(container, 'a[href]', INSTAGRAM_POST_LINK_PATTERN)
}

/** Host-match pattern for Instagram tabs — the single source of truth for the
 *  manifest content-script glob and `browser.tabs.query` (mirrors X_HOST_MATCH's
 *  role). Instagram serves its whole web app from `www.instagram.com` only —
 *  no bare `instagram.com` redirect target to also list, unlike X's two hosts. */
export const INSTAGRAM_HOST_MATCH = ['*://www.instagram.com/*'] as const

/** Whether a URL is a www.instagram.com page. Anchored (`^`) so a URL that
 *  merely contains 'https://www.instagram.com/' as a substring — e.g. a
 *  redirect/query param carrying it — doesn't false-positive-match. */
export const isInstagramUrl = (url: string): boolean =>
  /^https?:\/\/www\.instagram\.com\//.test(url)

/**
 * True for a captured response URL Instagram's own frontend plausibly used to
 * fetch post/media data.
 *
 * LIVE-VERIFIED TWICE 2026-07-05 (Chrome Canary, logged-in session, via
 * claude-in-chrome network inspection — see the as-built plan doc), with the
 * second pass CORRECTING the first: an initial page-load-only check saw only
 * `POST /api/graphql` and concluded `/graphql/query` was unused. A later
 * session doing normal feed scrolling (not just initial load) observed BOTH
 * `/api/graphql` AND `/graphql/query` firing — Instagram uses both, exactly
 * like Threads, just not necessarily in the same interaction. The first,
 * narrower fix was itself an under-verification: a single interaction
 * pattern isn't enough to rule out an endpoint. Match both.
 *
 * Deliberately loose by design, not just for lack of verification: a
 * false-positive URL match only costs one wasted JSON parse that structurally
 * finds nothing (`detectMediaItems` returns `[]` for a shape with no
 * post-shaped node) — it can NEVER mis-attribute media to the wrong post,
 * because detection is entirely shape-driven (`forEachPostNode` +
 * `mediaNodesFromPost`), not URL-driven. A narrower filter would only reduce
 * wasted parses, at the risk of a false negative silently dropping real media
 * capture — the wrong trade for a filter this cheap to over-match, and
 * exactly the mistake the first live-verification pass made.
 */
export function isTrackedInstagramResponseUrl(url: string): boolean {
  return url.includes('/api/graphql') || url.includes('/graphql/query') || url.includes('/api/v1/')
}

/**
 * Resolve one hovered `<img>` into a placeholder photo MediaItem when the tee
 * hasn't already seen it. No post identity (pk/code/author) is DOM-derivable
 * here (unlike X's `/status/` anchors), so `postId` is set to the media key
 * itself — mirrors X's own `ctx?.tweetId ?? key` fallback shape.
 *
 * KNOWN TRANSIENT-WINDOW EFFECT: a carousel post hovered before the tee
 * resolves it forms N separate single-item groups (each DOM-only item's own
 * key as its `postId`) instead of one N-item group, for any future consumer
 * that groups items by `postId` (none exists on this hot path today — see
 * `x/dom.ts`'s `groupByTweet`, currently unconsumed outside its own test).
 * Self-heals the moment the tee resolves the same post: both the DOM
 * fallback and the tee derive `id` from the identical basename-extraction
 * algorithm, so `DetectionStore`'s existing same-id-overwrites-by-id
 * semantics replace this placeholder with the tee's correctly-grouped item.
 * Until then, Quick Grab / single-item download works correctly — only
 * multi-item grouping is transiently wrong.
 */
function resolveMetaImageElement(img: HTMLImageElement): MediaItem | null {
  const src = img.currentSrc || img.src
  const key = mediaKeyFromMetaUrl(src)
  if (!key) return null
  return {
    id: key,
    platform: 'instagram',
    postId: key,
    author: '',
    type: 'photo',
    url: src,
    ext: extFromMetaImgUrl(src),
    index: 0,
  }
}

/**
 * Instagram's `PlatformAdapter`. Unlike X, Instagram has no repost/quote
 * concept (confirmed by research) — `detectFromResponse` never needs to
 * special-case an embedded original post the way Threads' `reposted_post`/
 * `quoted_post` will.
 */
export const instagramAdapter: PlatformAdapter = {
  platform: 'instagram',
  hostMatch: INSTAGRAM_HOST_MATCH,
  matchesUrl: isInstagramUrl,
  // `requestHeaders` is accepted for interface conformance but unused here —
  // same posture as X's isGraphqlMediaUrl. A future revision may switch to
  // matching on `x-fb-friendly-name`/doc_id instead of the URL string once a
  // live session confirms which header/op-name scheme Instagram actually uses
  // (research flags the header route as more stable than the URL string, but
  // this hasn't been independently verified against a live network capture).
  isTrackedResponseUrl: (url, _requestHeaders) => isTrackedInstagramResponseUrl(url),
  detectFromResponse: (_url, json) => detectMediaItems(json, 'instagram'),
  mediaKeyFromUrl: mediaKeyFromMetaUrl,
  // Real post-identity DOM detection (a rescan needing pk/code/author) stays
  // deferred for the "initial paint" role `detectRenderedMedia` plays — see
  // `postIdFromDom`/`postKeyFromVideoElement` below for the narrower "map a
  // hovered element to its post" anchor that IS built (hover-only, not a
  // rescan). Hover resolution below maps a key to whatever the tee already
  // resolved with correct identity, or (photos only) a self-contained DOM
  // fallback. LIVE-VERIFIED 2026-07-05: photo `<img>` elements carry a real,
  // direct cdninstagram.com CDN url in `currentSrc`; videos use a `blob:`
  // MediaSource src with no nearby poster `<img>` (checked 8 ancestor levels
  // up on a real reel) — so a video's OWN url/poster carries no identity.
  // `resolveHoverItem`/`canResolveHoverItem` don't need a video-specific
  // branch though: `previewKeyFromMedia` (overlay.content/index.tsx) already
  // falls back to `postKeyFromVideoElement`'s `post:{code}` string as `key`
  // for a hovered video, so `detected.get(key)` below transparently resolves
  // it once `detection-store.ts` has registered that key (single-video posts
  // only — a carousel with 2+ videos never registers the key, v1 scope limit,
  // see meta-shared/post-anchor.ts's module doc).
  detectRenderedMedia: () => [],
  resolveHoverItem: (element, key, detected) => {
    const teed = detected.get(key)
    if (teed !== undefined) return teed
    return element instanceof HTMLImageElement ? resolveMetaImageElement(element) : null
  },
  canResolveHoverItem: (element, key, detected) => {
    if (detected.has(key)) return true
    return (
      element instanceof HTMLImageElement &&
      isGrabbableMetaPhotoUrl(element.currentSrc || element.src)
    )
  },
  extractPostCodes: postCodesInResponse,
  postKeyFromVideoElement: (video) => {
    const code = postIdFromDom(video)
    return code ? postVideoKey(code) : null
  },
  // No findMediaNeedingRecovery: Instagram has no public/no-auth fallback
  // (oEmbed is Meta-app-registration-gated) — confirmed by research, per the
  // design spec's PlatformAdapter interface comment.
} satisfies PlatformAdapter
