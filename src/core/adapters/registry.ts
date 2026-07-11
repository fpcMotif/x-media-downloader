import type { CdnHost, PlatformAdapter } from './types'
import { xAdapter } from './x/adapter'
import { instagramAdapter } from './instagram/adapter'
import { threadsAdapter } from './threads/adapter'

/**
 * Every registered platform adapter. Adding a platform is: implement
 * `PlatformAdapter` in its own folder, add one entry here — nothing in
 * `core/download`, `core/cloud`, `core/sync`, `core/clear`, or the UI panels
 * needs to change (docs/superpowers/specs/2026-07-04-multi-platform-adapter-design.md).
 */
export const ALL_ADAPTERS: readonly PlatformAdapter[] = [xAdapter, instagramAdapter, threadsAdapter]

/**
 * The adapter for a tab URL, for callers that span multiple tabs/platforms
 * at once (`background.ts`, a single service worker). `undefined` for a tab
 * that isn't on any registered platform — the common case, since most open
 * tabs aren't X/Instagram/Threads at all.
 */
export function adapterForUrl(url: string): PlatformAdapter | undefined {
  return ALL_ADAPTERS.find((a) => a.matchesUrl(url))
}

/**
 * The adapter for a hostname, for callers that live on exactly one platform
 * for their whole lifetime (a content script, which never survives a
 * navigation to a different origin). Pick this ONCE at boot and close over
 * it — no per-call dispatch on hot paths like hover/mousemove.
 */
export function adapterForHostname(hostname: string): PlatformAdapter | undefined {
  return ALL_ADAPTERS.find((a) =>
    a.hostMatch.some((pattern) => hostMatchesHostname(pattern, hostname)),
  )
}

/** Whether a `*://host/*`-style match pattern's host segment equals `hostname`.
 *  Every `hostMatch` in this codebase (X, and Instagram/Threads per the
 *  multi-platform design) is an exact host — no `*.`-wildcard subdomain
 *  patterns exist to dispatch on, so this stays exact-match only (YAGNI). */
function hostMatchesHostname(pattern: string, hostname: string): boolean {
  // Every real `hostMatch` entry is `scheme://host/*` by construction (an
  // internally-authored constant, never external input), so both `??`
  // fallbacks below are unreachable defensive code, not a live branch.
  /* v8 ignore next -- `pattern` always contains `://`, so `?? pattern` is unreachable */
  const afterScheme = pattern.split('://')[1] ?? pattern
  /* v8 ignore next -- `afterScheme` always contains `/`, so `?? afterScheme` is unreachable */
  const host = afterScheme.split('/')[0] ?? afterScheme
  return hostname === host
}

/** Every distinct origin (`scheme://host`) a registered adapter's content
 *  script may legitimately send a message from — the single source
 *  sender-guard's ALLOWED_CONTENT_SCRIPT_ORIGINS derives from. */
export function originsForAllAdapters(): ReadonlySet<string> {
  const origins = new Set<string>()
  for (const adapter of ALL_ADAPTERS) {
    for (const pattern of adapter.hostMatch) {
      // mirrors hostMatchesHostname's own '://' + '/' split (registry.ts:40-49);
      // both `??` fallbacks are unreachable defensive code for the same reason
      // (every real `hostMatch` entry is `scheme://host/*` by construction).
      /* v8 ignore next -- `pattern` always contains '://', so `?? pattern` is unreachable */
      const afterScheme = pattern.split('://')[1] ?? pattern
      /* v8 ignore next -- `afterScheme` always contains '/', so `?? afterScheme` is unreachable */
      const host = afterScheme.split('/')[0] ?? afterScheme
      origins.add(`https://${host}`)
    }
  }
  return origins
}

/** Every registered adapter's hostMatch, deduplicated — the manifest
 *  host_permissions and browser.tabs.query source of truth. */
export function allAdapterHostMatch(): readonly string[] {
  return [...new Set(ALL_ADAPTERS.flatMap((a) => a.hostMatch))]
}

/** Every registered adapter's `cdnHosts`, flattened and deduplicated by
 *  `host`+`includeSubdomains` (Instagram and Threads both list the same
 *  Meta CDN entry — this collapses it to one) — the single source of truth
 *  the SSRF allow-list (`core/sync/url-guard.ts`) and the Fetched-strategy
 *  optional-permission request (`core/download/fetched-strategy.ts`) both
 *  derive from. */
export function cdnHostsForAllAdapters(): readonly CdnHost[] {
  const seen = new Set<string>()
  const out: CdnHost[] = []
  for (const adapter of ALL_ADAPTERS) {
    for (const entry of adapter.cdnHosts) {
      const key = `${entry.host}|${entry.includeSubdomains}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(entry)
    }
  }
  return out
}

/** {@link cdnHostsForAllAdapters}, each entry mapped to a Chrome match
 *  pattern: an exact host becomes `https://<host>/*`; `includeSubdomains`
 *  becomes `https://*.<host>/*` — note a `*.host` match pattern ALSO matches
 *  the bare host, so no separate exact-host entry is needed alongside it. */
export function cdnMatchPatternsForAllAdapters(): readonly string[] {
  return cdnHostsForAllAdapters().map((entry) =>
    entry.includeSubdomains ? `https://*.${entry.host}/*` : `https://${entry.host}/*`,
  )
}
