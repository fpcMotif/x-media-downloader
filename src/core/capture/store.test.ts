import { describe, it, expect } from 'vitest'
import type { Source, TweetRecord } from './record'
import { sourceRank } from './record'
import {
  decodeRecords,
  mergeRecord,
  recentConversations,
  selectConversation,
  summarize,
} from './store'

const make = (over: {
  tweetId: string
  conversationId?: string
  handle?: string
  text?: string
  source: Source
  capturedAt: number
}): TweetRecord => ({
  tweetId: over.tweetId,
  conversationId: over.conversationId ?? over.tweetId,
  author: { handle: over.handle ?? 'alice' },
  text: over.text ?? `text-${over.tweetId}`,
  rawText: over.text ?? `text-${over.tweetId}`,
  links: [],
  media: [],
  mentions: [],
  hashtags: [],
  source: over.source,
  sourceRank: sourceRank(over.source),
  capturedAt: over.capturedAt,
})

describe('mergeRecord (§6.4 richer-source-wins, non-monotonic-safe)', () => {
  it('keeps the rich TweetDetail when a later thin timeline sighting arrives', () => {
    const rich = make({ tweetId: '1', source: 'tweetDetail', capturedAt: 100 })
    const thin = make({ tweetId: '1', source: 'timeline', capturedAt: 999 })
    expect(mergeRecord(rich, thin)).toBe(rich)
  })

  it('upgrades a thin sighting when a rich TweetDetail arrives', () => {
    const thin = make({ tweetId: '1', source: 'timeline', capturedAt: 100 })
    const rich = make({ tweetId: '1', source: 'tweetDetail', capturedAt: 50 })
    expect(mergeRecord(thin, rich)).toBe(rich)
  })

  it('keeps the newer capturedAt on equal rank', () => {
    const older = make({ tweetId: '1', source: 'timeline', capturedAt: 100 })
    const newer = make({ tweetId: '1', source: 'timeline', capturedAt: 200 })
    expect(mergeRecord(older, newer)).toBe(newer)
    expect(mergeRecord(newer, older)).toBe(newer)
  })

  it('keeps incoming on equal rank and equal capturedAt (>= tie-break)', () => {
    const existing = make({ tweetId: '1', source: 'timeline', capturedAt: 100 })
    const incoming = make({ tweetId: '1', source: 'timeline', capturedAt: 100 })
    expect(mergeRecord(existing, incoming)).toBe(incoming)
  })

  it('keeps incoming when there is no existing record', () => {
    const incoming = make({ tweetId: '1', source: 'timeline', capturedAt: 100 })
    expect(mergeRecord(undefined, incoming)).toBe(incoming)
  })
})

describe('decodeRecords', () => {
  it('decodes a well-formed array of records', () => {
    const records = [make({ tweetId: '1', source: 'timeline', capturedAt: 1 })]
    expect(decodeRecords(records)).toEqual(records)
  })

  it('returns [] on corrupt input', () => {
    expect(decodeRecords({ not: 'an array' })).toEqual([])
    expect(decodeRecords([{ tweetId: 1 }])).toEqual([])
    expect(decodeRecords(null)).toEqual([])
  })
})

describe('selectConversation', () => {
  it('filters to one conversation', () => {
    const a = make({ tweetId: '1', conversationId: 'c1', source: 'tweetDetail', capturedAt: 1 })
    const b = make({ tweetId: '2', conversationId: 'c1', source: 'timeline', capturedAt: 2 })
    const c = make({ tweetId: '3', conversationId: 'c2', source: 'timeline', capturedAt: 3 })
    expect(selectConversation([a, b, c], 'c1')).toEqual([a, b])
  })
})

describe('summarize', () => {
  it('returns distinct tweet and conversation counts', () => {
    const records = [
      make({ tweetId: '1', conversationId: 'c1', source: 'tweetDetail', capturedAt: 1 }),
      make({ tweetId: '2', conversationId: 'c1', source: 'timeline', capturedAt: 2 }),
      make({ tweetId: '3', conversationId: 'c2', source: 'timeline', capturedAt: 3 }),
    ]
    expect(summarize(records)).toEqual({ tweets: 3, conversations: 2 })
  })
})

describe('recentConversations', () => {
  it('returns the n newest threads with root handle/text, count and lastAt', () => {
    const c1root = make({
      tweetId: '1',
      conversationId: 'c1',
      handle: 'alice',
      text: 'root one',
      source: 'tweetDetail',
      capturedAt: 10,
    })
    const c1reply = make({ tweetId: '2', conversationId: 'c1', source: 'timeline', capturedAt: 40 })
    const c2root = make({
      tweetId: '3',
      conversationId: 'c2',
      handle: 'bob',
      text: 'root two',
      source: 'tweetDetail',
      capturedAt: 20,
    })
    const c3root = make({
      tweetId: '4',
      conversationId: 'c3',
      handle: 'carol',
      text: 'root three',
      source: 'tweetDetail',
      capturedAt: 5,
    })

    const recent = recentConversations([c1root, c1reply, c2root, c3root], 2)

    expect(recent).toEqual([
      { conversationId: 'c1', rootHandle: 'alice', rootText: 'root one', count: 2, lastAt: 40 },
      { conversationId: 'c2', rootHandle: 'bob', rootText: 'root two', count: 1, lastAt: 20 },
    ])
  })

  it('falls back to any member for handle/text when the root tweet is absent', () => {
    const reply = make({
      tweetId: '2',
      conversationId: 'c1',
      handle: 'dave',
      text: 'a reply',
      source: 'timeline',
      capturedAt: 7,
    })
    const recent = recentConversations([reply], 5)
    expect(recent).toEqual([
      { conversationId: 'c1', rootHandle: 'dave', rootText: 'a reply', count: 1, lastAt: 7 },
    ])
  })

  it('lets a root tweet seen after a reply overwrite the fallback handle/text', () => {
    const reply = make({
      tweetId: '2',
      conversationId: 'c1',
      handle: 'dave',
      text: 'a reply',
      source: 'timeline',
      capturedAt: 7,
    })
    const root = make({
      tweetId: 'c1',
      conversationId: 'c1',
      handle: 'erin',
      text: 'the root',
      source: 'tweetDetail',
      capturedAt: 3,
    })
    const recent = recentConversations([reply, root], 5)
    expect(recent).toEqual([
      { conversationId: 'c1', rootHandle: 'erin', rootText: 'the root', count: 2, lastAt: 7 },
    ])
  })
})
