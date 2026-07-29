import { describe, expect, it } from 'vitest'
import { isJsonWithinByteBudget, measureJsonBytes } from './json-budget'

const encodedBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength

describe('measureJsonBytes', () => {
  it('matches JSON.stringify UTF-8 bytes for safe fixtures', () => {
    const fixtures: ReadonlyArray<unknown> = [
      null,
      true,
      false,
      0,
      -0,
      1.25e-7,
      1e21,
      '',
      'plain',
      'quote " slash \\ tab\t newline\n control\u001f',
      'emoji 😀 CJK 漢 lone-high \ud800 lone-low \udc00',
      [],
      {},
      [null, true, 'x', { nested: ['😀', 3] }],
      { 'odd key\n': 'value', nested: { array: [1, 2, 3] } },
      Object.assign(Object.create(null), { safe: 'null prototype' }),
    ]
    for (const value of fixtures) {
      const expected = encodedBytes(value)
      expect(measureJsonBytes(value, expected)).toBe(expected)
      expect(measureJsonBytes(value, expected - 1)).toBeUndefined()
      expect(isJsonWithinByteBudget(value, expected)).toBe(true)
    }
  })

  it('matches randomized generated JSON', () => {
    let state = 0x9e3779b9
    const next = (): number => {
      state = (state * 1664525 + 1013904223) >>> 0
      return state
    }
    const text = (): string =>
      ['a', '😀', '\n', '\u001f', '\ud800', '漢'][next() % 6]!.repeat(next() % 4)
    const value = (depth: number): unknown => {
      if (depth === 0 || next() % 3 === 0) {
        return [null, next() % 2 === 0, (next() % 10000) / 100, text()][next() % 4]
      }
      if (next() % 2 === 0) return Array.from({ length: next() % 4 }, () => value(depth - 1))
      const result: Record<string, unknown> = {}
      for (let index = 0; index < next() % 4; index += 1)
        result[`${text()}-${index}`] = value(depth - 1)
      return result
    }
    for (let index = 0; index < 200; index += 1) {
      const candidate = value(4)
      expect(measureJsonBytes(candidate, encodedBytes(candidate))).toBe(encodedBytes(candidate))
    }
  })

  it('fails closed for invalid budgets and unsupported values', () => {
    expect(measureJsonBytes('x', -1)).toBeUndefined()
    expect(measureJsonBytes('x', 1.5)).toBeUndefined()
    expect(measureJsonBytes('x', Number.MAX_SAFE_INTEGER + 1)).toBeUndefined()
    for (const value of [undefined, Infinity, NaN, 1n, Symbol('x'), () => undefined]) {
      expect(measureJsonBytes(value, 100)).toBeUndefined()
    }
  })

  it('rejects cycles, sparse arrays, accessors, symbols, and impure records', () => {
    const cycle: { self?: unknown } = {}
    cycle.self = cycle
    const sparse: string[] = Array(3)
    sparse[0] = 'a'
    sparse[2] = 'b'
    let getterRead = false
    const accessor = Object.defineProperty({}, 'x', {
      enumerable: true,
      get: () => {
        getterRead = true
        return 'nope'
      },
    })
    const toJson = { toJSON: () => ({}) }
    const symbolKey = { [Symbol('x')]: 1 }
    const nonEnumerable = Object.defineProperty({}, 'x', { value: 1 })
    class Impure {
      readonly value = 1
    }
    for (const value of [cycle, sparse, accessor, toJson, symbolKey, nonEnumerable, new Impure()]) {
      expect(measureJsonBytes(value, 100)).toBeUndefined()
    }
    expect(getterRead).toBe(false)
  })

  it('rejects proxied arrays without invoking get traps', () => {
    let gets = 0
    const value = new Proxy([1], {
      get: () => {
        gets += 1
        throw new Error('must not execute')
      },
    })

    expect(measureJsonBytes(value, 3)).toBeUndefined()
    expect(gets).toBe(0)
  })

  it('rejects inherited toJSON without invoking it', () => {
    let calls = 0
    const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON')
    // oxlint-disable-next-line no-extend-native -- verifies inherited JSON hooks fail closed.
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      value: () => {
        calls += 1
        return 'wrong'
      },
    })
    try {
      expect(measureJsonBytes({ safe: true }, 100)).toBeUndefined()
      expect(measureJsonBytes([true], 100)).toBeUndefined()
      expect(calls).toBe(0)
    } finally {
      if (descriptor === undefined) delete (Object.prototype as { toJSON?: unknown }).toJSON
      // oxlint-disable-next-line no-extend-native -- restores the exact intrinsic descriptor.
      else Object.defineProperty(Object.prototype, 'toJSON', descriptor)
    }
  })

  it('rejects own accessors without invoking them', () => {
    let calls = 0
    const value = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => {
        calls += 1
        return 'wrong'
      },
    })
    expect(measureJsonBytes(value, 100)).toBeUndefined()
    expect(calls).toBe(0)
  })

  it('stops before it reads later values once over budget', () => {
    let read = false
    const value = ['x'.repeat(100), 1] as unknown[]
    Object.defineProperty(value, '1', {
      enumerable: true,
      get: () => {
        read = true
        return 1
      },
    })
    expect(measureJsonBytes(value, 10)).toBeUndefined()
    expect(read).toBe(false)
  })

  it('fails closed for deep or hostile objects without throwing', () => {
    let deep: unknown = null
    for (let index = 0; index < 129; index += 1) deep = [deep]
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error('trap')
        },
      },
    )
    expect(() => measureJsonBytes(deep, 10_000)).not.toThrow()
    expect(measureJsonBytes(deep, 10_000)).toBeUndefined()
    expect(() => measureJsonBytes(hostile, 100)).not.toThrow()
    expect(measureJsonBytes(hostile, 100)).toBeUndefined()
  })
})
