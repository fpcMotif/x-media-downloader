import { describe, it, expect } from 'vitest'
import {
  ALL_ADAPTERS,
  adapterForUrl,
  adapterForHostname,
  originsForAllAdapters,
  allAdapterHostMatch,
} from './registry'
import { xAdapter } from './x/adapter'
import { instagramAdapter } from './instagram/adapter'
import { threadsAdapter } from './threads/adapter'
import { X_HOST_MATCH } from './x'
import { INSTAGRAM_HOST_MATCH } from './instagram/adapter'
import { THREADS_HOST_MATCH } from './threads/adapter'

describe('ALL_ADAPTERS', () => {
  it('registers the x, instagram, and threads adapters', () => {
    expect(ALL_ADAPTERS).toContain(xAdapter)
    expect(ALL_ADAPTERS).toContain(instagramAdapter)
    expect(ALL_ADAPTERS).toContain(threadsAdapter)
    expect(ALL_ADAPTERS).toHaveLength(3)
  })
})

describe('adapterForUrl', () => {
  it('finds the x adapter for an x.com or twitter.com url', () => {
    expect(adapterForUrl('https://x.com/alice/status/1')).toBe(xAdapter)
    expect(adapterForUrl('https://twitter.com/alice/status/1')).toBe(xAdapter)
  })

  it('finds the instagram adapter for an instagram.com url, never the x adapter', () => {
    const adapter = adapterForUrl('https://www.instagram.com/p/CODE1/')
    expect(adapter).toBe(instagramAdapter)
    expect(adapter).not.toBe(xAdapter)
  })

  it('finds the threads adapter for a threads.net or threads.com url, never the x adapter', () => {
    const netAdapter = adapterForUrl('https://www.threads.net/@alice/post/CODE1')
    const comAdapter = adapterForUrl('https://www.threads.com/@alice/post/CODE1')
    expect(netAdapter).toBe(threadsAdapter)
    expect(comAdapter).toBe(threadsAdapter)
    expect(netAdapter).not.toBe(xAdapter)
    expect(comAdapter).not.toBe(xAdapter)
  })

  it('returns undefined for a url on no registered platform', () => {
    expect(adapterForUrl('https://example.com/')).toBeUndefined()
  })
})

describe('adapterForHostname', () => {
  it('finds the x adapter for x.com/twitter.com hostnames', () => {
    expect(adapterForHostname('x.com')).toBe(xAdapter)
    expect(adapterForHostname('twitter.com')).toBe(xAdapter)
  })

  it('finds the instagram adapter for www.instagram.com, never the x adapter', () => {
    const adapter = adapterForHostname('www.instagram.com')
    expect(adapter).toBe(instagramAdapter)
    expect(adapter).not.toBe(xAdapter)
  })

  it('finds the threads adapter for www.threads.net/www.threads.com, never the x adapter', () => {
    const netAdapter = adapterForHostname('www.threads.net')
    const comAdapter = adapterForHostname('www.threads.com')
    expect(netAdapter).toBe(threadsAdapter)
    expect(comAdapter).toBe(threadsAdapter)
    expect(netAdapter).not.toBe(xAdapter)
    expect(comAdapter).not.toBe(xAdapter)
  })

  it('returns undefined for a hostname on no registered platform', () => {
    expect(adapterForHostname('example.com')).toBeUndefined()
    expect(adapterForHostname('instagram.com')).toBeUndefined()
  })
})

describe('originsForAllAdapters', () => {
  it('returns exactly the 5 origins across x, instagram, and threads', () => {
    expect([...originsForAllAdapters()].toSorted()).toEqual(
      [
        'https://x.com',
        'https://twitter.com',
        'https://www.instagram.com',
        'https://www.threads.net',
        'https://www.threads.com',
      ].toSorted(),
    )
  })
})

describe('allAdapterHostMatch', () => {
  it('returns the deduplicated union of every adapter hostMatch', () => {
    expect(allAdapterHostMatch().toSorted()).toEqual(
      [...new Set([...X_HOST_MATCH, ...INSTAGRAM_HOST_MATCH, ...THREADS_HOST_MATCH])].toSorted(),
    )
  })
})
