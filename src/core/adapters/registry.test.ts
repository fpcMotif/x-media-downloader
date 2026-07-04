import { describe, it, expect } from 'vitest'
import { ALL_ADAPTERS, adapterForUrl, adapterForHostname } from './registry'
import { xAdapter } from './x/adapter'

describe('ALL_ADAPTERS', () => {
  it('registers the x adapter', () => {
    expect(ALL_ADAPTERS).toContain(xAdapter)
  })
})

describe('adapterForUrl', () => {
  it('finds the x adapter for an x.com or twitter.com url', () => {
    expect(adapterForUrl('https://x.com/alice/status/1')).toBe(xAdapter)
    expect(adapterForUrl('https://twitter.com/alice/status/1')).toBe(xAdapter)
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

  it('returns undefined for a hostname on no registered platform', () => {
    expect(adapterForHostname('example.com')).toBeUndefined()
    expect(adapterForHostname('instagram.com')).toBeUndefined()
  })
})
