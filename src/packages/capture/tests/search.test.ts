import { describe, expect, it } from 'vitest'
import { sourceRank, type Source, type TweetRecord } from '../record'
import {
  captureSearchRowIds,
  finishCaptureSearch,
  foldCaptureSearch,
  pickCaptureMatches,
  startCaptureSearch,
} from '../search'

const make = (over: {
  tweetId: string
  conversationId?: string
  handle?: string
  text?: string
  source?: Source
  capturedAt?: number
}): TweetRecord => {
  const source = over.source ?? 'timeline'
  return {
    tweetId: over.tweetId,
    conversationId: over.conversationId ?? over.tweetId,
    author: { handle: over.handle ?? 'alice' },
    text: over.text ?? `text-${over.tweetId}`,
    rawText: over.text ?? `text-${over.tweetId}`,
    links: [],
    media: [],
    mentions: [],
    hashtags: [],
    source,
    sourceRank: sourceRank(source),
    capturedAt: over.capturedAt ?? 100,
  }
}

function runWorkerSearch(records: ReadonlyArray<TweetRecord>, query: string, limit = 200) {
  const acc = records.reduce(foldCaptureSearch, startCaptureSearch(query))
  const { total, picked } = pickCaptureMatches(acc, limit)
  const wantedIds = new Set(captureSearchRowIds(picked))
  const rows = records.filter((r) => wantedIds.has(r.tweetId))
  return { total, picked, matches: finishCaptureSearch(picked, rows) }
}

describe('capture archive search', () => {
  it('startCaptureSearch trims and lowercases the needle', () => {
    expect(startCaptureSearch('  FoO ').needle).toBe('foo')
  })

  it('matches a conversation by a reply text and shows the root tweet', () => {
    const root = make({
      tweetId: '1',
      conversationId: '1',
      handle: 'alice',
      text: 'thread',
      capturedAt: 100,
    })
    const reply = make({
      tweetId: '2',
      conversationId: '1',
      handle: 'bob',
      text: 'Rust borrow checker',
      capturedAt: 250,
    })

    const result = runWorkerSearch([root, reply], 'borrow')

    expect(result.total).toBe(1)
    expect(result.matches).toEqual([
      {
        conversationId: '1',
        rootHandle: 'alice',
        rootText: 'thread',
        count: 2,
        lastAt: 250,
      },
    ])
  })

  it('matches a conversation by a reply author handle', () => {
    const root = make({
      tweetId: '1',
      conversationId: '1',
      handle: 'alice',
      text: 'opening post',
      capturedAt: 10,
    })
    const reply = make({
      tweetId: '2',
      conversationId: '1',
      handle: 'bob',
      text: 'plain reply',
      capturedAt: 20,
    })

    const result = runWorkerSearch([root, reply], '@bob')

    expect(result.total).toBe(1)
    expect(result.matches.map((m) => m.conversationId)).toEqual(['1'])
  })

  it('matches case-insensitively', () => {
    const root = make({
      tweetId: '1',
      conversationId: '1',
      handle: 'alice',
      text: 'writing rust today',
      capturedAt: 10,
    })
    const reply = make({
      tweetId: '2',
      conversationId: '1',
      handle: 'carol',
      text: 'nice post',
      capturedAt: 30,
    })

    const result = runWorkerSearch([root, reply], 'RUST')

    expect(result.total).toBe(1)
    expect(result.matches[0]?.conversationId).toBe('1')
  })

  it('excludes conversations with no matching record and counts only matches in total', () => {
    const matching = make({
      tweetId: '1',
      conversationId: '1',
      handle: 'alice',
      text: 'rust compiler',
      capturedAt: 10,
    })
    const nonMatchingRoot = make({
      tweetId: '2',
      conversationId: '2',
      handle: 'bob',
      text: 'cooking pasta',
      capturedAt: 20,
    })
    const nonMatchingReply = make({
      tweetId: '3',
      conversationId: '2',
      handle: 'carol',
      text: 'add basil',
      capturedAt: 30,
    })

    const result = runWorkerSearch([matching, nonMatchingRoot, nonMatchingReply], 'rust')

    expect(result.total).toBe(1)
    expect(result.matches.map((m) => m.conversationId)).toEqual(['1'])
  })

  it('falls back to the first member when the root tweet is not stored', () => {
    const reply = make({
      tweetId: '2',
      conversationId: '1',
      handle: 'bob',
      text: 'orphan reply about rust',
      capturedAt: 50,
    })

    const result = runWorkerSearch([reply], 'rust')

    expect(result.matches).toEqual([
      {
        conversationId: '1',
        rootHandle: 'bob',
        rootText: 'orphan reply about rust',
        count: 1,
        lastAt: 50,
      },
    ])
  })

  it('orders matches newest first and caps picked entries at limit while keeping total', () => {
    const c1 = make({ tweetId: '1', text: 'rust one', capturedAt: 10 })
    const c2 = make({ tweetId: '2', text: 'rust two', capturedAt: 30 })
    const c3 = make({ tweetId: '3', text: 'rust three', capturedAt: 20 })

    const result = runWorkerSearch([c1, c2, c3], 'rust', 2)

    expect(result.total).toBe(3)
    expect(result.picked.map((e) => e.conversationId)).toEqual(['2', '3'])
    expect(result.matches.map((m) => m.conversationId)).toEqual(['2', '3'])
  })

  it('drops picked entries whose records are gone and deduplicates row ids when root is fallback', () => {
    const rootOnly = make({ tweetId: '1', conversationId: '1', text: 'rust root', capturedAt: 10 })
    const acc = foldCaptureSearch(startCaptureSearch('rust'), rootOnly)
    const { picked } = pickCaptureMatches(acc, 10)

    expect(captureSearchRowIds(picked)).toEqual(['1'])
    expect(finishCaptureSearch(picked, [])).toEqual([])
  })
})
