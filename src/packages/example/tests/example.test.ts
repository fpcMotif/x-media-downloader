import { describe, expect, it } from 'vitest'
import { formatPercent } from '../index'

describe('formatPercent', () => {
  it('formats an in-range value', () => {
    expect(formatPercent(42.5)).toBe('42.5%')
  })

  it('clamps out-of-range values', () => {
    expect(formatPercent(-3)).toBe('0.0%')
    expect(formatPercent(250)).toBe('100.0%')
  })

  it('treats NaN as zero', () => {
    expect(formatPercent(Number.NaN)).toBe('0.0%')
  })
})
