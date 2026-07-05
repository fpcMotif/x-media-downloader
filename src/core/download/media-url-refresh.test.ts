import { describe, it, expect } from 'vitest'
import { findFreshMediaItem, mergeRetryUrl, refreshMediaUrlFromTabs } from './media-url-refresh'
import type { MediaItem } from '../schema'

const photo = (id: string, postId: string, index: number, url: string): MediaItem => ({
  id,
  platform: 'x',
  postId,
  author: 'alice',
  type: 'photo',
  url,
  ext: 'jpg',
  index,
})

describe('findFreshMediaItem', () => {
  const stale = photo('m1', '100', 0, 'https://pbs.twimg.com/media/AAA.jpg?name=orig')

  it('matches by media id first', () => {
    const fresh = photo('m1', '100', 0, 'https://pbs.twimg.com/media/AAA.jpg?name=orig&token=new')
    expect(findFreshMediaItem(stale, [fresh])).toEqual(fresh)
  })

  it('falls back to postId + index + type when id differs', () => {
    const fresh = photo('m1-v2', '100', 0, 'https://pbs.twimg.com/media/BBB.jpg?name=orig')
    expect(findFreshMediaItem(stale, [fresh])).toEqual(fresh)
  })

  it('returns undefined when multiple tweet/index/type matches exist', () => {
    const a = photo('a', '100', 0, 'https://pbs.twimg.com/media/A.jpg?name=orig')
    const b = photo('b', '100', 0, 'https://pbs.twimg.com/media/B.jpg?name=orig')
    expect(findFreshMediaItem(stale, [a, b])).toBeUndefined()
  })
})

describe('mergeRetryUrl', () => {
  it('uses the fresh url when a candidate is found', () => {
    const fresh = photo('m1', '1', 0, 'https://pbs.twimg.com/media/new.jpg?name=orig')
    expect(mergeRetryUrl('https://pbs.twimg.com/media/old.jpg?name=orig', fresh)).toBe(fresh.url)
  })

  it('keeps the stored url when refresh misses', () => {
    const stored = 'https://pbs.twimg.com/media/old.jpg?name=orig'
    expect(mergeRetryUrl(stored, undefined)).toBe(stored)
  })
})

describe('refreshMediaUrlFromTabs', () => {
  const item = photo('m1', '100', 0, 'https://pbs.twimg.com/media/old.jpg?name=orig')

  it('returns the first tab response with a url', async () => {
    const calls: number[] = []
    const url = await refreshMediaUrlFromTabs(item, {
      queryTabs: async () => [{ id: 1 }, { id: 2 }],
      sendTabMessage: async (tabId) => {
        calls.push(tabId)
        return tabId === 2 ? { url: 'https://pbs.twimg.com/media/fresh.jpg?name=orig' } : {}
      },
    })
    expect(url).toBe('https://pbs.twimg.com/media/fresh.jpg?name=orig')
    expect(calls).toEqual([1, 2])
  })

  it('returns null when no tab responds with a url', async () => {
    const url = await refreshMediaUrlFromTabs(item, {
      queryTabs: async () => [{ id: 1 }],
      sendTabMessage: async () => ({}),
    })
    expect(url).toBeNull()
  })

  it('skips tabs that throw (no content script)', async () => {
    const url = await refreshMediaUrlFromTabs(item, {
      queryTabs: async () => [{ id: 1 }, { id: 2 }],
      sendTabMessage: async (tabId) => {
        if (tabId === 1) throw new Error('no receiver')
        return { url: 'https://pbs.twimg.com/media/fresh.jpg?name=orig' }
      },
    })
    expect(url).toBe('https://pbs.twimg.com/media/fresh.jpg?name=orig')
  })
})
