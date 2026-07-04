import type { PlatformAdapter } from './types'
import { xAdapter } from './x/adapter'

/**
 * Every registered platform adapter. Adding a platform is: implement
 * `PlatformAdapter` in its own folder, add one entry here — nothing in
 * `core/download`, `core/cloud`, `core/sync`, `core/clear`, or the UI panels
 * needs to change (docs/superpowers/specs/2026-07-04-multi-platform-adapter-design.md).
 */
export const ALL_ADAPTERS: readonly PlatformAdapter[] = [xAdapter]

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
