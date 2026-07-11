import { describe, expect, it } from 'vitest'
import { contextLabel, isXContext, tabContext, tabScope } from './context'

describe('tabContext', () => {
  it('an X Bookmarks list URL is x-list', () => {
    expect(tabContext('https://x.com/i/bookmarks')).toBe('x-list')
  })

  it('an X Likes list URL is x-list', () => {
    expect(tabContext('https://x.com/someone/likes')).toBe('x-list')
  })

  it('a non-list X URL is x', () => {
    expect(tabContext('https://x.com/home')).toBe('x')
  })

  it('a twitter.com URL is still x (both hosts match)', () => {
    expect(tabContext('https://twitter.com/home')).toBe('x')
  })

  it('an Instagram URL is instagram', () => {
    expect(tabContext('https://www.instagram.com/reels/abc123/')).toBe('instagram')
  })

  it('a Threads URL is threads', () => {
    expect(tabContext('https://www.threads.net/@someone/post/xyz')).toBe('threads')
  })

  it('an unrecognized host is none', () => {
    expect(tabContext('https://example.com/')).toBe('none')
  })

  it('a garbage, unparsable URL is none (never throws)', () => {
    expect(tabContext('not a url')).toBe('none')
  })

  it('an empty string is none', () => {
    expect(tabContext('')).toBe('none')
  })
})

describe('tabScope', () => {
  it('bookmark scope on a Bookmarks list URL', () => {
    expect(tabScope('https://x.com/i/bookmarks')).toBe('bookmark')
  })

  it('like scope on a Likes list URL', () => {
    expect(tabScope('https://x.com/someone/likes')).toBe('like')
  })

  it('undefined off a list page', () => {
    expect(tabScope('https://x.com/home')).toBeUndefined()
  })

  it('undefined off X entirely', () => {
    expect(tabScope('https://www.instagram.com/reels/abc123/')).toBeUndefined()
  })

  it('undefined for a garbage URL', () => {
    expect(tabScope('not a url')).toBeUndefined()
  })
})

describe('isXContext', () => {
  it('true for x-list and x', () => {
    expect(isXContext('x-list')).toBe(true)
    expect(isXContext('x')).toBe(true)
  })

  it('false for instagram, threads, and none', () => {
    expect(isXContext('instagram')).toBe(false)
    expect(isXContext('threads')).toBe(false)
    expect(isXContext('none')).toBe(false)
  })
})

describe('contextLabel (re-exported from action-copy.ts)', () => {
  it('renders the X list labels', () => {
    expect(contextLabel('x-list', 'bookmark')).toBe('X · Bookmarks list')
    expect(contextLabel('x-list', 'like')).toBe('X · Likes list')
  })

  it('renders the ready labels for each platform', () => {
    expect(contextLabel('x')).toBe('X · ready')
    expect(contextLabel('instagram')).toBe('Instagram · ready')
    expect(contextLabel('threads')).toBe('Threads · ready')
  })

  it('renders the unsupported label', () => {
    expect(contextLabel('none')).toBe('Not on X, Instagram, or Threads')
  })
})
