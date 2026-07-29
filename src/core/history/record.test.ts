import { describe, it, expect } from 'vitest'
import { Schema, Result } from 'effect'
import {
  DownloadRecord,
  MAX_DOWNLOAD_HISTORY_FILENAME_LENGTH,
  recordFromMediaItem,
  applyOutcome,
  decodeDownloadRecord,
  decodeLegacyDownloadRecord,
} from './record'
import type { MediaItem } from '../schema'
import { MAX_MEDIA_URL_LENGTH } from '../schema/media'
import { MAX_SAVE_REQUEST_ID_LENGTH } from '../download/request-identity'

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
      mediaKey: '123-0',
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
    expect(done.mediaKey).toBe('123-0')
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

  it.each([
    ['empty request id', { requestId: '' }],
    ['long request id', { requestId: 'r'.repeat(MAX_SAVE_REQUEST_ID_LENGTH + 1) }],
    ['empty filename', { filename: '' }],
    ['long filename', { filename: 'f'.repeat(MAX_DOWNLOAD_HISTORY_FILENAME_LENGTH + 1) }],
    ['negative queued time', { queuedAt: -1 }],
    ['unsafe queued time', { queuedAt: Number.MAX_SAFE_INTEGER + 1 }],
    ['fractional received bytes', { bytesReceived: 0.5 }],
    [
      'long media URL',
      {
        media: {
          ...recordFromMediaItem(item, 'f.jpg', 1).media,
          url: `https://pbs.twimg.com/${'u'.repeat(MAX_MEDIA_URL_LENGTH)}`,
        },
      },
    ],
  ])('rejects bounded-field violation: %s', (_name, patch) => {
    const record = { ...recordFromMediaItem(item, 'f.jpg', 1), ...patch }
    expect(Result.isFailure(Schema.decodeUnknownResult(DownloadRecord)(record))).toBe(true)
  })

  it('uses the global Save Request ID for non-X media', () => {
    const record = recordFromMediaItem({ ...item, platform: 'instagram' }, 'photo.jpg', 1)
    expect(record.requestId).toBe('xmd:v1:media:instagram:5:123-0')
    expect(record.mediaKey).toBe('123-0')
  })

  it('escapes an X Media Key that resembles a global request id', () => {
    const mediaKey = 'xmd:v1:media:instagram:6:shared'
    const record = recordFromMediaItem({ ...item, id: mediaKey }, 'photo.jpg', 1)

    expect(record.requestId).toBe('xmd:v1:media:x:31:xmd:v1:media:instagram:6:shared')
    expect(decodeDownloadRecord(record)).toEqual(record)
  })

  it('rejects a v2 row whose request id does not match its Media Key and platform', () => {
    const record = recordFromMediaItem({ ...item, platform: 'instagram' }, 'photo.jpg', 1)

    expect(decodeDownloadRecord({ ...record, requestId: record.mediaKey })).toBeUndefined()
    expect(decodeDownloadRecord({ ...record, mediaKey: 'other' })).toBeUndefined()
    expect(() => recordFromMediaItem(item, 'photo.jpg', 1, 'other')).toThrow(TypeError)
  })

  it('rejects impossible queued, terminal, and byte-pair lifecycles', () => {
    const queued = recordFromMediaItem(item, 'photo.jpg', 1)
    const completed = applyOutcome(queued, 'completed', 2, { received: 1, total: 1 })
    const { finishedAt: _finishedAt, ...terminalWithoutTime } = completed

    expect(decodeDownloadRecord({ ...queued, finishedAt: 2 })).toBeUndefined()
    expect(decodeDownloadRecord({ ...queued, bytesReceived: 1, bytesTotal: 1 })).toBeUndefined()
    expect(decodeDownloadRecord(terminalWithoutTime)).toBeUndefined()
    expect(decodeDownloadRecord({ ...completed, bytesTotal: undefined })).toBeUndefined()
  })

  it('rejects terminal time before queue time in current and legacy rows', () => {
    const completed = applyOutcome(recordFromMediaItem(item, 'photo.jpg', 100), 'completed', 200)
    const invalid = { ...completed, finishedAt: 99 }
    const { mediaKey: _mediaKey, ...legacy } = invalid

    expect(decodeDownloadRecord(invalid)).toBeUndefined()
    expect(decodeLegacyDownloadRecord(legacy)).toBeUndefined()
  })

  it('clamps a backward wall clock before producing durable terminal history', () => {
    const queued = recordFromMediaItem(item, 'photo.jpg', 100)
    expect(applyOutcome(queued, 'completed', 99).finishedAt).toBe(100)
  })
})
