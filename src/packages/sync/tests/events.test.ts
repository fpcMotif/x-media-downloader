import { describe, it, expect } from 'vitest'
import { Schema, Result } from 'effect'
import { SyncEvent, syncEventId, queuedEvent, outcomeEvent } from '../events'
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

describe('syncEventId', () => {
  it('is deterministic for the same (device, request, kind)', () => {
    expect(syncEventId('dev1', '123-0', 'queued')).toBe(syncEventId('dev1', '123-0', 'queued'))
  })

  it('differs across kinds and devices', () => {
    expect(syncEventId('dev1', '123-0', 'queued')).not.toBe(
      syncEventId('dev1', '123-0', 'completed'),
    )
    expect(syncEventId('dev1', '123-0', 'queued')).not.toBe(syncEventId('dev2', '123-0', 'queued'))
  })
})

describe('queuedEvent', () => {
  it('mirrors exactly the allowed metadata fields', () => {
    expect(queuedEvent(item, 'dev1', 1000)).toEqual({
      eventId: 'dev1/123-0/queued',
      kind: 'queued',
      requestId: '123-0',
      deviceId: 'dev1',
      at: 1000,
      media: {
        platform: 'x',
        postId: '123',
        author: 'alice',
        type: 'photo',
        url: 'https://pbs.twimg.com/media/abc?format=jpg&name=orig',
        ext: 'jpg',
        index: 0,
      },
    })
  })
})

describe('outcomeEvent', () => {
  it('carries no media payload (the queued event already cached it)', () => {
    const e = outcomeEvent('123-0', 'completed', 'dev1', 2000)
    expect(e.eventId).toBe('dev1/123-0/completed')
    expect(e.kind).toBe('completed')
    expect('media' in e).toBe(false)
  })
})

describe('SyncEvent schema', () => {
  it('round-trips a built event', () => {
    const e = queuedEvent(item, 'dev1', 1000)
    expect(Schema.decodeUnknownSync(SyncEvent)(e)).toEqual(e)
  })

  it('does not let unknown keys (smuggled captures/auth) survive decode', () => {
    const raw = { ...outcomeEvent('r1', 'failed', 'dev1', 1), authHeaders: { cookie: 's' } }
    const decoded = Schema.decodeUnknownSync(SyncEvent)(raw)
    expect('authHeaders' in decoded).toBe(false)
  })

  it('rejects an unknown kind', () => {
    const raw = { ...outcomeEvent('r1', 'failed', 'dev1', 1), kind: 'uploaded' }
    expect(Result.isFailure(Schema.decodeUnknownResult(SyncEvent)(raw))).toBe(true)
  })
})
