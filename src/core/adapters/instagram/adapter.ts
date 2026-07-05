import { detectMediaItems, postCodesInResponse } from '../meta-shared/detect'
import {
  mediaKeyFromMetaUrl,
  mediaKeyFromMetaCombinedUrl,
  isGrabbableMetaPhotoUrl,
  extFromMetaImgUrl,
} from '../meta-shared/dom'
import { findPostContainer, postCodeFromContainer } from '../meta-shared/post-anchor'
import { postVideoKey, postVideoKeyIndexed } from '../detection-store'
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

/**
 * The post-shortcode pattern for a standalone Instagram permalink PAGE url
 * itself (`location.pathname`, not an `<a href>`) — `/p/{code}/`,
 * `/reel/{code}/`, or `/reels/{code}/`. LIVE-VERIFIED 2026-07-05: a `/reel/`
 * permalink page's own url is rewritten to `/reels/` (plural) once the
 * client-side router settles, so both forms must match. No trailing slash is
 * required (matches a bare `/p/{code}` too), same posture as
 * `INSTAGRAM_POST_LINK_PATTERN`'s own leniency.
 */
export const INSTAGRAM_PERMALINK_PATTERN = /^\/(?:p|reels?)\/([A-Za-z0-9_-]+)/

/** The post code carried by the CURRENT page's own `pathname` (a standalone
 *  permalink page's url), or null if `pathname` isn't a permalink shape at
 *  all (e.g. the home feed root, `/`, or a profile page). */
export function postCodeFromPathname(pathname: string): string | null {
  return INSTAGRAM_PERMALINK_PATTERN.exec(pathname)?.[1] ?? null
}

/**
 * The postId a hovered element's Instagram post resolves to, by walking up
 * to its nearest <article> and reading that article's `/p/{code}/` link
 * fresh — or, when no <article> ancestor exists at all (a standalone
 * permalink/reel page has ZERO <article> elements anywhere on the page,
 * LIVE-VERIFIED 2026-07-05: `document.querySelector('article') === null` on
 * a real instagram.com/p/{code}/ page), falls back to the CURRENT page's own
 * `pathname` — the permalink url already carries the post's own code, a much
 * simpler signal than any further DOM walk.
 *
 * RISK, DISCLOSED NOT SOLVED (see the design doc's Part A): a permalink page
 * can render a "More posts" suggested-content section below the main post,
 * whose links carry OTHER, different posts' codes. LIVE-VERIFIED 2026-07-05
 * against a real permalink page (instagram.com/p/DaSs_DTmWdw/, which DOES
 * have such a section, confirmed via distinct `/{username}/p/{code}/` links
 * in the DOM): that section's cards render `<img>` thumbnails only — zero
 * `<video>` elements anywhere outside the main post (`videoCount` on the page
 * was exactly 1, matching the single real post). No hero-content DOM
 * boundary is built regardless — the pathname fallback applies
 * unconditionally once no `<article>` ancestor is found, per that clean
 * (if not exhaustively proven) live negative result.
 *
 * SECOND GUARD, LIVE-VERIFIED 2026-07-05 (found via correctness review, not
 * the original design): Instagram's Reels IMMERSIVE player
 * (`/reels/{code}/`) is ALSO `<article>`-less, but unlike a `/p/{code}/`
 * permalink page (always exactly 1 mounted `<video>`), it mounts 6-11
 * sibling `<video>` elements simultaneously (off-screen ones included) while
 * `location.pathname` only ever reflects whichever reel is currently
 * scrolled into view. Applying the pathname fallback there would resolve
 * EVERY mounted sibling to the SAME post code — reproduced directly
 * pre-fix (two distinct sibling `<video>`s returned the identical key). The
 * permalink-page case this fallback exists for always has exactly one
 * `<video>` on the whole page (also live-verified), so gating on "exactly
 * one `<video>` reachable from `el`'s own root" cleanly separates the two
 * cases with no viewport/geometry check needed (geometry is also unusable
 * here: happy-dom computes no real layout, so any such check would be
 * untestable without mocking). `getRootNode()` is used rather than
 * `el.ownerDocument` so this counts correctly against a detached test
 * fixture too, not just a real attached page.
 */
