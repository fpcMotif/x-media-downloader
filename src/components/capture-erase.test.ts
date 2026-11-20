import { describe, expect, it } from 'vitest'
import { runCaptureErase } from './capture-erase'

describe('runCaptureErase', () => {
  it('reports the erase only when the worker confirms it', async () => {
    const outcome = await runCaptureErase(3, async () => ({ cleared: 3 }))

    expect(outcome).toEqual({ ok: true, detail: 'Erased 3 tweets from the archive.' })
  })

  it('reports a failure when the worker cannot be reached', async () => {
    const outcome = await runCaptureErase(3, async () => {
      throw new Error('Extension context invalidated')
    })

    expect(outcome.ok).toBe(false)
    expect(outcome.detail).not.toContain('Erased')
  })

  it('reports a failure when the worker answers without a confirmation', async () => {
    const outcome = await runCaptureErase(3, async () => undefined)

    expect(outcome.ok).toBe(false)
    expect(outcome.detail).not.toContain('Erased')
  })
})
