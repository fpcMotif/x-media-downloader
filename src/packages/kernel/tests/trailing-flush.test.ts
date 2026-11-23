import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTrailingFlush } from '../trailing-flush'

const DELAY_MS = 250

describe('makeTrailingFlush', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('flushes once for many requests in one window', () => {
    const flush = vi.fn<() => void>()
    const trailing = makeTrailingFlush(flush, DELAY_MS)

    for (let i = 0; i < 5; i += 1) trailing.request()
    vi.advanceTimersByTime(DELAY_MS)

    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('does not slide the window on later requests', () => {
    const flush = vi.fn<() => void>()
    const trailing = makeTrailingFlush(flush, DELAY_MS)

    trailing.request()
    vi.advanceTimersByTime(200)
    trailing.request()
    vi.advanceTimersByTime(50)

    expect(flush).toHaveBeenCalledTimes(1)

    trailing.request()
    vi.advanceTimersByTime(DELAY_MS)

    expect(flush).toHaveBeenCalledTimes(2)
  })

  it('drops a pending flush on cancel and still flushes a later request', () => {
    const flush = vi.fn<() => void>()
    const trailing = makeTrailingFlush(flush, DELAY_MS)

    trailing.request()
    trailing.cancel()
    vi.advanceTimersByTime(DELAY_MS)

    expect(flush).toHaveBeenCalledTimes(0)

    trailing.request()
    vi.advanceTimersByTime(DELAY_MS)

    expect(flush).toHaveBeenCalledTimes(1)
  })
})
