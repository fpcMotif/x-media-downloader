import type { PlatformAdapter } from '../types'
import {
  X_HOST_MATCH,
  isXUrl,
  detectFromJson,
  detectRenderedImageElements,
  resolveHoverItem,
  canResolveHoverItem,
  videoTweetsNeedingRecovery,
} from './index'
import { isGraphqlMediaUrl } from './tracked-response'
import { mediaKeyFromUrl, isGrabbableMediaPreviewUrl } from './dom'

/** X's Original-quality media CDN hosts — the SSRF allow-list / Fetched-
 *  permission source of truth (docs/adr/0019). Both exact-only: X has never
 *  been observed serving media off a subdomain of either. */
export const X_CDN_HOSTS = [
  { host: 'pbs.twimg.com', includeSubdomains: false },
  { host: 'video.twimg.com', includeSubdomains: false },
] as const

/**
 * X's `PlatformAdapter` — a thin composition over the existing, unchanged
 * X-adapter functions (`index.ts`/`dom.ts`/`walk.ts`/`resolve.ts`/
 * `syndication.ts`). No X-adapter internals moved or changed to build this;
 * it only wraps their existing exported shape to satisfy the interface.
 */
export const xAdapter: PlatformAdapter = {
  platform: 'x',
  hostMatch: X_HOST_MATCH,
  cdnHosts: X_CDN_HOSTS,
  matchesUrl: isXUrl,
  // Combines X's two historically-separate `dom.ts` exports (a raw key
  // extractor + a separate grabbability predicate) into the one self-gated
  // form the interface expects — same two-step gate the overlay's own inline
  // `previewKeyFromMedia` runs today, just relocated here. Neither `dom.ts`
  // function is modified; both remain separately exported/used by
  // `resolveImageElement`/`detectRenderedImageElements`/
  // `videoTweetsNeedingRecovery` in `./index`.
  mediaKeyFromUrl: (url) => (isGrabbableMediaPreviewUrl(url) ? mediaKeyFromUrl(url) : null),
  isTrackedResponseUrl: isGraphqlMediaUrl,
  detectFromResponse: (_url, json) => detectFromJson(json),
  detectRenderedMedia: detectRenderedImageElements,
  resolveHoverItem,
  canResolveHoverItem,
  findMediaNeedingRecovery: videoTweetsNeedingRecovery,
}
