import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import type { TweetRecord } from '../capture/record'
import {
  capLedger,
  captureEventFromRecord,
  captureEventId,
  claim,
  decodeLedger,
  enqueue,
  readyJobs,
  SyncCaptureEvent,
  type CaptureLedger,
} from './captures'

const record = (overrides: Partial<TweetRecord> = {}): TweetRecord => ({
  tweetId: 't1',
  conversationId: 'c1',
  author: { handle: 'alice' },
  text: 'hello',
  rawText: 'hello',
  metrics: {},
  links: [],
  media: [],
  mentions: [],
  hashtags: [],
  source: 'timeline',
  sourceRank: 1,
  capturedAt: 1000,
  ...overrides,
})

const eventFor = (overrides: Partial<TweetRecord> = {}, at = 1000): SyncCaptureEvent =>
  captureEventFromRecord(record(overrides), 'dev-A', at)

describe('captureEventId', () => {
  it('is the deterministic `${deviceId}/${tweetId}` key', () => {
    expect(captureEventId('dev-A', '123')).toBe('dev-A/123')
    expect(captureEventId('dev-A', '123')).toBe(captureEventId('dev-A', '123'))
  })
})

describe('captureEventFromRecord', () => {
  it('projects the mirror-eligible fields with the idempotency key', () => {
    const e = captureEventFromRecord(
      record({
        tweetId: '99',
        conversationId: 'c9',
        inReplyToTweetId: '88',
        author: { handle: 'bob' },
        text: 'hi',
        createdAt: 42,
        links: [{ expandedUrl: 'https://a.test', title: 'A', domain: 'a.test' }],
        sourceRank: 2,
      }),
      'dev-A',
      7000,
    )
    expect(e).toEqual({
      eventId: 'dev-A/99',
      tweetId: '99',
      conversationId: 'c9',
      inReplyToTweetId: '88',
      handle: 'bob',
      text: 'hi',
      createdAt: 42,
      links: [{ expandedUrl: 'https://a.test', title: 'A', domain: 'a.test' }],
      sourceRank: 2,
      at: 7000,
    })
    expect(Schema.decodeUnknownSync(SyncCaptureEvent)(e)).toEqual(e)
  })

  it('omits absent optionals (no inReplyToTweetId/createdAt/links)', () => {
    const e = eventFor()
    expect('inReplyToTweetId' in e).toBe(false)
    expect('createdAt' in e).toBe(false)
    expect('links' in e).toBe(false)
  })
})

describe('enqueue', () => {
  it('appends a new event', () => {
    const l = enqueue([], eventFor())
    expect(l).toHaveLength(1)
    expect(l[0]!.eventId).toBe('dev-A/t1')
  })

  it('dedupes by tweetId — a newer event REPLACES the older queued one', () => {
    const l1 = enqueue([], eventFor({ text: 'old' }, 1000))
    const l2 = enqueue(l1, eventFor({ text: 'new' }, 2000))
    expect(l2).toHaveLength(1)
    expect(l2[0]!.text).toBe('new')
    expect(l2[0]!.at).toBe(2000)
  })

  it('caps the ledger, dropping the oldest on overflow', () => {
    let l: CaptureLedger = []
    for (let i = 0; i < 5; i += 1) l = enqueue(l, eventFor({ tweetId: `t${i}` }, i), 3)
    expect(l).toHaveLength(3)
    expect(l.map((e) => e.tweetId)).toEqual(['t2', 't3', 't4'])
  })
})

describe('readyJobs / claim', () => {
  it('readyJobs surfaces events drainable at now', () => {
    let l: CaptureLedger = []
    l = enqueue(l, eventFor({ tweetId: 'a' }, 100))
    l = enqueue(l, eventFor({ tweetId: 'b' }, 500))
    expect(readyJobs(l, 99)).toHaveLength(0)
    expect(readyJobs(l, 100).map((e) => e.tweetId)).toEqual(['a'])
    expect(readyJobs(l, 500).map((e) => e.tweetId)).toEqual(['a', 'b'])
  })

  it('claim removes a drained event by eventId', () => {
    let l: CaptureLedger = []
    l = enqueue(l, eventFor({ tweetId: 'a' }, 100))
    l = enqueue(l, eventFor({ tweetId: 'b' }, 100))
    const after = claim(l, 'dev-A/a', 200)
    expect(after.map((e) => e.tweetId)).toEqual(['b'])
  })

  it('claim is a no-op (same reference) for an unknown or not-yet-due event', () => {
    const l = enqueue([], eventFor({ tweetId: 'a' }, 500))
    expect(claim(l, 'dev-A/missing', 1000)).toBe(l)
    expect(claim(l, 'dev-A/a', 499)).toBe(l)
  })
})

describe('capLedger', () => {
  it('bounds the ledger to the cap, dropping the oldest', () => {
    let l: CaptureLedger = []
    for (let i = 0; i < 4; i += 1) l = enqueue(l, eventFor({ tweetId: `t${i}` }, i))
    const capped = capLedger(l, 2)
    expect(capped.map((e) => e.tweetId)).toEqual(['t2', 't3'])
  })

  it('returns the same reference when nothing is dropped', () => {
    const l = enqueue([], eventFor())
    expect(capLedger(l, 50)).toBe(l)
  })
})

describe('decodeLedger', () => {
  it('round-trips a valid ledger', () => {
    const l = enqueue([], eventFor())
    expect(decodeLedger(JSON.parse(JSON.stringify(l)))).toEqual(l)
  })

  it('tolerates corrupt input — falls back to empty', () => {
    expect(decodeLedger('not a ledger')).toEqual([])
    expect(decodeLedger(null)).toEqual([])
    expect(decodeLedger([{ tweetId: 1 }])).toEqual([])
  })
})
