import { describe, it, expect } from 'vitest'
import type { MediaItem, TweetCapture } from '../schema'
import {
  buildSessionManifest,
  buildTweetRecord,
  makeSessionId,
  sessionManifestFilename,
  tweetRecordFilename,
  tweetUrl,
} from './record'

const TEMPLATE = '{handle}/{tweetId}_{index}.{ext}'

const photo: MediaItem = {
  id: 'm1',
  tweetId: '100',
  handle: 'alice',
  type: 'photo',
  url: 'https://pbs.twimg.com/media/AAA?format=jpg&name=orig',
  ext: 'jpg',
  index: 0,
}

const capture: TweetCapture = {
  tweetId: '100',
  handle: 'alice',
  text: 'new paper out!',
  createdAt: 'Wed Jun 10 20:19:24 +0000 2026',
  links: ['https://arxiv.org/abs/2406.01234', 'https://example.com/blog'],
  media: [photo],
}

describe('tweetUrl', () => {
  it('builds the author permalink, falling back to /i/web/ without one', () => {
    expect(tweetUrl(capture)).toBe('https://x.com/alice/status/100')
    expect(tweetUrl({ tweetId: '7', handle: '' })).toBe('https://x.com/i/web/status/7')
  })
})

describe('makeSessionId', () => {
  it('is UTC-sortable with the injected suffix', () => {
    expect(makeSessionId(Date.UTC(2026, 5, 11, 14, 22, 33), 'k3x9q1')).toBe(
      '20260611-142233-k3x9q1',
    )
  })
})

describe('tweetRecordFilename', () => {
  it('lands next to the tweet media per the filename template', () => {
    expect(tweetRecordFilename(TEMPLATE, capture)).toBe('alice/100.tweet.json')
  })

  it('still lands in the author directory for a text-only tweet', () => {
    expect(tweetRecordFilename(TEMPLATE, { ...capture, media: [] })).toBe('alice/100.tweet.json')
  })

  it('stays at the root for a flat template', () => {
    expect(tweetRecordFilename('{tweetId}_{index}.{ext}', capture)).toBe('100.tweet.json')
  })
})

describe('buildTweetRecord', () => {
  const base = {
    capture,
    source: 'bookmarks' as const,
    sessionId: 's1',
    archivedAt: '2026-06-11T14:22:33.000Z',
    template: TEMPLATE,
  }

  it('carries provenance, text, classified links, and media filenames', () => {
    const record = buildTweetRecord({ ...base, options: { includeText: true, linkScope: 'all' } })
    expect(record).toMatchObject({
      tweetId: '100',
      handle: 'alice',
      url: 'https://x.com/alice/status/100',
      source: 'bookmarks',
      sessionId: 's1',
      createdAt: 'Wed Jun 10 20:19:24 +0000 2026',
      text: 'new paper out!',
    })
    expect(record['links']).toEqual([
      { url: 'https://arxiv.org/abs/2406.01234', scholarly: true },
      { url: 'https://example.com/blog', scholarly: false },
    ])
    expect(record['media']).toEqual([
      { id: 'm1', type: 'photo', url: photo.url, filename: 'alice/100_0.jpg' },
    ])
  })

  it('omits text when the option is off', () => {
    const record = buildTweetRecord({ ...base, options: { includeText: false, linkScope: 'all' } })
    expect('text' in record).toBe(false)
  })

  it('keeps only scholarly links under that scope, and none at all under "none"', () => {
    const scholarly = buildTweetRecord({
      ...base,
      options: { includeText: true, linkScope: 'scholarly' },
    })
    expect(scholarly['links']).toEqual([
      { url: 'https://arxiv.org/abs/2406.01234', scholarly: true },
    ])
    const none = buildTweetRecord({ ...base, options: { includeText: true, linkScope: 'none' } })
    expect('links' in none).toBe(false)
  })
})

describe('buildSessionManifest', () => {
  it('marks the run: totals split fresh saves, failures, and idempotent skips', () => {
    const manifest = buildSessionManifest({
      sessionId: 's1',
      source: 'likes',
      archivedAt: '2026-06-11T14:22:33.000Z',
      options: { includeText: true, linkScope: 'scholarly' },
      results: [
        { tweetId: '1', ok: true, completed: 2, total: 2, alreadyArchived: false },
        { tweetId: '2', ok: false, completed: 1, total: 3, alreadyArchived: false },
        { tweetId: '3', ok: true, completed: 0, total: 0, alreadyArchived: true },
      ],
    })
    expect(manifest).toMatchObject({
      sessionId: 's1',
      source: 'likes',
      options: { includeText: true, linkScope: 'scholarly' },
      totals: { archived: 1, failed: 1, alreadyArchived: 1 },
    })
    expect(manifest['tweets']).toHaveLength(3)
  })

  it('names manifests under a shared sessions directory', () => {
    expect(sessionManifestFilename('20260611-142233-k3x9q1')).toBe(
      'x-archive/sessions/20260611-142233-k3x9q1.json',
    )
  })
})
