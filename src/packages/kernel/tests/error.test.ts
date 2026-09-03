import { describe, it, expect } from 'vitest'
import { errorReason } from '../error'

describe('errorReason', () => {
  it('uses the message of an Error', () => {
    expect(errorReason(new Error('boom'))).toBe('boom')
  })

  it('preserves a subclass error message', () => {
    class MyError extends Error {}
    expect(errorReason(new MyError('nope'))).toBe('nope')
  })

  it('passes a string reason through unchanged', () => {
    expect(errorReason('raw string')).toBe('raw string')
  })
})
