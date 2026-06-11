import { describe, it, expect, beforeEach } from 'vitest'
import { Effect } from 'effect'
import { fakeBrowser } from 'wxt/testing/fake-browser'
import { SettingsService, SettingsServiceLive, setSettings, watchSettings } from './index'

const run = <A, E>(eff: Effect.Effect<A, E, SettingsService>) =>
  Effect.runPromise(Effect.provide(eff, SettingsServiceLive))

const getSettings = Effect.gen(function* () {
  const svc = yield* SettingsService
  return yield* svc.get
})

beforeEach(() => {
  fakeBrowser.reset()
})

describe('SettingsService', () => {
  it('returns defaults on first run', async () => {
    const s = await run(getSettings)
    expect(s.downloadConcurrency).toBe(3)
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
    const s = await run(getSettings)
    expect(s.downloadConcurrency).toBe(3)
  })

  it('defaults cloud sync off — local-only posture (ADR-0009)', async () => {
    const s = await run(getSettings)
    expect(s.cloudSyncEnabled).toBe(false)
    expect(s.convexUrl).toBe('')
    expect(s.convexSyncSecret).toBe('')
    expect(s.cloudDeviceId).toBe('')
  })
})

describe('watchSettings', () => {
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
    expect(seen).toEqual([3])
    unwatch()
  })
})
