import { describe, it, expect } from 'vitest'
import { expBackoffMs, fullJitterMs } from '../backoff'

const POLICY = { baseMs: 1000, capMs: 8000 }

describe('expBackoffMs', () => {
  it('treats attempt 0 as the first retry and doubles from the base', () => {
    expect(expBackoffMs(0, POLICY)).toBe(1000)
    expect(expBackoffMs(1, POLICY)).toBe(2000)
    expect(expBackoffMs(2, POLICY)).toBe(4000)
  })

  it('truncates at the cap and stays there', () => {
    expect(expBackoffMs(3, POLICY)).toBe(8000)
    expect(expBackoffMs(4, POLICY)).toBe(8000)
    expect(expBackoffMs(100, POLICY)).toBe(8000)
  })

  it('clamps a negative attempt to the base rather than returning a shorter delay', () => {
    expect(expBackoffMs(-1, POLICY)).toBe(1000)
    expect(expBackoffMs(-100, POLICY)).toBe(1000)
  })
})

describe('fullJitterMs', () => {
  it('returns 0 when random yields 0', () => {
    expect(fullJitterMs(1000, () => 0)).toBe(0)
  })

  it('scales linearly with the random source', () => {
    expect(fullJitterMs(1000, () => 0.5)).toBe(500)
  })

  it('stays below delayMs when random approaches 1', () => {
    expect(fullJitterMs(1000, () => 0.999999)).toBeLessThan(1000)
  })
})
