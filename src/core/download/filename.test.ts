import { describe, it, expect } from 'vitest'
import type { MediaItem } from '../schema'
import { renderFilename } from './filename'

const item: MediaItem = {
  id: 'm1',
  platform: 'x',
  postId: '123',
  author: 'alice',
  type: 'photo',
  url: 'https://pbs.twimg.com/media/AAA.jpg?name=orig',
  ext: 'jpg',
  index: 0,
}

describe('renderFilename', () => {
  it('renders all tokens', () => {
    expect(renderFilename('{handle}/{tweetId}_{index}.{ext}', item)).toBe('alice/123_0.jpg')
  })

  it('renders the generalized {author}/{postId}/{platform} placeholders', () => {
    expect(renderFilename('{platform}/{author}/{postId}_{index}.{ext}', item)).toBe(
      'x/alice/123_0.jpg',
    )
  })

  it('strips path traversal and illegal characters', () => {
    const out = renderFilename('{handle}/{tweetId}.{ext}', {
      ...item,
      author: '../../etc',
      postId: 'a:b*c?',
    })
    expect(out.startsWith('/')).toBe(false)
    expect(out).not.toContain('..')
    expect(out).not.toMatch(/[:*?"<>|]/)
    expect(out).toBe('etc/abc.jpg')
  })

  it('never returns an absolute or empty path', () => {
    expect(renderFilename('/{handle}.{ext}', item)).toBe('alice.jpg')
    expect(renderFilename('{bogus}', item)).toBe('123_0.jpg')
  })

  it('keeps the fallback safe even when the id itself is path-traversal', () => {
    // A template that sanitizes to nothing falls back to the id/index — which must
    // ALSO be sanitized so a degenerate tweetId can never smuggle a `..` back in.
    const out = renderFilename('{bogus}', { ...item, postId: '../../etc' })
    expect(out.startsWith('/')).toBe(false)
    expect(out).not.toContain('..')
    expect(out.length).toBeGreaterThan(0)
  })
})
