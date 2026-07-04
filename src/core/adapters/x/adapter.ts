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

/**
 * X's `PlatformAdapter` — a thin composition over the existing, unchanged
 * X-adapter functions (`index.ts`/`dom.ts`/`walk.ts`/`resolve.ts`/
 * `syndication.ts`). No X-adapter internals moved or changed to build this;
 * it only wraps their existing exported shape to satisfy the interface.
 */
export const xAdapter: PlatformAdapter = {
  platform: 'x',
  hostMatch: X_HOST_MATCH,
  matchesUrl: isXUrl,
  isTrackedResponseUrl: isGraphqlMediaUrl,
  detectFromResponse: (_url, json) => detectFromJson(json),
  detectRenderedMedia: detectRenderedImageElements,
  resolveHoverItem,
  canResolveHoverItem,
  findMediaNeedingRecovery: videoTweetsNeedingRecovery,
}
