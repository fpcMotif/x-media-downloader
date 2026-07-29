import { describe, expect, it } from 'vitest'
import {
  DAILY_BUDGET_STORE_VERSION,
  decodeStoredBudgetRecord,
  encodeBudgetRecord,
  hasBudgetReceiptHeadroom,
  isBudgetRecordWithinBounds,
  localDay,
  MAX_DAILY_BUDGET_RECEIPTS,
  MAX_DAILY_BUDGET_STORE_BYTES,
  saturatingAdd,
  type BudgetRecord,
} from './daily-budget'
import { measureJsonBytes } from '../wire/json-budget'

// A fixed instant; "today" is whatever localDay maps it to (timezone-agnostic).
const NOW = Date.UTC(2026, 5, 27, 12, 0, 0) // 2026-06-27T12:00:00Z
const TODAY = localDay(NOW)

const stored = (record: BudgetRecord) => ({
  version: DAILY_BUDGET_STORE_VERSION,
  record,
})
const maximallyEscapedReceiptId = (ordinal: number): string => {
  const controls = [
    0, 1, 2, 3, 4, 5, 6, 7, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
  ]
  const units = Array<number>(256).fill(0)
  let remaining = ordinal
  for (let index = units.length - 1; remaining > 0; index -= 1) {
    units[index] = controls[remaining % controls.length]!
    remaining = Math.floor(remaining / controls.length)
  }
  return String.fromCharCode(...units)
}

const recordAtJsonBytes = (target: number): BudgetRecord => {
  let record: BudgetRecord = {
    day: TODAY,
    bytes: 0,
    count: 0,
    creditedReceiptIds: [],
    resetAt: 0,
  }
  for (;;) {
    const prefix = `${record.creditedReceiptIds.length}:`
    const receiptId = prefix + '\0'.repeat(256 - prefix.length)
    const next = { ...record, creditedReceiptIds: [...record.creditedReceiptIds, receiptId] }
    if (measureJsonBytes(stored(next), target) === undefined) break
    record = next
  }

  let current = measureJsonBytes(stored(record), target)!
  if (target - current < 4) {
    record = { ...record, creditedReceiptIds: record.creditedReceiptIds.slice(0, -1) }
    current = measureJsonBytes(stored(record), target)!
  }
  let remaining = target - current
  const additions = Math.ceil(remaining / 259)
  for (let index = 0; index < additions; index += 1) {
    const left = additions - index - 1
    const delta = Math.min(259, remaining - left * 4)
    const receiptId = String.fromCharCode(65 + index) + 'x'.repeat(delta - 4)
    record = { ...record, creditedReceiptIds: [...record.creditedReceiptIds, receiptId] }
    remaining -= delta
  }
  expect(remaining).toBe(0)
  expect(measureJsonBytes(stored(record), target)).toBe(target)
  return record
}

