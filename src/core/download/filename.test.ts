import { describe, it, expect } from 'vitest'
import type { MediaItem } from '../schema'
import { renderFilename } from './filename'

const item: MediaItem = {
  id: 'm1',
  tweetId: '123',
  handle: 'alice',
  type: 'photo',
  url: 'https://pbs.twimg.com/media/AAA.jpg?name=orig',
  ext: 'jpg',
  index: 0,
}

describe('renderFilename', () => {
  it('renders all tokens', () => {
    expect(renderFilename('{handle}/{tweetId}_{index}.{ext}', item)).toBe('alice/123_0.jpg')
  })

  it('strips path traversal and illegal characters', () => {
    const out = renderFilename('{handle}/{tweetId}.{ext}', {
      ...item,
      handle: '../../etc',
      tweetId: 'a:b*c?',
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
})
