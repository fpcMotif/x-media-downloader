import { describe, it, expect } from 'vitest'
import {
  INTERRUPT_RETRY_MAX,
  interruptBackoffMs,
  isRetryableInterruptReason,
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
    expect(
      planInterruptRetry({ reason: 'NETWORK_FAILED', attempt: INTERRUPT_RETRY_MAX }),
    ).toEqual({ schedule: false })
  })

  it('does not schedule for non-retryable interrupt reasons', () => {
    expect(planInterruptRetry({ reason: 'SERVER_FORBIDDEN', attempt: 0 })).toEqual({
      schedule: false,
    })
  })
})
