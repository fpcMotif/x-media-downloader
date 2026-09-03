import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { fakeBrowser } from 'wxt/testing/fake-browser'
import { MAX_TEACHING_OPENS, markDone, recordOpen, shouldShowIntro } from './first-run'

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

  it('recordOpen increments opens and persists it', async () => {
    expect(await recordOpen()).toEqual({ opens: 1, done: false })
    expect(await recordOpen()).toEqual({ opens: 2, done: false })
  })

  it('markDone sets done without disturbing the open count', async () => {
    await recordOpen()
    await recordOpen()
    expect(await markDone()).toEqual({ opens: 2, done: true })
  })

  it('markDone then recordOpen keeps done sticky (opens still counts)', async () => {
    await markDone()
    expect(await recordOpen()).toEqual({ opens: 1, done: true })
  })
})

describe('storage key', () => {
  it('lives outside the Settings schema, under its own local: key', () => {
    const source = readFileSync('src/entrypoints/popup/first-run.ts', 'utf8')
    expect(source).toContain("storage.defineItem<FirstRunState>('local:xmd-popup-intro'")
  })
})
