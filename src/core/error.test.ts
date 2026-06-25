import { describe, it, expect } from 'vitest'
import { errorReason } from './error'

describe('errorReason', () => {
  it('uses the message of an Error', () => {
    expect(errorReason(new Error('boom'))).toBe('boom')
  })

  it('preserves a subclass error message', () => {
    class MyError extends Error {}
    expect(errorReason(new MyError('nope'))).toBe('nope')
  })

  it('stringifies a thrown non-Error value', () => {
    expect(errorReason('raw string')).toBe('raw string')
    expect(errorReason(42)).toBe('42')
    expect(errorReason(undefined)).toBe('undefined')
    expect(errorReason(null)).toBe('null')
  })
})
