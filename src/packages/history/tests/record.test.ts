import { describe, it, expect } from 'vitest'
import { Schema, Result } from 'effect'
import { DownloadRecord, recordFromMediaItem, applyOutcome } from '../record'
import type { MediaItem } from '@/packages/schema'

const item: MediaItem = {
  id: '123-0',
  platform: 'x',
  postId: '123',
  author: 'alice',
  type: 'photo',
  url: 'https://pbs.twimg.com/media/abc?format=jpg&name=orig',
  ext: 'jpg',
  index: 0,
}

describe('recordFromMediaItem', () => {
  it('builds a queued record carrying the original link and provenance', () => {
    expect(recordFromMediaItem(item, 'alice/123_0.jpg', 1000)).toEqual({
      requestId: '123-0',
      filename: 'alice/123_0.jpg',
      status: 'queued',
      media: {
        platform: 'x',
        postId: '123',
        author: 'alice',
        type: 'photo',
        url: 'https://pbs.twimg.com/media/abc?format=jpg&name=orig',
        index: 0,
        ext: 'jpg',
      },
      queuedAt: 1000,
    })
  })
})

describe('applyOutcome', () => {
  it('marks a record completed with finishedAt and byte counts, preserving provenance', () => {
    const queued = recordFromMediaItem(item, 'alice/123_0.jpg', 1000)
    const done = applyOutcome(queued, 'completed', 2000, { received: 50, total: 50 })
    expect(done.status).toBe('completed')
    expect(done.finishedAt).toBe(2000)
    expect(done.bytesReceived).toBe(50)
    expect(done.bytesTotal).toBe(50)
    expect(done.requestId).toBe('123-0')
    expect(done.media).toEqual(queued.media)
    expect(done.filename).toBe('alice/123_0.jpg')
    expect(done.queuedAt).toBe(1000)
  })

  it('marks a record failed with finishedAt and no required byte counts', () => {
    const queued = recordFromMediaItem(item, 'alice/123_0.jpg', 1000)
    const failed = applyOutcome(queued, 'failed', 3000)
    expect(failed.status).toBe('failed')
    expect(failed.finishedAt).toBe(3000)
  })

  it('does not mutate the input record', () => {
    const queued = recordFromMediaItem(item, 'alice/123_0.jpg', 1000)
    applyOutcome(queued, 'completed', 2000)
    expect(queued.status).toBe('queued')
    expect('finishedAt' in queued).toBe(false)
  })
})

describe('DownloadRecord schema', () => {
  it('round-trips a built record', () => {
    const r = recordFromMediaItem(item, 'alice/123_0.jpg', 1000)
    expect(Schema.decodeUnknownSync(DownloadRecord)(r)).toEqual(r)
  })

  it('drops unknown keys on decode', () => {
    const raw = { ...recordFromMediaItem(item, 'f.jpg', 1), smuggled: { cookie: 's' } }
    const decoded = Schema.decodeUnknownSync(DownloadRecord)(raw)
    expect('smuggled' in decoded).toBe(false)
  })

  it('rejects a malformed record (bad status / missing requestId)', () => {
    const r = recordFromMediaItem(item, 'f.jpg', 1)
    expect(
      Result.isFailure(Schema.decodeUnknownResult(DownloadRecord)({ ...r, status: 'uploaded' })),
    ).toBe(true)
    const { requestId: _drop, ...noId } = r
    expect(Result.isFailure(Schema.decodeUnknownResult(DownloadRecord)(noId))).toBe(true)
  })
})
