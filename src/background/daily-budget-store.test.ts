import { describe, expect, it } from 'vitest'
import { makeDailyBudgetStore, type BudgetStorage } from './daily-budget-store'
import {
  encodeBudgetRecord,
  hasBudgetReceiptHeadroom,
  isBudgetRecordWithinBounds,
  localDay,
  MAX_DAILY_BUDGET_RECEIPTS,
  MAX_RECEIPT_ID_LENGTH,
  type BudgetRecord,
} from '../core/download/daily-budget'

function fakeStorage(initial: unknown = null): BudgetStorage & { value: unknown; writes: number } {
  const box = {
    value: initial,
    writes: 0,
    async get() {
      return box.value
    },
    async set(record: Parameters<BudgetStorage['set']>[0]) {
      box.value = record
      box.writes += 1
    },
  }
  return box
}

const NOW = Date.UTC(2026, 5, 27, 12, 0, 0)
const TODAY = localDay(NOW)
const NEXT_DAY = NOW + 24 * 60 * 60 * 1000
const v1 = (record: BudgetRecord) => encodeBudgetRecord(record)
const recordWithoutByteHeadroom = (): BudgetRecord => {
  const candidate = (receiptCount: number): BudgetRecord => ({
    day: TODAY,
    bytes: 0,
    count: 0,
    creditedReceiptIds: Array.from({ length: receiptCount }, (_, index) => {
      const prefix = `${index}:`
      return prefix + '\0'.repeat(MAX_RECEIPT_ID_LENGTH - prefix.length)
    }),
    resetAt: 0,
  })
  let lower = 0
  let upper = MAX_DAILY_BUDGET_RECEIPTS
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2)
    if (isBudgetRecordWithinBounds(candidate(middle))) lower = middle
    else upper = middle - 1
  }
  const record = candidate(lower)
  expect(isBudgetRecordWithinBounds(record)).toBe(true)
  expect(hasBudgetReceiptHeadroom(record)).toBe(false)
  return record
}

