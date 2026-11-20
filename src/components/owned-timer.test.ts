import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeOwnedTimer } from './owned-timer'

describe('makeOwnedTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs an armed callback once its delay passes', () => {
    const timer = makeOwnedTimer()
    const fn = vi.fn<() => void>()
    timer.arm(fn, 100)
    vi.advanceTimersByTime(99)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('cancels the pending callback when rearmed, so the latest arm wins', () => {
    const timer = makeOwnedTimer()
    const first = vi.fn<() => void>()
    const second = vi.fn<() => void>()
    timer.arm(first, 100)
    vi.advanceTimersByTime(50)
    timer.arm(second, 100)
    vi.advanceTimersByTime(100)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('lets a running callback arm the next step', () => {
    const timer = makeOwnedTimer()
    const last = vi.fn<() => void>()
    timer.arm(() => timer.arm(last, 50), 100)
    vi.advanceTimersByTime(150)
    expect(last).toHaveBeenCalledTimes(1)
  })

  it('cancel drops the pending callback', () => {
    const timer = makeOwnedTimer()
    const fn = vi.fn<() => void>()
    timer.arm(fn, 100)
    timer.cancel()
    vi.advanceTimersByTime(200)
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('useOwnedTimer', () => {
  const source = readFileSync(fileURLToPath(import.meta.resolve('./owned-timer.ts')), 'utf8')

  it('creates one timer per mount and cancels it on unmount', () => {
    expect(source).toContain('useState(makeOwnedTimer)')
    expect(source).toContain('useEffect(() => timer.cancel, [timer])')
  })
})
