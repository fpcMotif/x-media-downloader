import { describe, expect, it } from 'vitest'
import { utf8ByteLengthAtMost } from './utf8'

describe('utf8ByteLengthAtMost', () => {
  it('matches TextEncoder, including lone surrogates', () => {
    const value = 'a¢€😀\ud800'
    const bytes = new TextEncoder().encode(value).byteLength
    expect(utf8ByteLengthAtMost(value, bytes)).toBe(bytes)
    expect(utf8ByteLengthAtMost(value, bytes - 1)).toBeUndefined()
  })

  it('rejects invalid budgets', () => {
    expect(utf8ByteLengthAtMost('a', -1)).toBeUndefined()
    expect(utf8ByteLengthAtMost('a', 1.5)).toBeUndefined()
  })
})
