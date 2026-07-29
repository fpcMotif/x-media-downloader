import { describe, expect, it } from 'vitest'
import { makeDailyBudgetClient } from './daily-budget-client'

const usage = { day: '2026-07-22', bytes: 123, count: 2 } as const

describe('daily budget client', () => {
  it('sends exact read/reset messages and returns only public usage', async () => {
    const requests: unknown[] = []
    const client = makeDailyBudgetClient(async (request) => {
      requests.push(request)
      if (request._tag === 'DailyBudgetReadRequest') {
        return { _tag: 'DailyBudgetReadSuccess', usage }
      }
      return { _tag: 'DailyBudgetResetSuccess', usage: { ...usage, bytes: 0, count: 0 } }
    })

    await expect(client.readToday()).resolves.toEqual({ status: 'available', usage })
    await expect(client.resetToday()).resolves.toEqual({
      status: 'available',
      usage: { ...usage, bytes: 0, count: 0 },
    })
    expect(requests).toEqual([
      { _tag: 'DailyBudgetReadRequest' },
      { _tag: 'DailyBudgetResetRequest' },
    ])
  })

  it.each([
    undefined,
    { _tag: 'DailyBudgetUnavailable' },
    { _tag: 'DailyBudgetReadSuccess', usage: { ...usage, creditedReceiptIds: ['private'] } },
    { _tag: 'DailyBudgetResetSuccess', usage: { ...usage, resetAt: 1 } },
    { _tag: 'DailyBudgetReadSuccess', usage: { ...usage, bytes: -1 } },
  ])('maps unavailable or malformed replies to unavailable: %o', async (reply) => {
    const client = makeDailyBudgetClient(async () => reply)
    await expect(client.readToday()).resolves.toEqual({ status: 'unavailable' })
    await expect(client.resetToday()).resolves.toEqual({ status: 'unavailable' })
  })

  it('contains send failures', async () => {
    const client = makeDailyBudgetClient(() => Promise.reject(new Error('background unavailable')))
    await expect(client.readToday()).resolves.toEqual({ status: 'unavailable' })
  })
})
