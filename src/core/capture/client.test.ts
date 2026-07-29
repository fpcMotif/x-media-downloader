import { describe, expect, it } from 'vitest'
import { requestCaptureErase, type CaptureEraseSender } from './client'

const acknowledgedErase: CaptureEraseSender = async (request) => {
  expect(request).toEqual({ _tag: 'ClearCaptureRequest' })
  return { cleared: 4, epoch: 'capture:1' }
}

describe('requestCaptureErase', () => {
  it('sends the tagged request and returns the acknowledged count', async () => {
    expect(await requestCaptureErase(acknowledgedErase)).toEqual({ ok: true, cleared: 4 })
  })

  it.each([
    undefined,
    null,
    {},
    { cleared: -1 },
    { cleared: 1.5 },
    { cleared: Number.POSITIVE_INFINITY },
    { cleared: Number.MAX_SAFE_INTEGER + 1 },
    { cleared: 1, epoch: 'capture:1', extra: true },
  ])('rejects an unclaimed or malformed reply: %o', async (reply) => {
    expect(await requestCaptureErase(async () => reply)).toEqual({ ok: false })
  })

  it('contains synchronous throws and rejected sends', async () => {
    expect(
      await requestCaptureErase(() => {
        throw new Error('background missing')
      }),
    ).toEqual({ ok: false })
    expect(
      await requestCaptureErase(async () => Promise.reject(new Error('storage failed'))),
    ).toEqual({
      ok: false,
    })
  })
})
