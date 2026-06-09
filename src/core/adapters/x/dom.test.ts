import { describe, it, expect } from 'vitest'
import type { MediaItem } from '../../schema'
import { mediaKeyFromUrl, groupByTweet } from './dom'

const media = (id: string, tweetId: string, index: number, url: string): MediaItem => ({
  id,
  tweetId,
  handle: 'alice',
  type: 'photo',
  url,
  ext: 'jpg',
  index,
})

describe('mediaKeyFromUrl', () => {
  it('extracts the basename key from a pbs photo url (ignoring query + size)', () => {
    expect(mediaKeyFromUrl('https://pbs.twimg.com/media/AAA?format=jpg&name=small')).toBe('AAA')
    expect(mediaKeyFromUrl('https://pbs.twimg.com/media/AAA.jpg?name=orig')).toBe('AAA')
  })

  it('matches a DOM src against a resolved MediaItem url by key', () => {
    const domSrc = 'https://pbs.twimg.com/media/Z9?format=jpg&name=900x900'
    const resolved = 'https://pbs.twimg.com/media/Z9.jpg?name=orig'
    expect(mediaKeyFromUrl(domSrc)).toBe(mediaKeyFromUrl(resolved))
  })

  it('returns null for non-twimg or unparseable urls', () => {
    expect(mediaKeyFromUrl('https://example.com/media/AAA.jpg')).toBe(null)
    expect(mediaKeyFromUrl('not a url')).toBe(null)
    expect(mediaKeyFromUrl('https://pbs.twimg.com/')).toBe(null)
  })
})

describe('groupByTweet', () => {
  it('groups items by tweet preserving order and de-duping by id', () => {
    const items = [
      media('a', 't1', 0, 'https://pbs.twimg.com/media/a.jpg'),
      media('b', 't1', 1, 'https://pbs.twimg.com/media/b.jpg'),
      media('a', 't1', 0, 'https://pbs.twimg.com/media/a.jpg'), // dup
      media('c', 't2', 0, 'https://pbs.twimg.com/media/c.jpg'),
    ]
    const registry = groupByTweet(items)
    expect(registry.map((g) => g.tweetId)).toEqual(['t1', 't2'])
    expect(registry[0]!.items.map((i) => i.id)).toEqual(['a', 'b'])
    expect(registry[1]!.items.map((i) => i.id)).toEqual(['c'])
  })

  it('returns an empty registry for no items', () => {
    expect(groupByTweet([])).toEqual([])
  })
})
