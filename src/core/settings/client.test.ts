import { Schema } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { Settings, type SettingsUiPatch } from '../schema'
import { makeSettingsClient, type SettingsUpdateSender } from './client'

const settings = Schema.decodeUnknownSync(Settings)({})

const run = (send: SettingsUpdateSender, patch: SettingsUiPatch) =>
  makeSettingsClient(send).update(patch)

describe('SettingsClient', () => {
  it('sends a typed patch and returns the committed Settings', async () => {
    const send = vi.fn<SettingsUpdateSender>(async () => ({
      _tag: 'SettingsUpdateSuccess',
      settings: { ...settings, theme: 'dark' },
    }))

    await expect(run(send, { theme: 'dark' })).resolves.toMatchObject({ theme: 'dark' })
    expect(send).toHaveBeenCalledWith({
      _tag: 'SettingsUpdateRequest',
      patch: { theme: 'dark' },
    })
  })

  it('returns a typed error when the send fails', async () => {
    await expect(
      run(async () => Promise.reject(new Error('offline')), { theme: 'dark' }),
    ).rejects.toMatchObject({
      name: 'SettingsUpdateError',
      code: 'send-failed',
    })
  })

  it('distinguishes a stale extension context from an ordinary send failure', async () => {
    await expect(
      run(async () => Promise.reject(new Error('Extension context invalidated')), {
        theme: 'dark',
      }),
    ).rejects.toMatchObject({
      name: 'SettingsUpdateError',
      code: 'context-invalidated',
    })
  })

  it('returns a typed error when the background leaves the request unclaimed', async () => {
    await expect(run(async () => undefined, { theme: 'dark' })).rejects.toMatchObject({
      name: 'SettingsUpdateError',
      code: 'unclaimed',
    })
  })

  it('returns a typed error for a malformed response', async () => {
    await expect(
      run(async () => ({ _tag: 'SettingsUpdateSuccess' }), { theme: 'dark' }),
    ).rejects.toMatchObject({
      name: 'SettingsUpdateError',
      code: 'malformed-response',
    })
  })

  it('rejects partial or excess success snapshots', async () => {
    await expect(
      run(async () => ({ _tag: 'SettingsUpdateSuccess', settings: { theme: 'dark' } }), {
        theme: 'dark',
      }),
    ).rejects.toMatchObject({ name: 'SettingsUpdateError', code: 'malformed-response' })
    await expect(
      run(async () => ({ _tag: 'SettingsUpdateSuccess', settings, extra: true }), {
        theme: 'dark',
      }),
    ).rejects.toMatchObject({ name: 'SettingsUpdateError', code: 'malformed-response' })
  })

  it('returns the background rejection as a typed error', async () => {
    await expect(
      run(async () => ({ _tag: 'SettingsUpdateFailure', reason: 'unknown setting key' }), {
        theme: 'dark',
      }),
    ).rejects.toMatchObject({
      name: 'SettingsUpdateError',
      code: 'rejected',
      message: 'unknown setting key',
    })
  })
})
