import { describe, expect, it } from 'vitest'
import { PLATFORM_CATALOG } from './catalog'
import { ALL_ADAPTERS, adapterForHostname, adapterForUrl } from './registry'
import { instagramAdapter } from './instagram/adapter'
import { threadsAdapter } from './threads/adapter'
import { xAdapter } from './x/adapter'

describe('behavior adapter registry', () => {
  it('has one behavior adapter per catalog descriptor, in catalog order', () => {
    expect(ALL_ADAPTERS).toEqual([xAdapter, instagramAdapter, threadsAdapter])
    for (const [index, adapter] of ALL_ADAPTERS.entries()) {
      const descriptor = PLATFORM_CATALOG[index]!
      expect(adapter.platform).toBe(descriptor.platform)
      expect(adapter.hostMatch).toBe(descriptor.hostMatch)
      expect(adapter.cdnHosts).toBe(descriptor.cdnHosts)
      expect(adapter.matchesUrl).toBe(descriptor.matchesUrl)
    }
  })

  it('finds behavior by page URL', () => {
    expect(adapterForUrl('https://x.com/alice/status/1')).toBe(xAdapter)
    expect(adapterForUrl('https://twitter.com/alice/status/1')).toBe(xAdapter)
    expect(adapterForUrl('https://www.instagram.com/p/CODE1/')).toBe(instagramAdapter)
    expect(adapterForUrl('https://www.threads.net/@alice/post/CODE1')).toBe(threadsAdapter)
    expect(adapterForUrl('https://www.threads.com/@alice/post/CODE1')).toBe(threadsAdapter)
    expect(adapterForUrl('https://example.com/')).toBeUndefined()
  })

  it('finds behavior by exact hostname', () => {
    expect(adapterForHostname('x.com')).toBe(xAdapter)
    expect(adapterForHostname('twitter.com')).toBe(xAdapter)
    expect(adapterForHostname('www.instagram.com')).toBe(instagramAdapter)
    expect(adapterForHostname('www.threads.net')).toBe(threadsAdapter)
    expect(adapterForHostname('www.threads.com')).toBe(threadsAdapter)
    expect(adapterForHostname('example.com')).toBeUndefined()
    expect(adapterForHostname('instagram.com')).toBeUndefined()
  })
})
