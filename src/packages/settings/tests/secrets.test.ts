import { setTimeout as sleep } from 'node:timers/promises'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Schema } from 'effect'
import { fakeBrowser } from 'wxt/testing/fake-browser'
import { CURRENT_DEFAULT_TEMPLATE, type Settings } from '@/packages/schema'
import {
  SECRET_SETTINGS_FIELDS,
  getSettings,
  migrateSettingsSecrets,
  setSettings,
  watchSettings,
  type SecretSettingsField,
} from '../index'
import { getPageSettings, watchPageSettings, type PageSettings } from '../page'

const StoredEntry = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Array(Schema.String)]),
)

const RawStorageBlob = Schema.Struct({
  settings: Schema.optional(StoredEntry),
  settingsSecrets: Schema.optional(StoredEntry),
})

const readRawStorage = async () =>
  Schema.decodeUnknownSync(RawStorageBlob)(
    await fakeBrowser.storage.local.get(['settings', 'settingsSecrets']),
  )

const SECRET_FIELD_VALUES = {
  aria2Secret: 'test-aria2-secret',
  convexSyncSecret: 'test-convex-secret',
  gdriveClientSecret: 'test-gdrive-client-secret',
  gdriveAccessToken: 'test-token',
  gdriveRefreshToken: 'test-gdrive-refresh',
  gdriveTokenExpiry: 1_700_000_000_000,
  dropboxAccessToken: 'test-dropbox-access',
  dropboxRefreshToken: 'test-dropbox-refresh',
  dropboxTokenExpiry: 1_800_000_000_000,
} as const satisfies { readonly [K in SecretSettingsField]: Settings[K] }

const SECRET_PATCHES = {
  aria2Secret: { aria2Secret: SECRET_FIELD_VALUES.aria2Secret },
  convexSyncSecret: { convexSyncSecret: SECRET_FIELD_VALUES.convexSyncSecret },
  gdriveClientSecret: { gdriveClientSecret: SECRET_FIELD_VALUES.gdriveClientSecret },
  gdriveAccessToken: { gdriveAccessToken: SECRET_FIELD_VALUES.gdriveAccessToken },
  gdriveRefreshToken: { gdriveRefreshToken: SECRET_FIELD_VALUES.gdriveRefreshToken },
  gdriveTokenExpiry: { gdriveTokenExpiry: SECRET_FIELD_VALUES.gdriveTokenExpiry },
  dropboxAccessToken: { dropboxAccessToken: SECRET_FIELD_VALUES.dropboxAccessToken },
  dropboxRefreshToken: { dropboxRefreshToken: SECRET_FIELD_VALUES.dropboxRefreshToken },
  dropboxTokenExpiry: { dropboxTokenExpiry: SECRET_FIELD_VALUES.dropboxTokenExpiry },
} satisfies Record<SecretSettingsField, Partial<Settings>>

beforeEach(() => {
  vi.restoreAllMocks()
  fakeBrowser.reset()
})

