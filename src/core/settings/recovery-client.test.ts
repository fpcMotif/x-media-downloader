import { describe, expect, it, vi } from 'vitest'
import type { SettingsRecoverySender } from './recovery-client'
import { makeSettingsRecoveryClient } from './recovery-client'

const healthy = {
  _tag: 'SettingsRecoveryStatus',
  kind: 'healthy',
  revision: 1,
  fingerprint: 'sha256:abc',
  invalidKeys: [],
  unknownKeys: [],
  truncated: false,
} as const

describe('SettingsRecoveryClient', () => {
  it('sends one exact inspect command and decodes the reply', async () => {
    const send = vi.fn<SettingsRecoverySender>(async () => healthy)
    const client = makeSettingsRecoveryClient(send)

    await expect(client.inspect()).resolves.toEqual(healthy)
    expect(send).toHaveBeenCalledWith({
      _tag: 'SettingsRecoveryRequest',
      action: 'inspect',
    })
  })

  it('binds Repair to the inspected fingerprint', async () => {
    const send = vi.fn<SettingsRecoverySender>(async () => healthy)
    const client = makeSettingsRecoveryClient(send)

    await client.recover('repair', 'sha256:before')
    expect(send).toHaveBeenCalledWith({
      _tag: 'SettingsRecoveryRequest',
      action: 'repair',
      fingerprint: 'sha256:before',
    })
  })

  it.each([undefined, { ...healthy, raw: { secret: 'must-not-cross' } }])(
    'maps an absent or malformed reply to unavailable',
    async (reply) => {
      const client = makeSettingsRecoveryClient(async () => reply)
      await expect(client.inspect()).resolves.toEqual({
        _tag: 'SettingsRecoveryFailure',
        reason: 'unavailable',
      })
    },
  )

  it('maps transport failure to unavailable without throwing', async () => {
    const client = makeSettingsRecoveryClient(async () => {
      throw new Error('worker unavailable')
    })
    await expect(client.inspect()).resolves.toEqual({
      _tag: 'SettingsRecoveryFailure',
      reason: 'unavailable',
    })
  })
})