function postIdFromDom(el: Element, pathname: string): string | null {
  const container = findPostContainer(el, INSTAGRAM_POST_SELECTOR)
  if (container) return postCodeFromContainer(container, 'a[href]', INSTAGRAM_POST_LINK_PATTERN)
  // `getRootNode()` resolves to the live `document` on a real page (every
  // mounted video lives there), but to the nearest detached fragment root in
  // a test that never attaches its scratch `<div>` to `document.body` —
  // either way this counts every video actually reachable from `el`'s own
  // tree, not a separate unrelated tree. A connected/detached element's root
  // is always a Document or DocumentFragment (a ShadowRoot IS a
  // DocumentFragment) — never a bare Element — so this covers every real
  // case `getRootNode()` can return.
  const root = el.getRootNode() as Document | DocumentFragment
  if (root.querySelectorAll('video').length !== 1) return null
  return postCodeFromPathname(pathname)
}

/** The 0-based carousel slide index of `li` (an <li> of the post's slide
 *  <ul>) among its slide siblings. LIVE-VERIFIED 2026-07-05: slide <li> order
 *  in the DOM (excluding the always-present trailing empty sentinel <li> — a
 *  real carousel's sentinel measures 1px wide; happy-dom computes no layout,
 *  so this excludes by DOM content instead of computed width, which is
 *  layout-independent and identical in intent: the sentinel carries no
 *  media, every real slide does) matches logical slide order. Takes the
 *  already-resolved `li` (the caller's own "is this a carousel at all" guard
 *  already found it via `closest('li')`) rather than re-deriving it, so that
 *  guard isn't duplicated here.
 *
 *  `li.parentElement` and `siblings.indexOf(li)` are never null/-1: a
 *  connected element always has a parent (an `<li>` can't be a document
 *  root), and `li` itself always satisfies the sibling filter (it's the
 *  ancestor-or-self match FOR the hovered element, which is what's actually
 *  rendered — it necessarily has at least one element child). No defensive
 *  fallback needed for either. */
function slideIndexFromDom(li: Element): number {
  const ul = li.parentElement!
  const siblings = [...ul.children].filter(
    (c) => c.tagName === 'LI' && c.childElementCount > 0, // drop the empty sentinel
  )
  return siblings.indexOf(li)
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
  // Combined photo-or-video key deriver: a hovered <video> with a real,
  // non-blob: `tN`-shaped url (LIVE-VERIFIED 2026-07-05 on a real Instagram
  // /p/{code}/ inline video post, instagram.com/p/DaSs_DTmWdw/) now resolves
  // via this url-based path directly — no DOM-anchor/index machinery needed
  // for that case at all. See meta-shared/dom.ts's mediaKeyFromMetaCombinedUrl.
  mediaKeyFromUrl: mediaKeyFromMetaCombinedUrl,
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
  // falls back to `postKeyFromVideoElement`'s `post:{code}`/`post:{code}:{index}`
  // string as `key` for a hovered video, so `detected.get(key)` below
  // transparently resolves it once `detection-store.ts` has registered that
  // key — multi-video (and mixed photo/video) carousels ARE supported via the
  // indexed key form (`postVideoKeyIndexed`, keyed by `slideIndexFromDom`'s
  // DOM slide position), not just single-video posts; see
  // meta-shared/post-anchor.ts's module doc for the one still-open scope
  // limit (ambiguous first-matching-link inside a container).
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
  postKeyFromVideoElement: (video, pathname) => {
    const code = postIdFromDom(video, pathname)
    if (!code) return null
    const li = video.closest('li')
    if (!li) return postVideoKey(code) // no <ul>/<li> ancestor: single-media post
    // Always the indexed form once inside a real carousel <ul> — even at
    // slide 0. A DOM walk can't tell "this post has exactly one video" from
    // "this post has 2+ videos and the hovered one happens to be the first
    // slide" — only the store (which knows the real video count) can. The
    // store already registers the index-0 alias uniformly regardless of
    // count (see `detection-store.ts`'s `syncPostVideoKey`), so this never
    // regresses the single-video case; using the bare `postVideoKey(code)`
    // shortcut here instead would silently fail to resolve for any
    // multi-video carousel whose first slide is a video, since the store
    // deletes that bare key the moment a post has 2+ videos.
    return postVideoKeyIndexed(code, slideIndexFromDom(li))
  },
  // No findMediaNeedingRecovery: Instagram has no public/no-auth fallback
  // (oEmbed is Meta-app-registration-gated) — confirmed by research, per the
  // design spec's PlatformAdapter interface comment.
} satisfies PlatformAdapter
