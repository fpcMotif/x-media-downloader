import { describe, expect, it } from 'vitest'
import { decodeUploadedKeys, rememberUploaded } from '../uploaded-set'

describe('uploaded-set', () => {
  it('decodeUploadedKeys falls back to empty on null and invalid payloads', () => {
    expect(decodeUploadedKeys(null)).toEqual([])
    expect(decodeUploadedKeys('x')).toEqual([])
  })

  it('decodeUploadedKeys decodes a valid string array', () => {
    expect(decodeUploadedKeys(['a', 'b'])).toEqual(['a', 'b'])
  })

  it('rememberUploaded returns the same reference when all keys are already known', () => {
    const keys = ['a']
    expect(rememberUploaded(keys, ['a'])).toBe(keys)
  })

  it('rememberUploaded appends only unseen unique keys in order', () => {
    expect(rememberUploaded(['a'], ['b', 'b', 'a'])).toEqual(['a', 'b'])
  })

  it('rememberUploaded drops oldest keys when exceeding the cap', () => {
    expect(rememberUploaded(['a', 'b'], ['c'], 2)).toEqual(['b', 'c'])
  })
})
