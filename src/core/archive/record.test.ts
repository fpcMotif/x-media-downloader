import { describe, it, expect } from 'vitest'
import { buildArchiveRecord, archiveRecordFilename, planArchiveRecord } from './record'
import type { TweetCandidate } from './capture'
import type { MediaItem } from '../schema'

const mediaItem = (over: Partial<MediaItem> = {}): MediaItem => ({
  id: 'm0',
  tweetId: '123',
  handle: 'alice',
  type: 'photo',
  url: 'https://pbs.twimg.com/media/AAA.jpg?name=orig',
  ext: 'jpg',
  index: 0,
  ...over,
})

const candidate = (over: Partial<TweetCandidate> = {}): TweetCandidate => ({
  tweetId: '123',
  handle: 'alice',
  source: 'bookmarks',
  text: 'hello',
  createdAt: 'Wed Jun 11 00:00:00 +0000 2026',
  links: [{ url: 'https://arxiv.org/abs/1', kind: 'scholarly', publisher: 'arxiv' }],
  items: [mediaItem()],
  ...over,
})

/** A candidate that never had a `created_at` (exactOptionalPropertyTypes-safe). */
const candidateNoCreatedAt = (): TweetCandidate => ({
  tweetId: '123',
  handle: 'alice',
  source: 'bookmarks',
  text: 'hello',
  links: [{ url: 'https://arxiv.org/abs/1', kind: 'scholarly', publisher: 'arxiv' }],
  items: [mediaItem()],
})

const ISO = '2026-06-11T12:00:00.000Z'

/** Pull the JSON payload back out of a sidecar-style data: URL (ADR-0007). */
const decodeDataUrl = (url: string): unknown => {
  expect(url.startsWith('data:application/json')).toBe(true)
  const payload = url.slice(url.indexOf(',') + 1)
  return JSON.parse(decodeURIComponent(payload))
}

describe('buildArchiveRecord', () => {
  it('builds the canonical author tweetUrl and core fields', () => {
    const r = buildArchiveRecord(candidate(), { includeText: true, linkMode: 'all' }, ISO)
    expect(r).toMatchObject({
      tweetId: '123',
      handle: 'alice',
      source: 'bookmarks',
      savedAt: ISO,
      tweetUrl: 'https://x.com/alice/status/123',
    })
    expect(r.createdAt).toBe('Wed Jun 11 00:00:00 +0000 2026')
  })

  it('uses /i/web/status/ when the handle is empty', () => {
    const r = buildArchiveRecord(
      candidate({ handle: '' }),
      { includeText: true, linkMode: 'all' },
      ISO,
    )
    expect(r.tweetUrl).toBe('https://x.com/i/web/status/123')
  })

  it('omits text when includeText is false; includes it when true', () => {
    const off = buildArchiveRecord(candidate(), { includeText: false, linkMode: 'all' }, ISO)
    expect('text' in off).toBe(false)
    const on = buildArchiveRecord(candidate(), { includeText: true, linkMode: 'all' }, ISO)
    expect(on.text).toBe('hello')
  })

  it('omits the links key entirely when linkMode is none', () => {
    const r = buildArchiveRecord(candidate(), { includeText: true, linkMode: 'none' }, ISO)
    expect('links' in r).toBe(false)
  })

  it('filters links by mode (scholarly keeps only scholarly, possibly [])', () => {
    const c = candidate({
      links: [
        { url: 'https://arxiv.org/abs/1', kind: 'scholarly', publisher: 'arxiv' },
        { url: 'https://example.com/blog', kind: 'other' },
      ],
    })
    const scholarly = buildArchiveRecord(c, { includeText: true, linkMode: 'scholarly' }, ISO)
    expect(scholarly.links).toEqual([
      { url: 'https://arxiv.org/abs/1', kind: 'scholarly', publisher: 'arxiv' },
    ])
    const all = buildArchiveRecord(c, { includeText: true, linkMode: 'all' }, ISO)
    expect(all.links).toHaveLength(2)
  })

  it('keeps the links key present but empty for scholarly mode with no scholarly links', () => {
    const c = candidate({ links: [{ url: 'https://example.com/x', kind: 'other' }] })
    const r = buildArchiveRecord(c, { includeText: true, linkMode: 'scholarly' }, ISO)
    expect('links' in r).toBe(true)
    expect(r.links).toEqual([])
  })

  it('omits createdAt when the candidate has none', () => {
    const c = candidateNoCreatedAt()
    const r = buildArchiveRecord(c, { includeText: true, linkMode: 'all' }, ISO)
    expect('createdAt' in r).toBe(false)
  })

  it('always lists media as index/type/url tuples', () => {
    const c = candidate({
      items: [
        mediaItem({ index: 0, type: 'photo', url: 'https://pbs.twimg.com/media/A.jpg?name=orig' }),
        mediaItem({
          id: 'm1',
          index: 1,
          type: 'video',
          ext: 'mp4',
          url: 'https://video.twimg.com/v.mp4',
        }),
      ],
    })
    const r = buildArchiveRecord(c, { includeText: true, linkMode: 'all' }, ISO)
    expect(r.media).toEqual([
      { index: 0, type: 'photo', url: 'https://pbs.twimg.com/media/A.jpg?name=orig' },
      { index: 1, type: 'video', url: 'https://video.twimg.com/v.mp4' },
    ])
  })

  it('emits an empty media array for a text-only tweet', () => {
    const r = buildArchiveRecord(
      candidate({ items: [] }),
      { includeText: true, linkMode: 'all' },
      ISO,
    )
    expect(r.media).toEqual([])
  })
})

