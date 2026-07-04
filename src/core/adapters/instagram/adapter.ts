import { detectMediaItems } from '../meta-shared/detect'
import type { PlatformAdapter } from '../types'

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
  // DOM path deferred to tee-map-only, not the article+/p//reel/ DOM fallback.
  // The capability table's DOM anchor row is reasonably stable for POST
  // IDENTITY, but the design spec's Open Questions flag the video hover/poster
  // idiom and whether `currentSrc` populates without a network capture as
  // UNVERIFIED. X's DOM fallback is deep because it ALSO independently
  // verified a fetchable, quality-upgradable CDN url scheme
  // (`pbs.twimg.com/media/...`) — no such scheme is verified here. A guessed
  // selector risks a badge that resolves to nothing, or the wrong image, on
  // click — worse than no fallback. Tee-first already wins over DOM when both
  // are available (mirrors X's own layering); revisit once live-verified.
  detectRenderedMedia: () => [],
  resolveHoverItem: (_element, key, detected) => detected.get(key) ?? null,
  canResolveHoverItem: (_element, key, detected) => detected.has(key),
  // No findMediaNeedingRecovery: Instagram has no public/no-auth fallback
  // (oEmbed is Meta-app-registration-gated) — confirmed by research, per the
  // design spec's PlatformAdapter interface comment.
} satisfies PlatformAdapter
