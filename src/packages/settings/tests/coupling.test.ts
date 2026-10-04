import { describe, it, expect } from 'vitest'
import { Schema } from 'effect'
import { Settings } from '@/packages/schema'
import { dedupeToggleDelta, destinationLostDelta, saveToDiskToggleDelta } from '../coupling'

const settings = Schema.decodeUnknownSync(Settings)({})

describe('dedupeToggleDelta', () => {
  it('enabling turns on dedup and its history data source', () => {
    expect(dedupeToggleDelta(true)).toEqual({
      preventDuplicateDownloads: true,
      downloadHistoryEnabled: true,
    })
  })

  it('disabling turns off dedup but leaves history untouched', () => {
    const delta = dedupeToggleDelta(false)
    expect(delta).toEqual({ preventDuplicateDownloads: false })
    expect('downloadHistoryEnabled' in delta).toBe(false)
  })
})

const driveConnected: Settings = {
  ...settings,
  cloudUploadEnabled: true,
  gdriveClientId: 'gdrive-client',
  gdriveRefreshToken: 'gdrive-refresh',
}

describe('saveToDiskToggleDelta', () => {
  it('refuses Cloud-only when no Cloud Provider is connected and enabled', () => {
    expect(saveToDiskToggleDelta(false, settings)).toEqual({ saveToDisk: true })
  })

  it('allows Cloud-only when Cloud upload has a connected enabled provider', () => {
    expect(saveToDiskToggleDelta(false, driveConnected)).toEqual({ saveToDisk: false })
  })

  it('turning Save to this computer on always writes true', () => {
    expect(saveToDiskToggleDelta(true, settings)).toEqual({ saveToDisk: true })
  })

  it('refuses Cloud-only when the only connected provider is paused', () => {
    expect(saveToDiskToggleDelta(false, { ...driveConnected, gdriveUploadEnabled: false })).toEqual(
      { saveToDisk: true },
    )
  })
})

describe('destinationLostDelta', () => {
  it('forces Save to this computer on when Cloud-only loses its last destination', () => {
    const cloudOnly: Settings = { ...driveConnected, saveToDisk: false, gdriveUploadEnabled: false }
    expect(destinationLostDelta(cloudOnly)).toEqual({ saveToDisk: true })
  })

  it('writes nothing when a live destination remains', () => {
    const cloudOnly: Settings = { ...driveConnected, saveToDisk: false }
    expect(destinationLostDelta(cloudOnly)).toEqual({})
  })

  it('writes nothing when Save to this computer is already on', () => {
    expect(destinationLostDelta({ ...settings, saveToDisk: true })).toEqual({})
  })
})
