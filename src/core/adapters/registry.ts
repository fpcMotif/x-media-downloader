import type { Platform } from '../schema'
import { PLATFORM_CATALOG, descriptorForHostname, descriptorForUrl } from './catalog'
import type { PlatformAdapter } from './types'
import { xAdapter } from './x/adapter'
import { instagramAdapter } from './instagram/adapter'
import { threadsAdapter } from './threads/adapter'

/**
 * DOM/response behavior keyed by the data-only catalog's exhaustive Platform
 * union. Non-content contexts must import `catalog.ts`, never this module.
 */
const ADAPTER_BY_PLATFORM = {
  x: xAdapter,
  instagram: instagramAdapter,
  threads: threadsAdapter,
} satisfies Record<Platform, PlatformAdapter>

/** Every behavior adapter, in catalog order. */
export const ALL_ADAPTERS: readonly PlatformAdapter[] = PLATFORM_CATALOG.map(
  (descriptor) => ADAPTER_BY_PLATFORM[descriptor.platform],
)

/**
 * The adapter for a tab URL, for callers that span multiple tabs/platforms
 * at once (`background.ts`, a single service worker). `undefined` for a tab
 * that isn't on any registered platform — the common case, since most open
 * tabs aren't X/Instagram/Threads at all.
 */
export function adapterForUrl(url: string): PlatformAdapter | undefined {
  const descriptor = descriptorForUrl(url)
  return descriptor ? ADAPTER_BY_PLATFORM[descriptor.platform] : undefined
}

/**
 * The adapter for a hostname, for callers that live on exactly one platform
 * for their whole lifetime (a content script, which never survives a
 * navigation to a different origin). Pick this ONCE at boot and close over
 * it — no per-call dispatch on hot paths like hover/mousemove.
 */
export function adapterForHostname(hostname: string): PlatformAdapter | undefined {
  const descriptor = descriptorForHostname(hostname)
  return descriptor ? ADAPTER_BY_PLATFORM[descriptor.platform] : undefined
}