describe('localDay', () => {
  it('formats the local calendar day as YYYY-MM-DD', () => {
    expect(TODAY).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('zero-pads month and day to two digits', () => {
    const day = localDay(Date.UTC(2026, 0, 5, 12, 0, 0)) // Jan 5 around midday
    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    const [, month, dom] = day.split('-')
    expect(month).toHaveLength(2)
    expect(dom).toHaveLength(2)
  })
})

describe('saturatingAdd', () => {
  it('clamps an aggregate at the largest durable safe integer', () => {
    expect(saturatingAdd(Number.MAX_SAFE_INTEGER - 1, 2)).toBe(Number.MAX_SAFE_INTEGER)
  })
})

describe('decodeStoredBudgetRecord', () => {
  it('classifies absent, current, legacy, stale, and corrupt state', () => {
    const empty = {
      day: TODAY,
      bytes: 0,
      count: 0,
      creditedReceiptIds: [],
      resetAt: 0,
    }
    const current = { ...empty, bytes: 5, count: 1, creditedReceiptIds: ['receipt-1'] }

    expect(decodeStoredBudgetRecord(null, TODAY)).toEqual({ kind: 'absent', record: empty })
    expect(decodeStoredBudgetRecord(stored(current), TODAY)).toEqual({
      kind: 'current',
      record: current,
    })
    expect(decodeStoredBudgetRecord({ day: TODAY, bytes: 5, count: 1 }, TODAY)).toEqual({
      kind: 'legacy',
      record: { ...empty, bytes: 5, count: 1 },
    })
    expect(decodeStoredBudgetRecord(current, TODAY)).toEqual({
      kind: 'legacy',
      record: current,
    })
    expect(
      decodeStoredBudgetRecord(
        stored({
          day: '2020-01-01',
          bytes: 5,
          count: 1,
          creditedReceiptIds: [],
          resetAt: 0,
        }),
        TODAY,
      ),
    ).toEqual({ kind: 'stale', record: empty })
    expect(decodeStoredBudgetRecord(stored({ ...current, count: -1 }), TODAY)).toEqual({
      kind: 'corrupt',
    })
  })
})

describe('stored budget validation', () => {
  it('migrates only the exact legacy shape', () => {
    expect(decodeStoredBudgetRecord({ day: TODAY, bytes: 5, count: 1 }, TODAY)).toEqual({
      kind: 'legacy',
      record: {
        day: TODAY,
        bytes: 5,
        count: 1,
        creditedReceiptIds: [],
        resetAt: 0,
      },
    })
    const intermediate = {
      day: TODAY,
      bytes: 7,
      count: 2,
      creditedReceiptIds: ['receipt-1'],
      resetAt: 3,
    }
    expect(decodeStoredBudgetRecord(intermediate, TODAY)).toEqual({
      kind: 'legacy',
      record: intermediate,
    })
  })

  it('rejects malformed or extra-key records instead of inventing a zero tally', () => {
    expect(
      decodeStoredBudgetRecord(
        { day: TODAY, bytes: Infinity, count: 1, creditedReceiptIds: [], resetAt: 0, extra: true },
        TODAY,
      ),
    ).toEqual({ kind: 'corrupt' })
  })

  it('resets only an exact stale record; malformed stale input stays corrupt', () => {
    expect(
      decodeStoredBudgetRecord(
        {
          day: '2020-01-01',
          bytes: 5,
          count: 1,
          creditedReceiptIds: ['old'],
          resetAt: 0,
        },
        TODAY,
      ),
    ).toEqual({
      kind: 'stale',
      record: { day: TODAY, bytes: 0, count: 0, creditedReceiptIds: [], resetAt: 0 },
    })
    expect(
      decodeStoredBudgetRecord(
        {
          day: '2020-01-01',
          bytes: -1,
          count: 1,
          creditedReceiptIds: [],
          resetAt: 0,
        },
        TODAY,
      ),
    ).toEqual({ kind: 'corrupt' })
    expect(
      decodeStoredBudgetRecord(
        {
          day: '2020-99-99',
          bytes: 1,
          count: 1,
          creditedReceiptIds: [],
          resetAt: 0,
        },
        TODAY,
      ),
    ).toEqual({ kind: 'corrupt' })
  })

  it('accepts exactly the receipt cap and rejects one more', () => {
    const atCap = {
      day: TODAY,
      bytes: 0,
      count: 0,
      creditedReceiptIds: Array.from(
        { length: MAX_DAILY_BUDGET_RECEIPTS },
        (_, index) => `receipt-${index}`,
      ),
      resetAt: 0,
    }

    expect(decodeStoredBudgetRecord(stored(atCap), TODAY)).toEqual({
      kind: 'current',
      record: atCap,
    })
    expect(hasBudgetReceiptHeadroom(atCap)).toBe(false)
    expect(
      decodeStoredBudgetRecord(
        stored({
          ...atCap,
          creditedReceiptIds: [...atCap.creditedReceiptIds, 'one-too-many'],
        }),
        TODAY,
      ),
    ).toEqual({ kind: 'corrupt' })
  })

  it('accepts exactly the store-byte cap and rejects one byte over', () => {
    const atCap = recordAtJsonBytes(MAX_DAILY_BUDGET_STORE_BYTES)
    const overCap = {
      ...atCap,
      creditedReceiptIds: [...atCap.creditedReceiptIds, 'x'],
    }

    expect(measureJsonBytes(stored(atCap), MAX_DAILY_BUDGET_STORE_BYTES)).toBe(
      MAX_DAILY_BUDGET_STORE_BYTES,
    )
    expect(decodeStoredBudgetRecord(stored(atCap), TODAY)).toEqual({
      kind: 'current',
      record: atCap,
    })
    expect(measureJsonBytes(stored(overCap), MAX_DAILY_BUDGET_STORE_BYTES)).toBeUndefined()
    expect(decodeStoredBudgetRecord(stored(overCap), TODAY)).toEqual({ kind: 'corrupt' })
    expect(encodeBudgetRecord(atCap)).toEqual(stored(atCap))
  })

  it('reserves true worst-case JSON headroom for one more valid receipt', () => {
    const record: BudgetRecord = {
      day: TODAY,
      bytes: 0,
      count: 0,
      creditedReceiptIds: Array.from({ length: 1_362 }, (_, index) =>
        maximallyEscapedReceiptId(index),
      ),
      resetAt: 0,
    }
    const next = {
      ...record,
      bytes: Number.MAX_SAFE_INTEGER,
      count: Number.MAX_SAFE_INTEGER,
      creditedReceiptIds: [...record.creditedReceiptIds, maximallyEscapedReceiptId(1_362)],
    }

    expect(isBudgetRecordWithinBounds(record)).toBe(true)
    expect(isBudgetRecordWithinBounds(next)).toBe(false)
    expect(hasBudgetReceiptHeadroom(record)).toBe(false)
  })
})