describe('makeDailyBudgetStore', () => {
  it('readToday returns a zeroed tally when storage is empty', async () => {
    const storage = fakeStorage(null)
    const store = makeDailyBudgetStore({ storage, now: () => NOW })

    const res = await store.readToday()

    expect(res).toEqual({ bytes: 0, count: 0, day: TODAY })
    expect(storage.value).toEqual(
      v1({
        day: TODAY,
        bytes: 0,
        count: 0,
        creditedReceiptIds: [],
        resetAt: 0,
      }),
    )
  })

  it('readToday resets a stale stored record and persists the reset', async () => {
    const storage = fakeStorage({ day: '2020-01-01', bytes: 999, count: 7 })
    const store = makeDailyBudgetStore({ storage, now: () => NOW })

    const res = await store.readToday()

    expect(res).toEqual({ bytes: 0, count: 0, day: TODAY })
    expect(storage.value).toEqual(
      v1({
        day: TODAY,
        bytes: 0,
        count: 0,
        creditedReceiptIds: [],
        resetAt: 0,
      }),
    )
  })

  it('migrates a legacy record and credits each stable receipt once', async () => {
    const storage = fakeStorage({ day: TODAY, bytes: 0, count: 0 })
    const store = makeDailyBudgetStore({ storage, now: () => NOW })

    await store.recordCompletion('download-a', NOW, 100, 1)
    await store.recordCompletion('download-a', NOW, 100, 1)
    await store.recordCompletion('download-b', NOW, 250, 1)

    expect(storage.value).toEqual(
      v1({
        day: TODAY,
        bytes: 350,
        count: 2,
        creditedReceiptIds: ['download-a', 'download-b'],
        resetAt: 0,
      }),
    )
  })

  it('migrates the intermediate unversioned receipt record on read', async () => {
    const intermediate = {
      day: TODAY,
      bytes: 25,
      count: 2,
      creditedReceiptIds: ['download-a'],
      resetAt: NOW - 1,
    }
    const storage = fakeStorage(intermediate)
    const store = makeDailyBudgetStore({ storage, now: () => NOW })

    await expect(store.readToday()).resolves.toEqual({ day: TODAY, bytes: 25, count: 2 })
    expect(storage.value).toEqual(v1(intermediate))
    expect(storage.writes).toBe(1)
  })

  it('credits fresh storage with one durable write', async () => {
    const storage = fakeStorage(null)
    const store = makeDailyBudgetStore({ storage, now: () => NOW })

    await store.recordCompletion('download-a', NOW, 100, 1)

    expect(storage.writes).toBe(1)
    expect(storage.value).toEqual(
      v1({
        day: TODAY,
        bytes: 100,
        count: 1,
        creditedReceiptIds: ['download-a'],
        resetAt: 0,
      }),
    )
  })

  it('resetToday zeroes the stored tally for today', async () => {
    const storage = fakeStorage({
      day: TODAY,
      bytes: 500,
      count: 3,
      creditedReceiptIds: ['download-a'],
      resetAt: 0,
    })
    const store = makeDailyBudgetStore({ storage, now: () => NOW })

    await expect(store.resetToday()).resolves.toEqual({ day: TODAY, bytes: 0, count: 0 })

    expect(storage.value).toEqual(
      v1({
        day: TODAY,
        bytes: 0,
        count: 0,
        creditedReceiptIds: [],
        resetAt: NOW,
      }),
    )
  })

  it('preserves malformed same-day state until an explicit reset', async () => {
    const malformed = {
      day: TODAY,
      bytes: Infinity,
      count: -1,
      creditedReceiptIds: ['kept', '', 'kept', 42],
      resetAt: 0,
    }
    const storage = fakeStorage(malformed)
    const store = makeDailyBudgetStore({ storage, now: () => NOW })

    await expect(store.readToday()).rejects.toThrow('corrupt')
    await expect(store.recordCompletion('download-a', NOW, 1, 1)).rejects.toThrow('corrupt')
    expect(storage.value).toBe(malformed)

    await expect(store.resetToday()).resolves.toEqual({ day: TODAY, bytes: 0, count: 0 })
    expect(storage.value).toEqual(
      v1({
        day: TODAY,
        bytes: 0,
        count: 0,
        creditedReceiptIds: [],
        resetAt: NOW,
      }),
    )
  })

  it('does not relabel a malformed old-day record as a safe stale reset', async () => {
    const malformed = {
      day: '2020-01-01',
      bytes: -1,
      count: 1,
      creditedReceiptIds: [],
      resetAt: 0,
    }
    const storage = fakeStorage(malformed)
    const store = makeDailyBudgetStore({ storage, now: () => NOW })

    await expect(store.readToday()).rejects.toThrow('corrupt')
    await expect(store.recordCompletion('download-a', NOW, 1, 1)).rejects.toThrow('corrupt')
    expect(storage.value).toBe(malformed)
  })

  it('rejects a new receipt at the exact receipt cap without changing state', async () => {
    const full = {
      day: TODAY,
      bytes: 1,
      count: 1,
      creditedReceiptIds: Array.from(
        { length: MAX_DAILY_BUDGET_RECEIPTS },
        (_, index) => `receipt-${index}`,
      ),
      resetAt: 0,
    }
    const encodedFull = v1(full)
    const storage = fakeStorage(encodedFull)
    const store = makeDailyBudgetStore({ storage, now: () => NOW })

    await expect(store.readToday()).resolves.toEqual({ day: TODAY, bytes: 1, count: 1 })
    await expect(store.readTodayForAdmission()).rejects.toThrow('capacity')
    await expect(store.recordCompletion('receipt-0', NOW, 1, 1)).resolves.toBeUndefined()
    await expect(store.recordCompletion('new-receipt', NOW, 1, 1)).rejects.toThrow('capacity')
    expect(storage.value).toBe(encodedFull)

    await store.resetToday()
    await store.recordCompletion('fresh', NOW + 1, 2, 1)
    expect(storage.value).toEqual(
      v1({
        day: TODAY,
        bytes: 2,
        count: 1,
        creditedReceiptIds: ['fresh'],
        resetAt: NOW,
      }),
    )
  })

  it('keeps excess in-flight terminals pending until reset can fence their replay', async () => {
    let clock = NOW
    const storage = fakeStorage(
      v1({
        day: TODAY,
        bytes: 0,
        count: 0,
        creditedReceiptIds: Array.from(
          { length: MAX_DAILY_BUDGET_RECEIPTS - 1 },
          (_, index) => `receipt-${index}`,
        ),
        resetAt: 0,
      }),
    )
    const store = makeDailyBudgetStore({ storage, now: () => clock })

    await store.recordCompletion('fills-capacity', NOW, 1, 1)
    await expect(store.recordCompletion('pending-terminal', NOW + 1, 1, 1)).rejects.toThrow(
      'capacity',
    )
    await expect(store.readTodayForAdmission()).rejects.toThrow('capacity')

    clock = NOW + 2
    await store.resetToday()
    await expect(store.recordCompletion('pending-terminal', NOW + 1, 1, 1)).resolves.toBeUndefined()
    await expect(store.readTodayForAdmission()).resolves.toEqual({
      day: TODAY,
      bytes: 0,
      count: 0,
    })
  })

  it('fails admission closed when byte capacity cannot hold another receipt', async () => {
    const full = recordWithoutByteHeadroom()
    const storage = fakeStorage(v1(full))
    const store = makeDailyBudgetStore({ storage, now: () => NOW })

    await expect(store.readToday()).resolves.toEqual({
      day: TODAY,
      bytes: full.bytes,
      count: full.count,
    })
    await expect(store.readTodayForAdmission()).rejects.toThrow('capacity')
  })

  it('recovers full receipt capacity on local-day rollover', async () => {
    let clock = NOW
    const storage = fakeStorage(
      v1({
        day: TODAY,
        bytes: 1,
        count: 1,
        creditedReceiptIds: Array.from(
          { length: MAX_DAILY_BUDGET_RECEIPTS },
          (_, index) => `receipt-${index}`,
        ),
        resetAt: 0,
      }),
    )
    const store = makeDailyBudgetStore({ storage, now: () => clock })

    await expect(store.readTodayForAdmission()).rejects.toThrow('capacity')
    clock = NEXT_DAY
    await expect(store.readTodayForAdmission()).resolves.toEqual({
      day: localDay(NEXT_DAY),
      bytes: 0,
      count: 0,
    })
  })

  it('rejects invalid input and storage failures, then permits an idempotent retry', async () => {
    let value: unknown = v1({
      day: TODAY,
      bytes: 0,
      count: 0,
      creditedReceiptIds: [],
      resetAt: 0,
    })
    let fail = true
    const storage: BudgetStorage = {
      get: async () => value,
      set: async (record) => {
        if (fail) {
          fail = false
          throw new Error('quota')
        }
        value = record
      },
    }
    const store = makeDailyBudgetStore({ storage, now: () => NOW })

    await expect(store.recordCompletion('', NOW, 1, 1)).rejects.toThrow('receiptId')
    await expect(store.recordCompletion('download-a', NOW, -1, 1)).rejects.toThrow('non-negative')
    await expect(store.recordCompletion('download-a', NOW, 1, 1)).rejects.toThrow('quota')
    await store.recordCompletion('download-a', NOW, 1, 1)
    await store.recordCompletion('download-a', NOW, 1, 1)

    expect(value).toEqual(
      v1({
        day: TODAY,
        bytes: 1,
        count: 1,
        creditedReceiptIds: ['download-a'],
        resetAt: 0,
      }),
    )
  })

  it('serializes a concurrent credit and reset in call order', async () => {
    const storage = fakeStorage(
      v1({
        day: TODAY,
        bytes: 0,
        count: 0,
        creditedReceiptIds: [],
        resetAt: 0,
      }),
    )
    const store = makeDailyBudgetStore({ storage, now: () => NOW })

    await Promise.all([store.recordCompletion('download-a', NOW, 100, 1), store.resetToday()])
    await expect(store.readToday()).resolves.toEqual({ day: TODAY, bytes: 0, count: 0 })

    await Promise.all([store.resetToday(), store.recordCompletion('download-b', NOW + 1, 250, 1)])
    await expect(store.readToday()).resolves.toEqual({ day: TODAY, bytes: 250, count: 1 })
  })

  it('does not credit terminals from a prior or future local day', async () => {
    const storage = fakeStorage(null)
    const store = makeDailyBudgetStore({ storage, now: () => NEXT_DAY })

    await store.recordCompletion('yesterday', NOW, 100, 1)
    await store.recordCompletion('tomorrow', NEXT_DAY + 24 * 60 * 60 * 1000, 100, 1)

    await expect(store.readToday()).resolves.toEqual({
      day: localDay(NEXT_DAY),
      bytes: 0,
      count: 0,
    })
  })

  it('clears receipts on reset while resetAt fences an older replay', async () => {
    const storage = fakeStorage(null)
    const store = makeDailyBudgetStore({ storage, now: () => NOW })

    await store.recordCompletion('download-a', NOW - 1, 100, 1)
    await store.resetToday()
    await store.recordCompletion('download-a', NOW - 1, 100, 1)

    await expect(store.readToday()).resolves.toEqual({ day: TODAY, bytes: 0, count: 0 })
    expect(storage.value).toEqual(
      v1({
        day: TODAY,
        bytes: 0,
        count: 0,
        creditedReceiptIds: [],
        resetAt: NOW,
      }),
    )
  })

  it('never weakens the reset fence when the wall clock moves backward', async () => {
    let clock = NOW
    const storage = fakeStorage(
      v1({
        day: TODAY,
        bytes: 0,
        count: 0,
        creditedReceiptIds: [],
        resetAt: NOW,
      }),
    )
    const store = makeDailyBudgetStore({ storage, now: () => clock })

    clock = NOW - 100
    await store.resetToday()
    await store.recordCompletion('older-terminal', NOW - 50, 100, 1)

    expect(storage.value).toEqual(
      v1({
        day: TODAY,
        bytes: 0,
        count: 0,
        creditedReceiptIds: [],
        resetAt: NOW,
      }),
    )
  })

  it('ignores a terminal at or before reset without consuming receipt capacity', async () => {
    const storage = fakeStorage(null)
    const store = makeDailyBudgetStore({ storage, now: () => NOW })

    await store.resetToday()
    await store.recordCompletion('before-reset', NOW - 1, 100, 1)

    expect(storage.value).toEqual(
      v1({
        day: TODAY,
        bytes: 0,
        count: 0,
        creditedReceiptIds: [],
        resetAt: NOW,
      }),
    )
  })

  it('saturates aggregate totals while retaining each receipt for replay safety', async () => {
    const storage = fakeStorage(
      v1({
        day: TODAY,
        bytes: Number.MAX_SAFE_INTEGER - 1,
        count: Number.MAX_SAFE_INTEGER - 1,
        creditedReceiptIds: [],
        resetAt: 0,
      }),
    )
    const store = makeDailyBudgetStore({ storage, now: () => NOW })

    await store.recordCompletion('at-limit', NOW, 2, 2)
    await store.recordCompletion('after-limit', NOW, 1, 1)
    await store.recordCompletion('at-limit', NOW, 2, 2)

    expect(storage.value).toEqual(
      v1({
        day: TODAY,
        bytes: Number.MAX_SAFE_INTEGER,
        count: Number.MAX_SAFE_INTEGER,
        creditedReceiptIds: ['at-limit', 'after-limit'],
        resetAt: 0,
      }),
    )

    await store.resetToday()
    await store.recordCompletion('after-limit', NOW, 1, 1)
    await expect(store.readToday()).resolves.toEqual({ day: TODAY, bytes: 0, count: 0 })
  })
})
