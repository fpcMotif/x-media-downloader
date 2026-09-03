import { describe, it, expect } from 'vitest'
import {
  INTERRUPT_RETRY_MAX,
  interruptBackoffMs,
  isRetryableInterruptReason,
  planInterruptRetry,
} from '../interrupt-retry'

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
  it('counts attempts 0-based and doubles the base delay (2s → 4s → 8s)', () => {
    expect(interruptBackoffMs(0)).toBe(2000)
    expect(interruptBackoffMs(1)).toBe(4000)
    expect(interruptBackoffMs(2)).toBe(8000)
  })

  it('holds at the last delay INTERRUPT_RETRY_MAX allows instead of doubling forever', () => {
    // The reachable ladder ends at attempt INTERRUPT_RETRY_MAX - 1; past it the
    // ceiling is stated rather than left to the caller's max to imply.
    expect(interruptBackoffMs(INTERRUPT_RETRY_MAX - 1)).toBe(8000)
    expect(interruptBackoffMs(INTERRUPT_RETRY_MAX)).toBe(8000)
    expect(interruptBackoffMs(20)).toBe(8000)
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

  it('bounds the delay when maxRetries is raised past the default ladder', () => {
    // The override is the only way to reach an attempt the default policy never
    // sizes a delay for; an uncapped ladder would put attempt 9 at ~17 minutes.
    expect(planInterruptRetry({ reason: 'NETWORK_FAILED', attempt: 9, maxRetries: 12 })).toEqual({
      schedule: true,
      delayMs: 8000,
      nextAttempt: 10,
    })
  })
})