describe('settings secret split', () => {
  it('writes a token only to the secrets key', async () => {
    await setSettings({ gdriveAccessToken: 'test-token' })
    const raw = await readRawStorage()
    const publicKeys = Object.keys(raw.settings ?? {})
    for (const field of SECRET_SETTINGS_FIELDS) {
      expect(publicKeys).not.toContain(field)
    }
    expect(raw.settingsSecrets?.gdriveAccessToken).toBe('test-token')
    expect((await getSettings()).gdriveAccessToken).toBe('test-token')
  })

  it('keeps every field in SECRET_SETTINGS_FIELDS out of the public settings key', async () => {
    expect(SECRET_SETTINGS_FIELDS).toHaveLength(9)
    for (const field of SECRET_SETTINGS_FIELDS) {
      fakeBrowser.reset()
      await setSettings(SECRET_PATCHES[field])
      const raw = await readRawStorage()
      const publicKeys = Object.keys(raw.settings ?? {})
      for (const secretField of SECRET_SETTINGS_FIELDS) {
        expect(publicKeys).not.toContain(secretField)
      }
      expect(raw.settingsSecrets?.[field]).toBe(SECRET_FIELD_VALUES[field])
      const current = await getSettings()
      expect(current[field]).toBe(SECRET_FIELD_VALUES[field])
    }
  })

  it('writes the secrets key before the public key', async () => {
    const keysOrder: string[] = []
    const origSet = fakeBrowser.storage.local.set.bind(fakeBrowser.storage.local)
    vi.spyOn(fakeBrowser.storage.local, 'set').mockImplementation(async (items) => {
      keysOrder.push(...Object.keys(items))
      await origSet(items)
    })

    await setSettings({ gdriveAccessToken: 'test-token', showSavedStatus: false })

    expect(keysOrder).toEqual(['settingsSecrets', 'settings'])
  })

  it('still reads tokens from legacy installs where secrets are in the public key', async () => {
    await fakeBrowser.storage.local.set({
      settings: { dropboxRefreshToken: 'legacy-token' },
    })

    const settings = await getSettings()
    expect(settings.dropboxRefreshToken).toBe('legacy-token')
  })

  it('migrates legacy secret fields out of the public key once', async () => {
    await fakeBrowser.storage.local.set({
      settings: { dropboxRefreshToken: 'legacy-token', showSavedStatus: false },
    })

    expect(await migrateSettingsSecrets()).toBe(true)

    const raw = await readRawStorage()
    expect(raw.settings).not.toHaveProperty('dropboxRefreshToken')
    expect(raw.settings?.showSavedStatus).toBe(false)
    expect(raw.settingsSecrets?.dropboxRefreshToken).toBe('legacy-token')
    expect((await getSettings()).dropboxRefreshToken).toBe('legacy-token')

    expect(await migrateSettingsSecrets()).toBe(false)
  })

  it('returns false from migration when the public key holds non-object data', async () => {
    await fakeBrowser.storage.local.set({ settings: 'corrupt' })
    expect(await migrateSettingsSecrets()).toBe(false)
  })

  it('prefers the secrets key over a stale value in the public key', async () => {
    await fakeBrowser.storage.local.set({
      settings: { gdriveAccessToken: 'old' },
      settingsSecrets: { gdriveAccessToken: 'new' },
    })

    expect((await getSettings()).gdriveAccessToken).toBe('new')
  })

  it('ignores non-object corrupt storage values when merging', async () => {
    await fakeBrowser.storage.local.set({
      settings: 'corrupt',
      settingsSecrets: { gdriveAccessToken: 'kept' },
    })
    expect((await getSettings()).gdriveAccessToken).toBe('kept')

    await fakeBrowser.storage.local.set({
      settings: { showSavedStatus: false },
      settingsSecrets: 'corrupt',
    })
    expect((await getSettings()).showSavedStatus).toBe(false)

    await setSettings({ showSavedStatus: true, gdriveAccessToken: '' })
    const raw = await readRawStorage()
    expect(raw.settings?.showSavedStatus).toBe(true)
    expect(raw.settingsSecrets?.gdriveAccessToken).toBe('')
  })

  it('overwrites non-object corrupt public storage on public write without touching valid secrets', async () => {
    await fakeBrowser.storage.local.set({
      settings: 'corrupt',
      settingsSecrets: { gdriveAccessToken: 'kept' },
    })

    await setSettings({ showSavedStatus: false })

    const raw = await readRawStorage()
    expect(raw.settings?.showSavedStatus).toBe(false)
    expect(raw.settingsSecrets?.gdriveAccessToken).toBe('kept')
    const current = await getSettings()
    expect(current.showSavedStatus).toBe(false)
    expect(current.gdriveAccessToken).toBe('kept')
  })

  it('repairs a schema-invalid public settings object when writing only secret fields', async () => {
    await fakeBrowser.storage.local.set({
      settings: { downloadConcurrency: 'corrupt' },
    })

    await setSettings({ gdriveAccessToken: 'tok' })

    const raw = await readRawStorage()
    expect(raw.settings?.downloadConcurrency).toBe(5)
    expect((await getSettings()).gdriveAccessToken).toBe('tok')
  })

  it('repairs a schema-invalid secrets object when writing only public fields', async () => {
    await fakeBrowser.storage.local.set({
      settingsSecrets: { gdriveTokenExpiry: 'corrupt' },
    })

    await setSettings({ showSavedStatus: false })

    const raw = await readRawStorage()
    expect(raw.settingsSecrets?.gdriveTokenExpiry).toBe(0)
    expect((await getSettings()).showSavedStatus).toBe(false)
  })

  it('repairs non-object corrupt public storage when writing only secret fields', async () => {
    await fakeBrowser.storage.local.set({
      settings: 'corrupt',
    })

    await setSettings({ gdriveAccessToken: 'tok' })

    const raw = await readRawStorage()
    expect(raw.settings?.downloadConcurrency).toBe(5)
    expect((await getSettings()).gdriveAccessToken).toBe('tok')
  })

  it('repairs non-object corrupt secrets storage when writing only public fields', async () => {
    await fakeBrowser.storage.local.set({
      settingsSecrets: 'corrupt',
    })

    await setSettings({ showSavedStatus: false })

    const raw = await readRawStorage()
    expect(raw.settingsSecrets?.gdriveTokenExpiry).toBe(0)
    expect((await getSettings()).showSavedStatus).toBe(false)
  })

  it('never returns a stored secret from the page reader', async () => {
    await fakeBrowser.storage.local.set({
      settings: { convexSyncSecret: 'legacy-secret', showSavedStatus: false },
    })

    const page = await getPageSettings()
    expect(page.showSavedStatus).toBe(false)
    expect(JSON.stringify(page)).not.toContain('legacy-secret')
  })

  it('falls back to defaults in the page reader for corrupt or unreadable storage', async () => {
    await fakeBrowser.storage.local.set({ settings: 'corrupt' })
    expect((await getPageSettings()).downloadConcurrency).toBe(5)

    await fakeBrowser.storage.local.set({ settings: { downloadConcurrency: 'nope' } })
    expect((await getPageSettings()).downloadConcurrency).toBe(5)

    await fakeBrowser.storage.local.set({
      settings: { filenameTemplate: '{handle}/{tweetId}_{index}.{ext}' },
    })
    expect((await getPageSettings()).filenameTemplate).toBe(CURRENT_DEFAULT_TEMPLATE)

    vi.spyOn(fakeBrowser.storage.local, 'get').mockRejectedValueOnce(new Error('storage down'))
    expect((await getPageSettings()).downloadConcurrency).toBe(5)
  })

  it('does not notify the page watcher on token refresh', async () => {
    const pageSpy = vi.fn<(s: PageSettings) => void>()
    const trustedSpy = vi.fn<(s: Settings) => void>()
    const unwatchPage = watchPageSettings(pageSpy)
    const unwatchTrusted = watchSettings(trustedSpy)

    await setSettings({ gdriveAccessToken: 'a', gdriveTokenExpiry: 1 })
    await vi.waitFor(() => expect(trustedSpy).toHaveBeenCalled())
    expect(pageSpy).not.toHaveBeenCalled()

    await setSettings({ showSavedStatus: false })
    await vi.waitFor(() => expect(pageSpy).toHaveBeenCalledTimes(1))
    expect(pageSpy).toHaveBeenLastCalledWith(expect.objectContaining({ showSavedStatus: false }))

    unwatchPage()
    unwatchTrusted()

    await setSettings({ showSavedStatus: true })
    expect(pageSpy).toHaveBeenCalledTimes(1)
  })

  it('drops stale watchSettings callbacks when an earlier read resolves out of order', async () => {
    const seen: number[] = []
    const unwatch = watchSettings((s) => seen.push(s.downloadConcurrency))

    let resolveSlow!: () => void
    const slowGate = new Promise<void>((resolve) => {
      resolveSlow = resolve
    })
    const origGet = fakeBrowser.storage.local.get.bind(fakeBrowser.storage.local)
    let intercepted = false
    vi.spyOn(fakeBrowser.storage.local, 'get').mockImplementation(async (keys) => {
      if (keys === 'settings') {
        const snap = await origGet('settings')
        if (!intercepted) {
          intercepted = true
          await slowGate
        }
        return snap
      }
      if (keys === 'settingsSecrets') {
        const snap = await origGet('settingsSecrets')
        return snap
      }
      return origGet()
    })

    await fakeBrowser.storage.local.set({ settings: { downloadConcurrency: 1 } })
    await fakeBrowser.storage.local.set({ settings: { downloadConcurrency: 2 } })

    await vi.waitFor(() => {
      expect(seen).toEqual([2])
    })

    resolveSlow()
    await sleep(0)

    expect(seen).toEqual([2])
    unwatch()
  })
})
