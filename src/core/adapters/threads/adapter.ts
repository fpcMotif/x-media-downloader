import type { PlatformAdapter } from '../types'
import { detectMediaItems } from '../meta-shared/detect'

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
 * Per research, Threads' internal API is a single `/api/graphql` endpoint
 * (served on both hosts) dispatched via a doc_id-keyed persisted query — the
 * same dispatch model as X's own GraphQL tee, just without a human-readable
 * operation name in the URL to filter on the way X's `isGraphqlMediaUrl` does.
 *
 * Filtering on URL containing `/api/graphql` alone is deliberately loose, and
 * that looseness is safe by construction: `detectFromResponse` is entirely
 * shape-driven (it structurally walks the JSON for post-shaped nodes), never
 * URL-driven. A false-positive match here only costs one wasted JSON parse
 * that structurally finds nothing and returns `[]` — it can never cause a
 * media item to be mis-attributed to the wrong post, because the URL plays no
 * role in resolving WHICH post a media node belongs to. Compare X, where a
 * missed/looser URL filter risks parsing the wrong response shape entirely;
 * here the shape-driven walker is itself the correctness backstop.
 */
export function isTrackedThreadsResponseUrl(
  url: string,
  requestHeaders?: Readonly<Record<string, string>>,
): boolean {
  void requestHeaders
  return url.includes('/api/graphql')
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
  // DOM resolution decision: tee-map-only, not a real DOM fallback. Two
  // independent reasons, not just caution:
  // (1) The design spec's own Open Questions section flags Threads' hidden-
  //     <video> hover-anchor mapping as UNVERIFIED, needing live inspection.
  // (2) Unlike X's `pbs.twimg.com`/`video.twimg.com` (host-pinned, verified
  //     over years), meta-shared/detect.ts's own `mediaKeyFromUrl` comment
  //     admits Threads' CDN url shape has never been live-verified either.
  //     A DOM resolver built on an unverified CDN key shape would silently
  //     mismatch or find nothing live — worse than admitting the gap, since
  //     it LOOKS like real functionality. Tee-map-only fails closed instead:
  //     a hover only resolves once the network tee has actually seen the
  //     media, which IS verified (it's the same detectMediaItems pipeline the
  //     photo/video/carousel tests above exercise).
  detectRenderedMedia: () => [],
  resolveHoverItem: (_el, key, detected) => detected.get(key) ?? null,
  canResolveHoverItem: (_el, key, detected) => detected.has(key),
  // findMediaNeedingRecovery intentionally omitted: no public/no-auth
  // recovery fallback exists for Threads (oEmbed is Meta-app-registration-
  // gated), confirmed by the design spec's research — not merely unbuilt.
}
