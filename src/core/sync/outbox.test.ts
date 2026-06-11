import { describe, it, expect } from 'vitest'
import {
  DEFAULT_BATCH,
  DEFAULT_CAP,
  append,
  decodeOutbox,
  emptyOutbox,
  isReady,
  markDrained,
  markFailed,
  takeBatch,
} from './outbox'
import { outcomeEvent, type SyncEvent } from './events'

const ev = (n: number): SyncEvent => outcomeEvent(`r${n}`, 'completed', 'dev', n)

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
})

describe('decodeOutbox', () => {
  it('round-trips a persisted state', () => {
    const s = markFailed(append(emptyOutbox, [ev(1)]), 7)
    expect(decodeOutbox(JSON.parse(JSON.stringify(s)))).toEqual(s)
  })

  it('falls back to empty on corrupt or missing data', () => {
    expect(decodeOutbox(null)).toEqual(emptyOutbox)
    expect(decodeOutbox({ pending: 'nope' })).toEqual(emptyOutbox)
  })
})
