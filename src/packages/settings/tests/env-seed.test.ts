import { describe, it, expect } from 'vitest'
import { planConvexEnvSeed, planCloudEnvSeed } from '../env-seed'

const empty = { convexUrl: '', convexSyncSecret: '', cloudDeviceId: '' }
const fullEnv = { url: 'https://x.convex.cloud', secret: 'sk-live' }
const counter = () => {
  let n = 0
  return () => `id-${++n}`
}

describe('planConvexEnvSeed', () => {
  it('returns null when both env and settings are empty', () => {
    expect(planConvexEnvSeed(empty, {}, counter())).toBeNull()
  })

  it('seeds the full tuple plus a minted deviceId when env is present and settings empty', () => {
    expect(planConvexEnvSeed(empty, fullEnv, counter())).toEqual({
      convexUrl: 'https://x.convex.cloud',
      convexSyncSecret: 'sk-live',
      cloudSyncEnabled: true,
      cloudDeviceId: 'id-1',
    })
  })

  it('omits cloudDeviceId when one is already set', () => {
    expect(planConvexEnvSeed({ ...empty, cloudDeviceId: 'existing' }, fullEnv, counter())).toEqual({
      convexUrl: 'https://x.convex.cloud',
      convexSyncSecret: 'sk-live',
      cloudSyncEnabled: true,
    })
  })

  it('returns null when convexUrl is already set (never clobbers a user edit)', () => {
    expect(
      planConvexEnvSeed({ ...empty, convexUrl: 'https://mine' }, fullEnv, counter()),
    ).toBeNull()
  })

  it('returns null when convexSyncSecret is already set', () => {
    expect(planConvexEnvSeed({ ...empty, convexSyncSecret: 'mine' }, fullEnv, counter())).toBeNull()
  })

  it('returns null when env is missing the url', () => {
    expect(planConvexEnvSeed(empty, { secret: 'sk-live' }, counter())).toBeNull()
  })

  it('returns null when env is missing the secret', () => {
    expect(planConvexEnvSeed(empty, { url: 'https://x.convex.cloud' }, counter())).toBeNull()
  })
})

const emptyCloud = { gdriveClientId: '', dropboxClientId: '' }

describe('planCloudEnvSeed', () => {
  it('returns null when there is no env', () => {
    expect(planCloudEnvSeed(emptyCloud, {})).toBeNull()
  })

  it('seeds only gdriveClientId when only that env var is present', () => {
    expect(planCloudEnvSeed(emptyCloud, { gdriveClientId: 'g-id' })).toEqual({
      gdriveClientId: 'g-id',
    })
  })

  it('seeds only dropboxClientId (from dropboxAppKey) when only that env var is present', () => {
    expect(planCloudEnvSeed(emptyCloud, { dropboxAppKey: 'd-key' })).toEqual({
      dropboxClientId: 'd-key',
    })
  })

  it('folds both ids into one merged patch', () => {
    expect(
      planCloudEnvSeed(emptyCloud, { gdriveClientId: 'g-id', dropboxAppKey: 'd-key' }),
    ).toEqual({ gdriveClientId: 'g-id', dropboxClientId: 'd-key' })
  })

  it('omits an id whose field is already set (never clobbers a user edit)', () => {
    expect(
      planCloudEnvSeed(
        { gdriveClientId: 'mine', dropboxClientId: '' },
        { gdriveClientId: 'g-id', dropboxAppKey: 'd-key' },
      ),
    ).toEqual({ dropboxClientId: 'd-key' })
  })

  it('returns null when both fields are already set', () => {
    expect(
      planCloudEnvSeed(
        { gdriveClientId: 'a', dropboxClientId: 'b' },
        { gdriveClientId: 'g-id', dropboxAppKey: 'd-key' },
      ),
    ).toBeNull()
  })
})
