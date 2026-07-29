import { describe, it, expect } from 'vitest'
import { Schema, Result } from 'effect'
import {
  SYNC_EVENT_ID_V1_PREFIX,
  MAX_SYNC_EVENT_ID_LENGTH,
  SyncEvent,
  legacySyncEventId,
  outcomeEvent,
  queuedEvent,
  syncEventId,
  syncEventIdVersion,
} from './events'
import type { MediaItem } from '../schema'
import { MAX_SAVE_REQUEST_ID_LENGTH } from '../download/request-identity'
import { MAX_CLOUD_DEVICE_ID_LENGTH } from '../schema/settings'

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

  it('cannot collide when a bounded field contains a separator', () => {
    expect(syncEventId('a/b', 'c', 'queued')).not.toBe(syncEventId('a', 'b/c', 'queued'))
  })

  it('marks old slash IDs as legacy only', () => {
    const legacy = legacySyncEventId('dev-one', 'request-two', 'queued')
    expect(syncEventIdVersion(legacy, 'dev-one', 'request-two', 'queued')).toBe('legacy')
    expect(
      syncEventIdVersion(
        syncEventId('dev/one', 'request/two', 'queued'),
        'dev/one',
        'request/two',
        'queued',
      ),
    ).toBe('v1')
  })

  it('never accepts a slash-delimited legacy tuple', () => {
    const legacy = legacySyncEventId('dev/one', 'request-two', 'queued')
    expect(syncEventIdVersion(legacy, 'dev/one', 'request-two', 'queued')).toBeUndefined()
  })
})

describe('queuedEvent', () => {
  it('mirrors exactly the allowed metadata fields', () => {
    expect(queuedEvent(item, 'dev1', 1000)).toEqual({
      eventId: `${SYNC_EVENT_ID_V1_PREFIX}4:dev1:5:123-0:queued`,
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

  it('uses the global Save Request ID for non-X media', () => {
    expect(queuedEvent({ ...item, platform: 'threads' }, 'dev1', 1000)).toMatchObject({
      eventId: 'xmd-sync:v1:4:dev1:28:xmd:v1:media:threads:5:123-0:queued',
      requestId: 'xmd:v1:media:threads:5:123-0',
    })
  })
})

describe('outcomeEvent', () => {
  it('carries no media payload (the queued event already cached it)', () => {
    const e = outcomeEvent('123-0', 'completed', 'dev1', 2000)
    expect(e.eventId).toBe(`${SYNC_EVENT_ID_V1_PREFIX}4:dev1:5:123-0:completed`)
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

  it.each([
    ['empty event id', { eventId: '' }],
    ['oversized event id', { eventId: 'e'.repeat(MAX_SYNC_EVENT_ID_LENGTH + 1) }],
    ['empty request id', { requestId: '' }],
    ['oversized request id', { requestId: 'r'.repeat(MAX_SAVE_REQUEST_ID_LENGTH + 1) }],
    ['empty device id', { deviceId: '' }],
    ['oversized device id', { deviceId: 'd'.repeat(MAX_CLOUD_DEVICE_ID_LENGTH + 1) }],
    ['negative time', { at: -1 }],
    ['fractional time', { at: 0.5 }],
    ['NaN time', { at: Number.NaN }],
    ['infinite time', { at: Number.POSITIVE_INFINITY }],
  ])('rejects bounded-field violation: %s', (_name, patch) => {
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(SyncEvent)({
          ...outcomeEvent('r1', 'failed', 'd', 1),
          ...patch,
        }),
      ),
    ).toBe(true)
  })

  it('requires media for a queued event', () => {
    const queued = queuedEvent(item, 'device', 1)
    const { media: _media, ...withoutMedia } = queued
    expect(Result.isFailure(Schema.decodeUnknownResult(SyncEvent)(withoutMedia))).toBe(true)
  })
})
