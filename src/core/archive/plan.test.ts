import { describe, it, expect } from 'vitest'
import type { MediaItem, TweetCapture } from '../schema'
import { coerceIndex, markArchived, planArchive, sessionManifestDownload } from './plan'

const TEMPLATE = '{handle}/{tweetId}_{index}.{ext}'

const media = (tweetId: string, id: string): MediaItem => ({
  id,
  tweetId,
  handle: 'alice',
  type: 'photo',
  url: `https://pbs.twimg.com/media/${id}?format=jpg&name=orig`,
  ext: 'jpg',
  index: 0,
})

const capture = (tweetId: string, items: MediaItem[]): TweetCapture => ({
  tweetId,
  handle: 'alice',
  text: `tweet ${tweetId}`,
  links: ['https://arxiv.org/abs/2406.01234'],
  media: items,
})

const baseOpts = {
  source: 'bookmarks' as const,
  sessionId: 's1',
  archivedAt: '2026-06-11T14:22:33.000Z',
  options: { template: TEMPLATE, sidecar: false, includeText: true, linkScope: 'all' as const },
}

describe('planArchive', () => {
  it('plans media plus one history record per tweet, even without media', () => {
    const plan = planArchive({
      ...baseOpts,
      index: {},
      tweets: [capture('1', [media('1', 'm1')]), capture('2', [])],
    })
    expect(plan.downloads.map((d) => d.id)).toEqual(['m1', '1.tweet.json', '2.tweet.json'])
    expect(plan.tweets).toEqual([
      { tweetId: '1', requestIds: ['m1', '1.tweet.json'] },
      { tweetId: '2', requestIds: ['2.tweet.json'] },
    ])
    expect(plan.skipped).toEqual([])
    const record = plan.downloads[1]!
    expect(record.filename).toBe('alice/1.tweet.json')
    expect(record.url.startsWith('data:application/json')).toBe(true)
  })

  it('skips already-archived tweets whole — the idempotency cut', () => {
    const plan = planArchive({
      ...baseOpts,
      index: { '1': { archivedAt: 'x', sessionId: 's0', media: 2 } },
      tweets: [capture('1', [media('1', 'm1')]), capture('2', [media('2', 'm2')])],
    })
    expect(plan.skipped).toEqual(['1'])
    expect(plan.tweets.map((t) => t.tweetId)).toEqual(['2'])
    expect(plan.downloads.map((d) => d.id)).toEqual(['m2', '2.tweet.json'])
  })

  it('de-duplicates captures by tweetId within one request', () => {
    const plan = planArchive({
      ...baseOpts,
      index: {},
      tweets: [capture('1', [media('1', 'm1')]), capture('1', [media('1', 'm1')])],
    })
    expect(plan.tweets).toHaveLength(1)
  })

  it('adds per-media sidecars to the tweet ledger when enabled', () => {
    const plan = planArchive({
      ...baseOpts,
      options: { ...baseOpts.options, sidecar: true },
      index: {},
      tweets: [capture('1', [media('1', 'm1')])],
    })
    expect(plan.tweets[0]!.requestIds).toEqual(['m1', 'm1.json', '1.tweet.json'])
  })

  it('round-trips the history record through its data: URL', () => {
    const plan = planArchive({ ...baseOpts, index: {}, tweets: [capture('1', [])] })
    const url = plan.downloads[0]!.url
    const decoded: unknown = JSON.parse(decodeURIComponent(url.slice(url.indexOf(',') + 1)))
    expect(decoded).toMatchObject({
      tweetId: '1',
      source: 'bookmarks',
      sessionId: 's1',
      text: 'tweet 1',
      links: [{ url: 'https://arxiv.org/abs/2406.01234', scholarly: true }],
    })
  })
})

describe('coerceIndex', () => {
  it('keeps well-formed entries and drops garbage', () => {
    const index = coerceIndex({
      '1': { archivedAt: 'a', sessionId: 's', media: 2 },
      '2': { archivedAt: 1, sessionId: 's' },
      '3': 'nope',
    })
    expect(Object.keys(index)).toEqual(['1'])
  })

  it('treats non-objects as empty', () => {
    expect(coerceIndex(null)).toEqual({})
    expect(coerceIndex('corrupt')).toEqual({})
  })
})

describe('markArchived', () => {
  it('adds only fresh OK results, preserving prior entries', () => {
    const next = markArchived(
      { '0': { archivedAt: 'a', sessionId: 's0', media: 1 } },
      [
        { tweetId: '1', ok: true, completed: 2, total: 2, alreadyArchived: false },
        { tweetId: '2', ok: false, completed: 0, total: 1, alreadyArchived: false },
        { tweetId: '3', ok: true, completed: 0, total: 0, alreadyArchived: true },
      ],
      's1',
      '2026-06-11T14:22:33.000Z',
    )
    expect(Object.keys(next).toSorted()).toEqual(['0', '1'])
    expect(next['1']).toEqual({
      archivedAt: '2026-06-11T14:22:33.000Z',
      sessionId: 's1',
      media: 2,
    })
  })
})

describe('sessionManifestDownload', () => {
  it('plans the manifest under the sessions directory with a stable id', () => {
    const manifest = sessionManifestDownload({
      sessionId: 's1',
      source: 'bookmarks',
      archivedAt: '2026-06-11T14:22:33.000Z',
      options: { includeText: true, linkScope: 'all' },
      results: [],
    })
    expect(manifest.id).toBe('session-s1')
    expect(manifest.filename).toBe('x-archive/sessions/s1.json')
    expect(manifest.url.startsWith('data:application/json')).toBe(true)
  })
})
