import { describe, it, expect } from 'vitest'
import {
  DEFAULT_BATCH,
  DEFAULT_CAP,
  MAX_SYNC_OUTBOX_BYTES,
  append,
  decodeOutboxResult,
  emptyOutbox,
  isReady,
  markDrained,
  markFailed,
  rebaseRetryDeadline,
  takeBatch,
} from './outbox'
import { MAX_SAVE_REQUEST_ID_LENGTH } from '../download/request-identity'
import { MAX_CLOUD_DEVICE_ID_LENGTH } from '../schema/settings'
import { legacySyncEventId, outcomeEvent, syncEventId, type SyncEvent } from './events'

const ev = (n: number): SyncEvent => outcomeEvent(`r${n}`, 'completed', 'dev', n)
const storedState = (pending: ReadonlyArray<unknown>) => ({
  pending,
  consecutiveFailures: 0,
  nextAttemptAt: 0,
})
const decodeAvailable = (raw: unknown) => {
  const decoded = decodeOutboxResult(raw)
  if (!decoded.ok) throw new Error('expected available Sync outbox')
  return decoded.state
}

describe('append', () => {
  it('appends in order and dedupes by eventId (within and across calls)', () => {
    const s1 = append(emptyOutbox, [ev(1), ev(2), ev(2)])
    expect(s1.pending.map((e) => e.requestId)).toEqual(['r1', 'r2'])
    const s2 = append(s1, [ev(2), ev(3)])
    expect(s2.pending.map((e) => e.requestId)).toEqual(['r1', 'r2', 'r3'])
  })

  it('drops the oldest events beyond the cap', () => {
    const events = Array.from({ length: DEFAULT_CAP + 5 }, (_, i) => ev(i))
    const s = append(emptyOutbox, events)
    expect(s.pending).toHaveLength(DEFAULT_CAP)
    expect(s.pending[0]).toEqual(ev(5))
  })

  it('never lets a caller raise the durable cap or append a malformed event', () => {
    const malformed = { ...ev(3), eventId: 'forged' }
    const s = append(
      emptyOutbox,
      [...Array.from({ length: DEFAULT_CAP + 1 }, (_, i) => ev(i)), malformed],
      DEFAULT_CAP + 100,
    )
    expect(s.pending).toHaveLength(DEFAULT_CAP)
    expect(s.pending.some((event) => event.eventId === 'forged')).toBe(false)
  })
})

describe('takeBatch', () => {
  it('takes FIFO up to the batch size and leaves state untouched', () => {
    const s = append(
      emptyOutbox,
      Array.from({ length: DEFAULT_BATCH + 10 }, (_, i) => ev(i)),
    )
    const batch = takeBatch(s)
    expect(batch).toHaveLength(DEFAULT_BATCH)
    expect(batch[0]).toEqual(ev(0))
    expect(s.pending).toHaveLength(DEFAULT_BATCH + 10)
  })

  it('never lets a caller widen the backend batch contract', () => {
    const state = append(
      emptyOutbox,
      Array.from({ length: DEFAULT_BATCH + 10 }, (_, index) => ev(index)),
    )

    expect(takeBatch(state, DEFAULT_BATCH + 10)).toHaveLength(DEFAULT_BATCH)
    expect(takeBatch(state, Number.NaN)).toHaveLength(DEFAULT_BATCH)
  })
})

describe('markDrained', () => {
  it('removes the sent events and resets the backoff', () => {
    const failed = markFailed(append(emptyOutbox, [ev(1), ev(2), ev(3)]), 0)
    const s = markDrained(failed, [ev(1).eventId, ev(2).eventId])
    expect(s.pending.map((e) => e.requestId)).toEqual(['r3'])
    expect(s.consecutiveFailures).toBe(0)
    expect(isReady(s, 0)).toBe(true)
  })
})

