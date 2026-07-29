import { describe, it, expect } from 'vitest'
import {
  INTERRUPT_RETRY_MAX,
  decodeInterruptRetryQueue,
  interruptBackoffMs,
  isRetryableInterruptReason,
  normalizePendingInterruptRetry,
  planInterruptRetry,
} from './interrupt-retry'

describe('isRetryableInterruptReason', () => {
  it('retries transient network and crash errors', () => {
    expect(isRetryableInterruptReason('NETWORK_FAILED')).toBe(true)
    expect(isRetryableInterruptReason('NETWORK_TIMEOUT')).toBe(true)
    expect(isRetryableInterruptReason('NETWORK_DISCONNECTED')).toBe(true)
    expect(isRetryableInterruptReason('CRASH')).toBe(true)
    expect(isRetryableInterruptReason('FILE_TRANSIENT_ERROR')).toBe(true)
  })

  it('does not retry user cancel or auth/CDN rejections', () => {
    expect(isRetryableInterruptReason('USER_CANCELED')).toBe(false)
    expect(isRetryableInterruptReason('SERVER_FORBIDDEN')).toBe(false)
    expect(isRetryableInterruptReason('SERVER_BAD_CONTENT')).toBe(false)
    expect(isRetryableInterruptReason('FILE_BLOCKED')).toBe(false)
  })

  it('retries when Chrome omits an interrupt reason', () => {
    expect(isRetryableInterruptReason(undefined)).toBe(true)
  })
})

describe('interruptBackoffMs', () => {
  it('doubles the base delay per attempt (2s → 4s → 8s)', () => {
    expect(interruptBackoffMs(0)).toBe(2000)
    expect(interruptBackoffMs(1)).toBe(4000)
    expect(interruptBackoffMs(2)).toBe(8000)
  })
})

describe('planInterruptRetry', () => {
  it('schedules retry with exponential backoff for retryable errors under the cap', () => {
    expect(planInterruptRetry({ reason: 'NETWORK_TIMEOUT', attempt: 0 })).toEqual({
      schedule: true,
      delayMs: 2000,
      nextAttempt: 1,
    })
    expect(planInterruptRetry({ reason: 'NETWORK_FAILED', attempt: 2 })).toEqual({
      schedule: true,
      delayMs: 8000,
      nextAttempt: 3,
    })
  })

  it('stops scheduling once max retries are exhausted', () => {
    expect(planInterruptRetry({ reason: 'NETWORK_FAILED', attempt: INTERRUPT_RETRY_MAX })).toEqual({
      schedule: false,
    })
  })

  it('does not schedule for non-retryable interrupt reasons', () => {
    expect(planInterruptRetry({ reason: 'SERVER_FORBIDDEN', attempt: 0 })).toEqual({
      schedule: false,
    })
  })
})

describe('interrupt retry identity', () => {
  const request = { id: 'm1', url: 'https://cdn.example/a.jpg', filename: 'a.jpg' }

  it('normalizes legacy queued rows to Direct', () => {
    expect(
      normalizePendingInterruptRetry({
        ...request,
        attempt: 1,
        nextRetryAt: 2_000,
      }),
    ).toMatchObject({ mode: 'direct' })
  })

  it('strictly decodes legacy rows, preserving their media schema', () => {
    const raw = [
      {
        ...request,
        attempt: 1,
        nextRetryAt: 2_000,
        item: {
          id: 'm1',
          platform: 'x',
          postId: 'p1',
          author: 'a',
          type: 'photo',
          url: 'https://cdn.example/a.jpg',
          ext: 'jpg',
          index: 0,
        },
      },
    ]
    expect(decodeInterruptRetryQueue(raw)).toMatchObject({
      ok: true,
      retries: [{ id: 'm1', mode: 'direct' }],
    })
  })

  const invalidQueues: ReadonlyArray<unknown> = [
    [{ ...request, mode: 'other', attempt: 1, nextRetryAt: 2_000 }],
    [{ ...request, attempt: -1, nextRetryAt: 2_000 }],
    [{ ...request, attempt: 1, nextRetryAt: Number.NaN }],
    [{ ...request, attempt: 1, nextRetryAt: 2_000, unknown: true }],
    [
      {
        ...request,
        attempt: 1,
        nextRetryAt: 2_000,
        item: {
          id: 'm1',
          platform: 'not-a-platform',
          postId: 'p1',
          author: 'a',
          type: 'photo',
          url: 'https://cdn.example/a.jpg',
          ext: 'jpg',
          index: 0,
        },
      },
    ],
    [
      { ...request, attempt: 1, nextRetryAt: 2_000 },
      { ...request, attempt: 2, nextRetryAt: 3_000 },
    ],
  ]

  it.each(invalidQueues.map((raw): [unknown] => [raw]))(
    'fails closed on invalid queue: %#',
    (raw) => {
      expect(decodeInterruptRetryQueue(raw)).toMatchObject({ ok: false, retries: [] })
    },
  )
})
