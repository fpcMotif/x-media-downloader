import { describe, it, expect } from 'vitest'
import type { MediaItem } from './schema'
import {
  emptySelection,
  toggleMedia,
  selectTweet,
  selectThread,
  resolveSelection,
  type Registry,
} from './selection'

const media = (
  id: string,
  tweetId: string,
  index: number,
  handle = 'alice',
  type: MediaItem['type'] = 'photo',
): MediaItem => ({
  id,
  tweetId,
  handle,
  type,
  url: `https://pbs.twimg.com/${id}.jpg`,
  ext: 'jpg',
  index,
})

const registry: Registry = [
  {
    tweetId: 't1',
    threadId: 'th1',
    items: [media('a', 't1', 0), media('b', 't1', 1), media('c', 't1', 2)],
  },
  {
    tweetId: 't2',
    threadId: 'th1',
    items: [media('d', 't2', 0), media('e', 't2', 1)],
  },
  {
    tweetId: 't3',
    items: [media('f', 't3', 0)],
  },
]

describe('selection', () => {
  it('empty selection resolves to nothing', () => {
    expect(emptySelection().ids.size).toBe(0)
    expect(resolveSelection(registry, emptySelection())).toEqual([])
  })

  it('toggleMedia adds then removes an id', () => {
    const added = toggleMedia(emptySelection(), 'a')
    expect(added.ids.has('a')).toBe(true)
    const removed = toggleMedia(added, 'a')
    expect(removed.ids.has('a')).toBe(false)
    expect(removed.ids.size).toBe(0)
  })

  it('toggleMedia is immutable', () => {
    const sel = emptySelection()
    const next = toggleMedia(sel, 'a')
    expect(sel.ids.size).toBe(0)
    expect(next).not.toBe(sel)
    expect(next.ids).not.toBe(sel.ids)
  })

  it('selectTweet selects exactly that tweet item ids', () => {
    const sel = selectTweet(emptySelection(), registry, 't1')
    const resolved = resolveSelection(registry, sel)
    expect(resolved.length).toBe(3)
    expect(resolved.map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })

  it('selectThread selects items across two tweets sharing a threadId', () => {
    const sel = selectThread(emptySelection(), registry, 'th1')
    const resolved = resolveSelection(registry, sel)
    expect(resolved.map((i) => i.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(resolved.some((i) => i.id === 'f')).toBe(false)
  })

  it('reindexes per-tweet contiguously over a partial selection', () => {
    let sel = toggleMedia(emptySelection(), 'a')
    sel = toggleMedia(sel, 'c')
    const resolved = resolveSelection(registry, sel)
    expect(resolved.length).toBe(2)
    expect(resolved.map((i) => i.id)).toEqual(['a', 'c'])
    expect(resolved.map((i) => i.index)).toEqual([0, 1])
    expect(resolved[0]?.url).toBe('https://pbs.twimg.com/a.jpg')
    expect(resolved[1]?.ext).toBe('jpg')
  })

  it('restarts index at 0 for each selected tweet', () => {
    const sel = selectThread(emptySelection(), registry, 'th1')
    const resolved = resolveSelection(registry, sel)
    const t1 = resolved.filter((i) => i.tweetId === 't1')
    const t2 = resolved.filter((i) => i.tweetId === 't2')
    expect(t1.map((i) => i.index)).toEqual([0, 1, 2])
    expect(t2.map((i) => i.index)).toEqual([0, 1])
  })

  it('ignores a selected id absent from the registry', () => {
    const sel = toggleMedia(toggleMedia(emptySelection(), 'a'), 'ghost')
    const resolved = resolveSelection(registry, sel)
    expect(resolved.map((i) => i.id)).toEqual(['a'])
  })

  it('selectThread with a nullish threadId selects nothing', () => {
    // A caller threading through an optional `group.threadId` could pass undefined;
    // it must not union every thread-less tweet.
    const sel = selectThread(emptySelection(), registry, undefined as unknown as string)
    expect(sel.ids.size).toBe(0)
    expect(resolveSelection(registry, sel)).toEqual([])
  })

  it('resolves a media id shared across tweets only once', () => {
    const dupRegistry: Registry = [
      { tweetId: 't1', items: [media('dup', 't1', 0)] },
      { tweetId: 't2', items: [media('dup', 't2', 0)] },
    ]
    const sel = toggleMedia(emptySelection(), 'dup')
    const resolved = resolveSelection(dupRegistry, sel)
    expect(resolved.length).toBe(1)
    expect(resolved[0]?.tweetId).toBe('t1')
  })

  it('does not mutate registry items on resolve', () => {
    const sel = toggleMedia(emptySelection(), 'c')
    resolveSelection(registry, sel)
    expect(registry[0]?.items[2]?.index).toBe(2)
  })
})