describe('markFailed / isReady', () => {
  it('backs off exponentially from 5s and caps at 5 minutes', () => {
    let s = markFailed(emptyOutbox, 0)
    expect(s.nextAttemptAt).toBe(5_000)
    expect(isReady(s, 4_999)).toBe(false)
    expect(isReady(s, 5_000)).toBe(true)
    s = markFailed(s, 5_000)
    expect(s.nextAttemptAt).toBe(15_000)
    for (let i = 0; i < 10; i += 1) s = markFailed(s, 0)
    expect(s.nextAttemptAt).toBe(300_000)
  })

  it('keeps valid boundary state inside the durable integer domain', () => {
    const boundary = {
      ...emptyOutbox,
      consecutiveFailures: Number.MAX_SAFE_INTEGER,
    }

    expect(markFailed(boundary, Number.MAX_SAFE_INTEGER)).toEqual({
      pending: [],
      consecutiveFailures: Number.MAX_SAFE_INTEGER,
      nextAttemptAt: Number.MAX_SAFE_INTEGER,
    })
    expect(() => markFailed(emptyOutbox, -1)).toThrow(RangeError)
  })

  it('bounds a persisted deadline after wall-clock rollback', () => {
    const failed = markFailed(append(emptyOutbox, [ev(1)]), 1_000_000)

    expect(rebaseRetryDeadline(failed, 1_000)).toEqual({
      ...failed,
      nextAttemptAt: 6_000,
    })
    expect(rebaseRetryDeadline(failed, 1_004_000)).toBe(failed)
  })
})

