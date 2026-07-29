import { describe, expect, it } from 'vitest'
import { requestClearLog } from './log-client'

const record = {
  tweetId: '12345678901234567890',
  scope: 'bookmark',
  at: 42,
  mechanism: 'dom-click',
  permalink: 'https://x.com/i/status/12345678901234567890',
} as const

describe('requestClearLog', () => {
  it('sends the exact tagged request and preserves an empty available log', async () => {
    expect(
      await requestClearLog(async (request) => {
        expect(request).toEqual({ _tag: 'ClearLogRequest' })
        return { _tag: 'ClearLogSuccess', records: [] }
      }),
    ).toEqual({ status: 'available', records: [] })
  })

  it('returns verified records', async () => {
    expect(
      await requestClearLog(async () => ({
        _tag: 'ClearLogSuccess',
        records: [record],
      })),
    ).toEqual({
      status: 'available',
      records: [record],
    })
  })

  it.each([
    undefined,
    null,
    {},
    { _tag: 'ClearLogUnavailable' },
    { _tag: 'ClearLogSuccess', records: [record], extra: true },
    { _tag: 'ClearLogSuccess', records: [{ ...record, at: -1 }] },
    {
      _tag: 'ClearLogSuccess',
      records: [{ ...record, permalink: 'https://x.com/i/status/1' }],
    },
  ])('maps an unclaimed, unavailable, or malformed reply to unavailable: %o', async (reply) => {
    expect(await requestClearLog(async () => reply)).toEqual({
      status: 'unavailable',
    })
  })

  it('contains synchronous throws and rejected sends', async () => {
    expect(
      await requestClearLog(() => {
        throw new Error('background missing')
      }),
    ).toEqual({ status: 'unavailable' })
    expect(await requestClearLog(async () => Promise.reject(new Error('storage failed')))).toEqual({
      status: 'unavailable',
    })
  })
})
