import { Schema } from 'effect'
import { beforeEach, describe, expect, it } from 'vitest'
import { fakeBrowser } from 'wxt/testing/fake-browser'
import { Settings as SettingsSchema } from '../schema/settings'
import { getSettingsOwnership, watchSettingsOwnership } from './index'
import { encodeSettingsStore } from './persistence'
import { decodeSettingsOwnership } from './ownership'

const settings = Schema.decodeUnknownSync(SettingsSchema)({})

beforeEach(() => {
  fakeBrowser.reset()
})

describe('Settings ownership snapshot', () => {
  it('exposes desired intent only for available durable Settings', () => {
    const snapshot = decodeSettingsOwnership(
      encodeSettingsStore({ ...settings, cloudSyncEnabled: false }, 4),
    )

    expect(snapshot.availability).toBe('available')
    if (snapshot.availability !== 'available') throw new Error('expected available Settings')
    expect(snapshot.desired.cloudSyncEnabled).toBe(false)
    expect(snapshot.runtime.cloudSyncEnabled).toBe(false)
  })

  it('keeps recoverable desired data from becoming cleanup authority', () => {
    const snapshot = decodeSettingsOwnership({
      version: 1,
      revision: 4,
      settings: {
        ...settings,
        cloudSyncEnabled: true,
        downloadConcurrency: 'corrupt',
      },
    })

    expect(snapshot).toMatchObject({
      availability: 'recovery-required',
      reason: 'recoverable',
      runtime: { cloudSyncEnabled: false },
    })
    expect('desired' in snapshot).toBe(false)
  })

  it('treats unsupported Settings as unavailable, not opted out', () => {
    const snapshot = decodeSettingsOwnership({
      version: 2,
      revision: 1,
      settings,
    })

    expect(snapshot).toMatchObject({
      availability: 'recovery-required',
      reason: 'blocked',
      runtime: { cloudSyncEnabled: false },
    })
    expect('desired' in snapshot).toBe(false)
  })

  it('boot reads recovery availability separately from its safe runtime value', async () => {
    await fakeBrowser.storage.local.set({
      settings: {
        version: 1,
        revision: 4,
        settings: {
          ...settings,
          cloudSyncEnabled: true,
          downloadConcurrency: 'corrupt',
        },
      },
    })

    await expect(getSettingsOwnership()).resolves.toMatchObject({
      availability: 'recovery-required',
      runtime: { cloudSyncEnabled: false },
    })
  })

  it('watch publishes recovery availability instead of a false opt-out', async () => {
    const seen: string[] = []
    const unwatch = watchSettingsOwnership((snapshot) => {
      seen.push(snapshot.availability)
    })

    await fakeBrowser.storage.local.set({
      settings: {
        version: 1,
        revision: 4,
        settings: {
          ...settings,
          cloudSyncEnabled: true,
          downloadConcurrency: 'corrupt',
        },
      },
    })
    unwatch()

    expect(seen).toEqual(['recovery-required'])
  })
})
