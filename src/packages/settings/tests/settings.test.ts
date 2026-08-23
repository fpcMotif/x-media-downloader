import { describe, it, expect, beforeEach } from 'vitest'
import { Effect } from 'effect'
import { fakeBrowser } from 'wxt/testing/fake-browser'
import {
  SettingsService,
  SettingsServiceLive,
  getSettings,
  setSettings,
  watchSettings,
} from '../index'

const run = <A, E>(eff: Effect.Effect<A, E, SettingsService>) =>
  Effect.runPromise(Effect.provide(eff, SettingsServiceLive))

const getViaService = Effect.gen(function* () {
  const svc = yield* SettingsService
  return yield* svc.get
})

beforeEach(() => {
  fakeBrowser.reset()
})

describe('SettingsService', () => {
  it('returns defaults on first run', async () => {
    const s = await run(getViaService)
    expect(s.downloadConcurrency).toBe(5)
    expect(s.authFallbackEnabled).toBe(false)
    expect(s.downloadStrategy).toBe('direct')
  })

  it('persists and reloads a changed setting', async () => {
    const updated = await run(
      Effect.gen(function* () {
        const svc = yield* SettingsService
        yield* svc.set({ filenameTemplate: '{tweetId}.{ext}' })
        return yield* svc.get
      }),
    )
    expect(updated.filenameTemplate).toBe('{tweetId}.{ext}')
  })

  it('falls back to defaults when stored data is corrupt', async () => {
    await fakeBrowser.storage.local.set({ settings: { downloadConcurrency: 'not-a-number' } })
    const s = await run(getViaService)
    expect(s.downloadConcurrency).toBe(5)
  })

  it('defaults cloud sync off — local-only posture (ADR-0009)', async () => {
    const s = await run(getViaService)
    expect(s.cloudSyncEnabled).toBe(false)
    expect(s.convexUrl).toBe('')
    expect(s.convexSyncSecret).toBe('')
    expect(s.cloudDeviceId).toBe('')
  })

  it('recovers downloadBadgeEnabled to its default when the stored value is corrupt', async () => {
    await fakeBrowser.storage.local.set({ settings: { downloadBadgeEnabled: 'nope' } })
    const s = await run(getViaService)
    expect(s.downloadBadgeEnabled).toBe(true)
  })

  it('defaults download history off — opt-in posture', async () => {
    const s = await run(getViaService)
    expect(s.downloadHistoryEnabled).toBe(false)
  })

  it('defaults cross-list clearing off, per-scope clears on — page-scoped posture', async () => {
    const s = await run(getViaService)
    // "Clear from every list" is the aggressive opt-in: a clear stays page-scoped
    // until the user turns it on. The per-scope un-bookmark/un-like default on so
    // they take effect the moment the (off-by-default) master clearOnSave is enabled.
    expect(s.clearAllListsOnSave).toBe(false)
    expect(s.autoUnbookmarkOnSave).toBe(true)
    expect(s.autoUnlikeOnSave).toBe(true)
    expect(s.autoNotInterestedOnSave).toBe(true)
  })

  it('getSettings promise wrapper reads through the live service', async () => {
    await setSettings({ filenameTemplate: '{handle}/{tweetId}.{ext}' })
    const s = await getSettings()
    expect(s.filenameTemplate).toBe('{handle}/{tweetId}.{ext}')
  })

  it('recovers downloadHistoryEnabled to its default when the stored value is corrupt', async () => {
    await fakeBrowser.storage.local.set({ settings: { downloadHistoryEnabled: 'nope' } })
    const s = await run(getViaService)
    expect(s.downloadHistoryEnabled).toBe(false)
  })

  it('defaults the admission-gate filter keys off/zero — opt-in posture', async () => {
    const s = await run(getViaService)
    expect(s.preventDuplicateDownloads).toBe(false)
    expect(s.skipTypes).toEqual([])
    expect(s.minWidth).toBe(0)
    expect(s.minHeight).toBe(0)
    expect(s.maxFileSizeMB).toBe(0)
    expect(s.dailyMaxMB).toBe(0)
    expect(s.dailyMaxCount).toBe(0)
  })

  it('recovers preventDuplicateDownloads to its default when the stored value is corrupt', async () => {
    await fakeBrowser.storage.local.set({ settings: { preventDuplicateDownloads: 'nope' } })
    const s = await run(getViaService)
    expect(s.preventDuplicateDownloads).toBe(false)
  })
})

describe('watchSettings', () => {
  it('delivers downloadHistoryEnabled changes', async () => {
    const seen: boolean[] = []
    const unwatch = watchSettings((s) => seen.push(s.downloadHistoryEnabled))
    await setSettings({ downloadHistoryEnabled: true })
    expect(seen).toEqual([true])
    unwatch()
  })

  it('delivers decoded settings on storage writes and stops after unwatch', async () => {
    const seen: boolean[] = []
    const unwatch = watchSettings((s) => seen.push(s.quickGrabEnabled))
    await setSettings({ quickGrabEnabled: false })
    expect(seen).toEqual([false])
    unwatch()
    await setSettings({ quickGrabEnabled: true })
    expect(seen).toEqual([false])
  })

  it('decodes a corrupt stored value to defaults in the watch callback', async () => {
    const seen: number[] = []
    const unwatch = watchSettings((s) => seen.push(s.downloadConcurrency))
    await fakeBrowser.storage.local.set({ settings: { downloadConcurrency: 'nope' } })
    expect(seen).toEqual([5])
    unwatch()
  })

  it('decodes a removed stored item back to defaults in the watch callback', async () => {
    await setSettings({ filenameTemplate: '{tweetId}.{ext}' })
    const seen: string[] = []
    const unwatch = watchSettings((s) => seen.push(s.filenameTemplate))
    // Removing the item fires the watch with the defineItem fallback ({}) → defaults.
    await fakeBrowser.storage.local.remove('settings')
    expect(seen).toEqual(['{platform}/{tweetId}_{index}.{ext}'])
    unwatch()
  })
})
