import { describe, expect, it } from 'vitest'
import { hasWireKeys, isWireRecord, readWireDataProperty, readWireTag } from './exact'

describe('exact wire guards', () => {
  it('fails closed for revoked or trap-throwing proxies', () => {
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('trap')
        },
      },
    )

    expect(isWireRecord(revoked.proxy)).toBe(false)
    expect(readWireTag(revoked.proxy)).toBeUndefined()
    expect(hasWireKeys(hostile, [])).toBe(false)
  })

  it('reads own data without invoking getters', () => {
    let gets = 0
    const value = new Proxy(
      { _tag: 'Safe', item: 1 },
      {
        get: () => {
          gets += 1
          throw new Error('must not execute')
        },
      },
    )

    expect(readWireTag(value)).toBe('Safe')
    expect(readWireDataProperty(value, 'item')).toEqual({ value: 1 })
    expect(gets).toBe(0)
  })
})