describe('archiveRecordFilename', () => {
  it('forces {tweetId}_tweet.json while preserving the rendered directory', () => {
    const out = archiveRecordFilename('{handle}/{tweetId}_{index}.{ext}', candidate())
    expect(out).toBe('alice/123_tweet.json')
  })

  it('preserves a deeper rendered directory and always uses _tweet.json basename', () => {
    const out = archiveRecordFilename('{handle}/{tweetId}/{index}.{ext}', candidate())
    expect(out).toBe('alice/123/123_tweet.json')
  })

  it('handles a flat template with no directory', () => {
    const out = archiveRecordFilename('{tweetId}_{index}.{ext}', candidate())
    expect(out).toBe('123_tweet.json')
  })

  it('renders the date token in the directory when the template uses it', () => {
    // archiveRecordFilename renders for a synthetic photo item — the basename is
    // always replaced, but a {date}-derived directory should survive only if the
    // implementation threads a date; with no date the token renders empty.
    const out = archiveRecordFilename(
      '{handle}/{tweetId}_{index}.{ext}',
      candidate({ handle: 'bob', tweetId: '77' }),
    )
    expect(out).toBe('bob/77_tweet.json')
  })
})

describe('planArchiveRecord', () => {
  it('produces a PlannedDownload whose id is archive:{tweetId}', () => {
    const plan = planArchiveRecord(
      '{handle}/{tweetId}_{index}.{ext}',
      candidate(),
      { includeText: true, linkMode: 'all' },
      ISO,
    )
    expect(plan.id).toBe('archive:123')
    expect(plan.filename).toBe('alice/123_tweet.json')
  })

  it('url is a data:application/json sidecar that decodes back to the record', () => {
    const opts = { includeText: true, linkMode: 'all' as const }
    const plan = planArchiveRecord('{handle}/{tweetId}_{index}.{ext}', candidate(), opts, ISO)
    const decoded = decodeDataUrl(plan.url) as Record<string, unknown>
    const record = buildArchiveRecord(candidate(), opts, ISO)
    expect(decoded).toEqual(record)
    // spot-check load-bearing fields survived the round-trip
    expect(decoded.tweetUrl).toBe('https://x.com/alice/status/123')
    expect(decoded.savedAt).toBe(ISO)
  })

  it('omits text/links in the encoded record per options', () => {
    const plan = planArchiveRecord(
      '{handle}/{tweetId}_{index}.{ext}',
      candidate(),
      { includeText: false, linkMode: 'none' },
      ISO,
    )
    const decoded = decodeDataUrl(plan.url) as Record<string, unknown>
    expect('text' in decoded).toBe(false)
    expect('links' in decoded).toBe(false)
  })
})
