import { describe, it, expect } from 'vitest'
import type { Source, TweetRecord } from '../record'
import { sourceRank } from '../record'
import {
  emptyCaptureSummary,
  finishCaptureSummary,
  foldCaptureSummary,
  mergeRecord,
  selectConversation,
} from '../store'

// Materialized reference implementations, kept here as the differential oracle
// for the streaming fold (fold/finish) below. Production only calls the
// streaming path (background.ts), so shipped src/core no longer carries these;
// they live in the test that uses them to pin the fold's output.
type RecentConversation = {
  conversationId: string
  rootHandle: string
  rootText: string
  count: number
  lastAt: number
}

function summarize(records: ReadonlyArray<TweetRecord>): {
  tweets: number
  conversations: number
} {
  const tweets = new Set<string>()
  const conversations = new Set<string>()
  for (const r of records) {
    tweets.add(r.tweetId)
    conversations.add(r.conversationId)
  }
  return { tweets: tweets.size, conversations: conversations.size }
}

function foldConversation(byConversation: Map<string, RecentConversation>, r: TweetRecord): void {
  const existing = byConversation.get(r.conversationId)
  const isRoot = r.tweetId === r.conversationId
  if (existing === undefined) {
    byConversation.set(r.conversationId, {
      conversationId: r.conversationId,
      rootHandle: r.author.handle,
      rootText: r.text,
      count: 1,
      lastAt: r.capturedAt,
    })
    return
  }
  existing.count += 1
  existing.lastAt = Math.max(existing.lastAt, r.capturedAt)
  if (isRoot) {
    existing.rootHandle = r.author.handle
    existing.rootText = r.text
  }
}

function recentConversations(records: ReadonlyArray<TweetRecord>, n: number): RecentConversation[] {
  const byConversation = new Map<string, RecentConversation>()
  for (const r of records) foldConversation(byConversation, r)
  return [...byConversation.values()].toSorted((a, b) => b.lastAt - a.lastAt).slice(0, n)
}

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

describe('streaming summary (fold/finish — the popup path that never loads the store whole)', () => {
  const records = [
    make({ tweetId: '1', source: 'timeline', capturedAt: 100 }),
    make({ tweetId: '2', conversationId: '1', source: 'timeline', capturedAt: 300 }),
    make({ tweetId: '3', source: 'tweetDetail', capturedAt: 200 }),
  ]

  it('matches summarize + recentConversations exactly on keyPath-unique records', () => {
    const acc = records.reduce(foldCaptureSummary, emptyCaptureSummary())
    const streamed = finishCaptureSummary(acc, 20)

    expect({ tweets: streamed.tweets, conversations: streamed.conversations }).toEqual(
      summarize(records),
    )
    expect(streamed.recent).toEqual(recentConversations(records, 20))
  })

  it('honors the recent-list cap', () => {
    const acc = records.reduce(foldCaptureSummary, emptyCaptureSummary())
    expect(finishCaptureSummary(acc, 1).recent).toEqual(recentConversations(records, 1))
    expect(finishCaptureSummary(acc, 1).recent).toHaveLength(1)
  })

  it('a late-arriving root record still overwrites the thread title, like the batch path', () => {
    const reply = make({
      tweetId: '9',
      conversationId: '7',
      handle: 'bob',
      text: 'reply first',
      source: 'timeline',
      capturedAt: 50,
    })
    const root = make({
      tweetId: '7',
      conversationId: '7',
      handle: 'alice',
      text: 'the root',
      source: 'timeline',
      capturedAt: 10,
    })
    const acc = [reply, root].reduce(foldCaptureSummary, emptyCaptureSummary())
    const { recent } = finishCaptureSummary(acc, 5)

    expect(recent).toEqual(recentConversations([reply, root], 5))
    expect(recent[0]).toMatchObject({ rootHandle: 'alice', rootText: 'the root', count: 2 })
  })

  it('empty store: zero counts, empty recent', () => {
    expect(finishCaptureSummary(emptyCaptureSummary(), 20)).toEqual({
      tweets: 0,
      conversations: 0,
      recent: [],
    })
  })
})
