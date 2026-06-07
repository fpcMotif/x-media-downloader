import { describe, it, expect, beforeEach } from 'vitest'
import { Effect } from 'effect'
import { fakeBrowser } from 'wxt/testing/fake-browser'
import { SettingsService, SettingsServiceLive } from './index'

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
})
