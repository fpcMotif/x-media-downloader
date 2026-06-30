import { describe, it, expect } from 'vitest'
import { localDay, freshRecord, addCompletion, type BudgetRecord } from './daily-budget'

// A fixed instant; "today" is whatever localDay maps it to (timezone-agnostic).
const NOW = Date.UTC(2026, 5, 27, 12, 0, 0) // 2026-06-27T12:00:00Z
const TODAY = localDay(NOW)
const NEXT_DAY = NOW + 24 * 60 * 60 * 1000 // a clock ~24h later
const TOMORROW = localDay(NEXT_DAY)

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

describe('freshRecord', () => {
  it('resets a null record to today at zero', () => {
    expect(freshRecord(null, NOW)).toEqual({ day: TODAY, bytes: 0, count: 0 })
  })

  it('resets a stale-day record to today at zero (discards prior totals)', () => {
    const stale: BudgetRecord = { day: 'never-a-real-today', bytes: 9_999, count: 42 }
    expect(freshRecord(stale, NOW)).toEqual({ day: TODAY, bytes: 0, count: 0 })
  })

  it('returns the same-day record unchanged', () => {
    const todays: BudgetRecord = { day: TODAY, bytes: 100, count: 2 }
    expect(freshRecord(todays, NOW)).toEqual(todays)
  })
})

describe('addCompletion', () => {
  it('seeds from a null record and counts only the new completion', () => {
    expect(addCompletion(null, NOW, 500, 1)).toEqual({ day: TODAY, bytes: 500, count: 1 })
  })

  it('accumulates bytes and count on the same day; day is unchanged', () => {
    const todays: BudgetRecord = { day: TODAY, bytes: 200, count: 3 }
    expect(addCompletion(todays, NOW, 50, 1)).toEqual({ day: TODAY, bytes: 250, count: 4 })
  })

  it('discards a previous day and counts only the new completion on the next day', () => {
    const yesterday: BudgetRecord = { day: TODAY, bytes: 1_000, count: 7 }
    expect(addCompletion(yesterday, NEXT_DAY, 300, 1)).toEqual({
      day: TOMORROW,
      bytes: 300,
      count: 1,
    })
  })

  it('does not mutate the input record', () => {
    const todays: BudgetRecord = { day: TODAY, bytes: 10, count: 1 }
    addCompletion(todays, NOW, 5, 1)
    expect(todays).toEqual({ day: TODAY, bytes: 10, count: 1 })
  })
})
