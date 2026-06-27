import { describe, it, expect } from 'vitest'
import { makeDailyBudgetStore, type BudgetStorage } from './daily-budget-store'
import { localDay, type BudgetRecord } from '../core/download/daily-budget'

function fakeStorage(
  initial: BudgetRecord | null = null,
): BudgetStorage & { value: BudgetRecord | null } {
  const box = {
    value: initial,
    async get() {
      return box.value
    },
    async set(record: BudgetRecord) {
      box.value = record
    },
  }
  return box
}

const NOW = Date.UTC(2026, 5, 27, 12, 0, 0)
const TODAY = localDay(NOW)

describe('makeDailyBudgetStore', () => {
  it('readToday returns a zeroed tally when storage is empty', async () => {
    const storage = fakeStorage(null)
    const store = makeDailyBudgetStore({ storage, now: () => NOW })

    const res = await store.readToday()

    expect(res).toEqual({ bytes: 0, count: 0, day: TODAY })
    expect(storage.value).toEqual({ day: TODAY, bytes: 0, count: 0 })
  })

  it('readToday resets a stale stored record and persists the reset', async () => {
    const storage = fakeStorage({ day: '2020-01-01', bytes: 999, count: 7 })
    const store = makeDailyBudgetStore({ storage, now: () => NOW })

    const res = await store.readToday()

    expect(res).toEqual({ bytes: 0, count: 0, day: TODAY })
    expect(storage.value).toEqual({ day: TODAY, bytes: 0, count: 0 })
  })

  it('recordCompletion accumulates and persists summed bytes and count', async () => {
    const storage = fakeStorage({ day: TODAY, bytes: 0, count: 0 })
    const store = makeDailyBudgetStore({ storage, now: () => NOW })

    await store.recordCompletion(100, 1)
    await store.recordCompletion(250, 1)

    expect(storage.value).toEqual({ day: TODAY, bytes: 350, count: 2 })
  })

  it('resetToday zeroes the stored tally for today', async () => {
    const storage = fakeStorage({ day: TODAY, bytes: 500, count: 3 })
    const store = makeDailyBudgetStore({ storage, now: () => NOW })

    await store.resetToday()

    expect(storage.value).toEqual({ day: TODAY, bytes: 0, count: 0 })
  })
})