describe('decodeOutboxResult', () => {
  it('round-trips a persisted state', () => {
    const s = markFailed(append(emptyOutbox, [ev(1)]), 7)
    expect(decodeOutboxResult(JSON.parse(JSON.stringify(s)))).toEqual({ ok: true, state: s })
  })

  it('distinguishes missing from corrupt data', () => {
    expect(decodeOutboxResult(null)).toEqual({ ok: true, state: emptyOutbox })
    expect(decodeOutboxResult({ pending: 'nope' })).toEqual({ ok: false })
  })

  it('rejects non-finite retry timestamps', () => {
    const poisoned = (nextAttemptAt: number) => ({
      pending: [JSON.parse(JSON.stringify(ev(1)))],
      consecutiveFailures: 0,
      nextAttemptAt,
    })

    expect(decodeOutboxResult(poisoned(Number.NaN))).toEqual({ ok: false })
    expect(decodeOutboxResult(poisoned(Number.POSITIVE_INFINITY))).toEqual({ ok: false })
  })

  it('rejects a non-finite failure count', () => {
    expect(
      decodeOutboxResult({
        pending: [],
        consecutiveFailures: Number.POSITIVE_INFINITY,
        nextAttemptAt: 0,
      }),
    ).toEqual({ ok: false })
  })

  it('rejects forged identities, duplicate ids, and excess event fields', () => {
    const event = ev(1)

    expect(decodeOutboxResult(storedState([{ ...event, eventId: 'forged' }]))).toEqual({
      ok: false,
    })
    expect(decodeOutboxResult(storedState([event, event]))).toEqual({ ok: false })
    expect(
      decodeOutboxResult(storedState([{ ...event, authHeaders: { cookie: 'secret' } }])),
    ).toEqual({ ok: false })
  })

  it('requires queued media and forbids media on terminal events', () => {
    const requestId = 'r1'
    const deviceId = 'dev'
    const queuedWithoutMedia = {
      eventId: syncEventId(deviceId, requestId, 'queued'),
      kind: 'queued',
      requestId,
      deviceId,
      at: 1,
    }
    const terminalWithMedia = {
      ...ev(1),
      media: {
        platform: 'x',
        postId: '1',
        author: 'a',
        type: 'photo',
        url: 'https://pbs.twimg.com/a.jpg',
        ext: 'jpg',
        index: 0,
      },
    }
    expect(decodeOutboxResult(storedState([queuedWithoutMedia]))).toEqual({ ok: false })
    expect(decodeOutboxResult(storedState([terminalWithMedia]))).toEqual({ ok: false })
  })

  it('rejects malformed HTTPS media URLs before they become undrainable', () => {
    const malformed = {
      eventId: syncEventId('dev', 'r1', 'queued'),
      kind: 'queued' as const,
      requestId: 'r1',
      deviceId: 'dev',
      at: 1,
      media: {
        platform: 'x' as const,
        postId: '1',
        author: 'a',
        type: 'photo' as const,
        url: 'https://',
        ext: 'jpg',
        index: 0,
      },
    }

    expect(decodeOutboxResult(storedState([malformed]))).toEqual({ ok: false })
    expect(append(emptyOutbox, [malformed])).toEqual(emptyOutbox)
  })

  it('preserves a valid legacy record but never accepts a new legacy event', () => {
    const current = ev(1)
    const legacy = { ...current, eventId: legacySyncEventId('dev', 'r1', 'completed') }
    const decoded = decodeAvailable(storedState([legacy]))

    expect(decoded.pending).toEqual([legacy])
    expect(append(decoded, [current]).pending).toEqual([legacy])
    expect(append(emptyOutbox, [legacy]).pending).toEqual([])
  })

  it('migrates exact pre-platform legacy media only with its legacy identity', () => {
    const legacy = {
      eventId: legacySyncEventId('dev', 'r1', 'queued'),
      kind: 'queued' as const,
      requestId: 'r1',
      deviceId: 'dev',
      at: 1,
      media: {
        tweetId: '1',
        handle: 'alice',
        type: 'photo' as const,
        url: 'https://pbs.twimg.com/a.jpg',
        ext: 'jpg',
        index: 0,
      },
    }
    const normalized = {
      ...legacy,
      media: {
        platform: 'x',
        postId: '1',
        author: 'alice',
        type: 'photo',
        url: 'https://pbs.twimg.com/a.jpg',
        ext: 'jpg',
        index: 0,
      },
    }

    expect(decodeOutboxResult(storedState([legacy]))).toEqual({
      ok: true,
      state: storedState([normalized]),
    })
    expect(
      decodeOutboxResult(storedState([{ ...legacy, eventId: syncEventId('dev', 'r1', 'queued') }])),
    ).toEqual({ ok: false })
  })

  it('merges persisted legacy and current aliases by their logical event tuple', () => {
    const current = ev(1)
    const legacy = {
      ...current,
      at: 0,
      eventId: legacySyncEventId(current.deviceId, current.requestId, current.kind),
    }

    expect(decodeOutboxResult(storedState([legacy, current]))).toEqual({
      ok: true,
      state: storedState([legacy]),
    })
    expect(decodeOutboxResult(storedState([current, legacy]))).toEqual({
      ok: true,
      state: storedState([current]),
    })
    expect(
      decodeOutboxResult(
        storedState([
          legacy,
          outcomeEvent(current.requestId, 'failed', current.deviceId, current.at),
        ]),
      ),
    ).toMatchObject({ ok: true })
  })

  it('rejects an ambiguous legacy event', () => {
    const event = {
      ...ev(1),
      deviceId: 'dev/one',
      eventId: legacySyncEventId('dev/one', 'r1', 'completed'),
    }
    expect(decodeOutboxResult(storedState([event]))).toEqual({ ok: false })
  })

  it('bounds event fields, entry count, and the whole persisted value', () => {
    const longRequestId = 'r'.repeat(MAX_SAVE_REQUEST_ID_LENGTH + 1)
    const longDeviceId = 'd'.repeat(MAX_CLOUD_DEVICE_ID_LENGTH + 1)
    expect(
      decodeOutboxResult(storedState([outcomeEvent(longRequestId, 'completed', 'dev', 1)])),
    ).toEqual({ ok: false })
    expect(
      decodeOutboxResult(storedState([outcomeEvent('r', 'completed', longDeviceId, 1)])),
    ).toEqual({ ok: false })
    expect(
      decodeOutboxResult(
        storedState(Array.from({ length: DEFAULT_CAP + 1 }, (_, index) => ev(index))),
      ),
    ).toEqual({ ok: false })
    expect(decodeOutboxResult('x'.repeat(MAX_SYNC_OUTBOX_BYTES + 1))).toEqual({ ok: false })
  })
})
