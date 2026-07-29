import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { Settings as SettingsSchema, type Settings } from '../core/schema'
import {
  captureMirrorDestination,
  hasConvexConnection,
  isCaptureMirrorConfigured,
  isSyncConfigured,
} from './sync-config'

const base: Settings = Schema.decodeUnknownSync(SettingsSchema)({})
const settings = (patch: Partial<Settings>): Settings => ({ ...base, ...patch })
const connected = {
  convexUrl: 'https://x.convex.cloud',
  convexSyncSecret: 'secret',
} satisfies Partial<Settings>

describe('Convex intent gates', () => {
  it('separates shared connection state from Media Sync consent', () => {
    const value = settings({ ...connected, cloudSyncEnabled: false })
    expect(hasConvexConnection(value)).toBe(true)
    expect(isSyncConfigured(value)).toBe(false)
  })

  it('allows Capture Mirror while Media Sync is off', () => {
    expect(
      isCaptureMirrorConfigured(
        settings({
          ...connected,
          cloudSyncEnabled: false,
          captureEnabled: true,
          captureMirrorEnabled: true,
          cloudDeviceId: 'device-1',
        }),
      ),
    ).toBe(true)
  })

  it('returns one canonical destination identity', () => {
    expect(
      captureMirrorDestination(
        settings({
          ...connected,
          captureEnabled: true,
          captureMirrorEnabled: true,
          cloudDeviceId: 'device-1',
          convexUrl: 'HTTPS://X.CONVEX.CLOUD:443/',
        }),
      ),
    ).toBe('https://x.convex.cloud')
  })

  it.each([
    { captureEnabled: false },
    { captureMirrorEnabled: false },
    { cloudDeviceId: '' },
    { convexUrl: '' },
    { convexSyncSecret: '' },
    { convexUrl: 'not a URL' },
    { convexUrl: 'https://x.convex.cloud/?query=wrong' },
  ])('fails Capture Mirror closed for %o', (patch) => {
    expect(
      isCaptureMirrorConfigured(
        settings({
          ...connected,
          captureEnabled: true,
          captureMirrorEnabled: true,
          cloudDeviceId: 'device-1',
          ...patch,
        }),
      ),
    ).toBe(false)
  })
})
