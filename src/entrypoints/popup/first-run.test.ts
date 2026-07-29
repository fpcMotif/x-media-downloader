import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { fakeBrowser } from 'wxt/testing'
import { storage } from 'wxt/utils/storage'
import {
  MAX_TEACHING_OPENS,
  getIntroState,
  makeFirstRunStateOwner,
  markDone,
  recordOpen,
  shouldShowIntro,
  type FirstRunState,
} from './first-run'

describe('shouldShowIntro (pure)', () => {
  it('shows on a fresh, never-dismissed state', () => {
    expect(shouldShowIntro({ opens: 0, done: false })).toBe(true)
  })

  it('still shows at exactly the open-count ceiling', () => {
    expect(shouldShowIntro({ opens: MAX_TEACHING_OPENS, done: false })).toBe(true)
  })

  it('hides past the open-count ceiling', () => {
    expect(shouldShowIntro({ opens: MAX_TEACHING_OPENS + 1, done: false })).toBe(false)
  })

  it('hides once dismissed, regardless of open count', () => {
    expect(shouldShowIntro({ opens: 0, done: true })).toBe(false)
  })
})

describe('storage-backed state', () => {
  beforeEach(() => {
    fakeBrowser.reset()
  })

  it('starts at the fallback (opens: 0, done: false)', async () => {
    expect(await getIntroState()).toEqual({ opens: 0, done: false })
  })

  it('recordOpen increments opens and persists it', async () => {
    expect(await recordOpen()).toEqual({ opens: 1, done: false })
    expect(await recordOpen()).toEqual({ opens: 2, done: false })
    expect(await getIntroState()).toEqual({ opens: 2, done: false })
  })

  it('markDone sets done without disturbing the open count', async () => {
    await recordOpen()
    await recordOpen()
    expect(await markDone()).toEqual({ opens: 2, done: true })
    expect(await getIntroState()).toEqual({ opens: 2, done: true })
  })

  it('markDone then recordOpen keeps done sticky (opens still counts)', async () => {
    await markDone()
    expect(await recordOpen()).toEqual({ opens: 1, done: true })
  })

  it('serializes a popup-open write with terminal dismissal', async () => {
    const [opened, done] = await Promise.all([recordOpen(), markDone()])

    expect(opened).toEqual({ opens: 1, done: false })
    expect(done).toEqual({ opens: 1, done: true })
    expect(await getIntroState()).toEqual({ opens: 1, done: true })
  })

  it('keeps dismissal sticky across two popup owners', async () => {
    let state: unknown = { opens: 0, done: false }
    let terminal: unknown = false
    let releaseOldWrite!: () => void
    const oldWriteBlocked = new Promise<void>((resolve) => {
      releaseOldWrite = resolve
    })
    let oldWriteStarted!: () => void
    const oldWriteSeen = new Promise<void>((resolve) => {
      oldWriteStarted = resolve
    })
    let blockOldWrite = true
    const shared = {
      readState: async () => state,
      writeState: async (next: FirstRunState) => {
        if (blockOldWrite && next.opens === 1 && !next.done) {
          blockOldWrite = false
          oldWriteStarted()
          await oldWriteBlocked
        }
        state = next
      },
      readDone: async () => terminal,
      writeDone: async () => {
        terminal = true
      },
    }
    const openingPopup = makeFirstRunStateOwner(shared)
    const dismissingPopup = makeFirstRunStateOwner(shared)

    const opening = openingPopup.recordOpen()
    await oldWriteSeen
    expect(await dismissingPopup.markDone()).toEqual({ opens: 0, done: true })
    releaseOldWrite()

    expect(await opening).toEqual({ opens: 1, done: true })
    expect(await openingPopup.get()).toEqual({ opens: 1, done: true })
  })

  it.each([
    null,
    [],
    { opens: -1, done: false },
    { opens: 1.5, done: false },
    { opens: Number.NaN, done: false },
    { opens: Number.POSITIVE_INFINITY, done: false },
    { opens: Number.MAX_SAFE_INTEGER + 1, done: false },
    { opens: MAX_TEACHING_OPENS + 2, done: false },
    { opens: 0, done: 'false' },
    { opens: 0, done: false, old: true },
    { opens: 0 },
  ])('repairs malformed stored state: %j', async (value) => {
    await storage.setItem('local:xmd-popup-intro', value)

    expect(await getIntroState()).toEqual({ opens: 0, done: false })
    expect(await storage.getItem('local:xmd-popup-intro')).toEqual({ opens: 0, done: false })
  })

  it('keeps the terminal counter bounded', async () => {
    await storage.setItem('local:xmd-popup-intro', {
      opens: MAX_TEACHING_OPENS + 1,
      done: true,
    })

    expect(await recordOpen()).toEqual({ opens: MAX_TEACHING_OPENS + 1, done: true })
  })
})

describe('storage key', () => {
  it('keeps popup-local state and its terminal marker outside Settings', () => {
    const source = readFileSync('src/entrypoints/popup/first-run.ts', 'utf8')
    expect(source).toContain("const INTRO_KEY = 'local:xmd-popup-intro'")
    expect(source).toContain("const DONE_KEY = 'local:xmd-popup-intro-done'")
  })
})
