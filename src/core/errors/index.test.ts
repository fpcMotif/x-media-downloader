import { describe, it, expect } from 'vitest'
import { Aria2RpcError, OffscreenSaveError } from './index'
import { errorReason } from '../error'

describe('tagged errors', () => {
  it('Aria2RpcError carries tag, message, optional code, and is an Error', () => {
    const e = new Aria2RpcError({ message: 'boom', code: 1 })
    expect(e._tag).toBe('Aria2RpcError')
    expect(e.message).toBe('boom')
    expect(e.code).toBe(1)
    expect(e).toBeInstanceOf(Error)
    expect(errorReason(e)).toBe('boom')
  })

  it('OffscreenSaveError carries tag and message', () => {
    const e = new OffscreenSaveError({ message: 'no document' })
    expect(e._tag).toBe('OffscreenSaveError')
    expect(errorReason(e)).toBe('no document')
  })
})
