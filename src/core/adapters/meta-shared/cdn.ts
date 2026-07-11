import type { CdnHost } from '../types'

/**
 * The CDN host(s) Instagram and Threads share for Original-quality media
 * bytes — both platforms serve off the same Meta CDN family (confirmed live
 * 2026-07-05, Chrome Canary, logged-in Instagram + Threads; see `dom.ts`'s
 * own `isCdninstagramHost` doc). Single source of truth for BOTH adapters'
 * `PlatformAdapter.cdnHosts` — see that field's doc for what consumes it
 * (Cloud Upload's SSRF guard in `core/sync/url-guard.ts`, and the Fetched
 * strategy's optional-permission request in `core/download/fetched-strategy.ts`).
 */
export const META_CDN_HOSTS: readonly CdnHost[] = [
  { host: 'cdninstagram.com', includeSubdomains: true },
]
