import type { Platform } from '../schema'

/** One CDN host that may serve Original-quality media bytes. */
export interface CdnHost {
  readonly host: string
  readonly includeSubdomains: boolean
}

/**
 * Data-only platform identity. Safe in WXT config, worker, offscreen, and UI
 * contexts: this interface and its catalog contain no response or DOM logic.
 */
export interface PlatformDescriptor {
  readonly platform: Platform
  readonly hostMatch: readonly string[]
  readonly cdnHosts: readonly CdnHost[]
  readonly matchesUrl: (url: string) => boolean
}

const X_PAGE_HOSTS = ['x.com', 'twitter.com'] as const
export const X_HOST_MATCH = pageMatchPatterns(X_PAGE_HOSTS)
export const X_CDN_HOSTS = [
  { host: 'pbs.twimg.com', includeSubdomains: false },
  { host: 'video.twimg.com', includeSubdomains: false },
] as const

/** Whether a URL is an x.com or twitter.com page. */
export const isXUrl = (url: string): boolean => isHttpsPageUrl(url, X_PAGE_HOSTS)

export const X_DESCRIPTOR = {
  platform: 'x',
  hostMatch: X_HOST_MATCH,
  cdnHosts: X_CDN_HOSTS,
  matchesUrl: isXUrl,
} as const satisfies PlatformDescriptor

export const META_CDN_HOSTS: readonly CdnHost[] = [
  { host: 'cdninstagram.com', includeSubdomains: true },
]

const INSTAGRAM_PAGE_HOSTS = ['www.instagram.com'] as const
export const INSTAGRAM_HOST_MATCH = pageMatchPatterns(INSTAGRAM_PAGE_HOSTS)

/** Whether a URL is a www.instagram.com page. */
export const isInstagramUrl = (url: string): boolean => isHttpsPageUrl(url, INSTAGRAM_PAGE_HOSTS)

export const INSTAGRAM_DESCRIPTOR = {
  platform: 'instagram',
  hostMatch: INSTAGRAM_HOST_MATCH,
  cdnHosts: META_CDN_HOSTS,
  matchesUrl: isInstagramUrl,
} as const satisfies PlatformDescriptor

const THREADS_PAGE_HOSTS = ['www.threads.net', 'www.threads.com'] as const
export const THREADS_HOST_MATCH = pageMatchPatterns(THREADS_PAGE_HOSTS)

/** Whether a URL is a www.threads.net or www.threads.com page. */
export const isThreadsUrl = (url: string): boolean => isHttpsPageUrl(url, THREADS_PAGE_HOSTS)

export const THREADS_DESCRIPTOR = {
  platform: 'threads',
  hostMatch: THREADS_HOST_MATCH,
  cdnHosts: META_CDN_HOSTS,
  matchesUrl: isThreadsUrl,
} as const satisfies PlatformDescriptor

/** The sole platform identity catalog. Registration order is stable. */
export const PLATFORM_CATALOG = [
  X_DESCRIPTOR,
  INSTAGRAM_DESCRIPTOR,
  THREADS_DESCRIPTOR,
] as const satisfies readonly PlatformDescriptor[]

export function descriptorForUrl(url: string): PlatformDescriptor | undefined {
  return PLATFORM_CATALOG.find((descriptor) => descriptor.matchesUrl(url))
}

export function platformForUrl(url: string): Platform | undefined {
  return descriptorForUrl(url)?.platform
}

export function descriptorForHostname(hostname: string): PlatformDescriptor | undefined {
  return PLATFORM_CATALOG.find((descriptor) =>
    descriptor.hostMatch.some((pattern) => hostMatchesHostname(pattern, hostname)),
  )
}

/** Every distinct trusted content-script origin. */
export function originsForAllPlatforms(): ReadonlySet<string> {
  return new Set(
    PLATFORM_CATALOG.flatMap((descriptor) =>
      descriptor.hostMatch.map((pattern) => pattern.slice(0, pattern.indexOf('/', 8))),
    ),
  )
}

/** Every platform page match pattern, deduplicated. */
export function allPlatformHostMatch(): readonly string[] {
  return [...new Set(PLATFORM_CATALOG.flatMap((descriptor) => descriptor.hostMatch))]
}

/** Every platform CDN rule, deduplicated in catalog order. */
export function cdnHostsForAllPlatforms(): readonly CdnHost[] {
  const seen = new Set<string>()
  const hosts: CdnHost[] = []
  for (const descriptor of PLATFORM_CATALOG) {
    for (const entry of descriptor.cdnHosts) {
      const key = `${entry.host}|${entry.includeSubdomains}`
      if (seen.has(key)) continue
      seen.add(key)
      hosts.push(entry)
    }
  }
  return hosts
}

/** Whether a hostname matches one platform's registered CDN rules. */
export function isCdnHostnameForPlatform(platform: Platform, hostname: string): boolean {
  const descriptor = PLATFORM_CATALOG.find((candidate) => candidate.platform === platform)
  return descriptor?.cdnHosts.some((entry) => cdnHostMatches(entry, hostname)) ?? false
}

/** Whether a hostname matches any registered platform CDN rule. */
export function isCdnHostnameForAnyPlatform(hostname: string): boolean {
  return PLATFORM_CATALOG.some((descriptor) =>
    descriptor.cdnHosts.some((entry) => cdnHostMatches(entry, hostname)),
  )
}

/** Every platform CDN rule as a Chrome match pattern. */
export function cdnMatchPatternsForAllPlatforms(): readonly string[] {
  return cdnHostsForAllPlatforms().map((entry) =>
    entry.includeSubdomains ? `https://*.${entry.host}/*` : `https://${entry.host}/*`,
  )
}

function pageMatchPatterns(hostnames: readonly string[]): readonly string[] {
  return hostnames.map((hostname) => `https://${hostname}/*`)
}

function isHttpsPageUrl(url: string, hostnames: readonly string[]): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && hostnames.includes(parsed.hostname)
  } catch {
    return false
  }
}

function cdnHostMatches(entry: CdnHost, hostname: string): boolean {
  return hostname === entry.host || (entry.includeSubdomains && hostname.endsWith(`.${entry.host}`))
}

function hostMatchesHostname(pattern: string, hostname: string): boolean {
  return hostname === hostFromMatchPattern(pattern)
}

function hostFromMatchPattern(pattern: string): string {
  // Catalog patterns are authored as `scheme://host/*`, never external input.
  return pattern.split('://')[1]!.split('/')[0]!
}
