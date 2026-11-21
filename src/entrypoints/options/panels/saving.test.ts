import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { Settings } from '@/packages/schema'

const read = (file: string): string =>
  readFileSync(fileURLToPath(import.meta.resolve(file)), 'utf8')
const source = read('./saving.tsx')
const browsingSource = read('./browsing.tsx')
const syncSource = read('./sync.tsx')
const settingsPanels = source + browsingSource + syncSource

// Every Field/row the three absorbed panels (General, Downloads, Filters)
// used to render must still be reachable somewhere in the merged panel — the
// spec's "nothing dropped" guarantee (§3.3), made executable.
const SETTINGS_KEYS = [
  'quickGrabEnabled',
  'quickGrabModifier',
  'downloadBadgeEnabled',
  'downloadDockEnabled',
  'dockGlassEnabled',
  'filenameTemplate',
  'sidecarMetadata',
  'saveToDisk',
  'downloadConcurrency',
  'downloadStrategy',
  'aria2Split',
  'aria2RpcUrl',
  'aria2Secret',
  'aria2Dir',
  'preventDuplicateDownloads',
  'skipType-',
  'minWidth',
  'minHeight',
  'maxFileSizeMB',
  'dailyMaxMB',
  'dailyMaxCount',
  'local:daily-budget',
  // Advanced section (§3.3 row 8) — not enumerated in the spec's §6.2 list
  // but present in the row table; included here for full coverage.
  'autoRevealSensitiveEnabled',
  'authFallbackEnabled',
  'showSavedStatus',
] as const

describe('Downloads, Browsing and Sync panels: nothing dropped from General + Downloads + Filters', () => {
  it('carries every settings field the three merged panels used to render', () => {
    for (const key of SETTINGS_KEYS) {
      expect(settingsPanels, `missing "${key}"`).toContain(key)
    }
  })

  it('orders the Downloads sections Files → Download mode → Limits', () => {
    const titles = ['Files', 'Download mode', 'Limits']
    let cursor = -1
    for (const title of titles) {
      const idx = source.indexOf(`title="${title}"`)
      expect(idx, `section "${title}" missing or out of order`).toBeGreaterThan(cursor)
      cursor = idx
    }
  })

  it('folds the rarely used limits away by default', () => {
    expect(source).toContain('title="Limits" collapsed')
  })

  it('titles the panel Downloads', () => {
    expect(source).toContain('title="Downloads"')
    expect(source).toContain('SavingPanel')
  })

  it('drops the dead per-item radius-4 class and takes Download mode radii from the shared segmented control (finding 6)', () => {
    expect(source).not.toContain('--xmd-radius-4')
    expect(source).not.toContain("'--radius'")
    expect(source).toContain('sx={segmented.track}')
    expect(source).toContain('segmented.item')
  })

  it('reaches 40px on every options action Button via call-site min-h-10 (finding 17)', () => {
    expect(source).toContain('Grant localhost access')
    expect(source).toContain('Reset today')
    // Both buttons carry the shared StyleX minHeight override; button.tsx itself is untouched.
    expect(source).toContain("minH10: { minHeight: '2.5rem' }")
    expect(source).toContain('sx={styles.minH10} onClick={() => void aria2Access.request()}')
    expect(source).toContain('sx={[styles.minH10, styles.selfStart]}')
  })
})

// Ported from popup-layout.test.ts's "settings controls live on the options
// page" describe block, which read `panels/general.tsx` directly — that file
// no longer exists (absorbed into Saving, §3.3). Spec §6.1: "General-panel
// assertions move to saving.test.ts (the file they grep no longer exists)."
describe('settings controls live on the options page (General → Browsing)', () => {
  it('hosts the download badge toggle alongside the Quick Grab controls', () => {
    expect(browsingSource).toContain('checked={settings.quickGrabEnabled}')
    expect(browsingSource).toContain('id="downloadBadgeEnabled"')
    expect(browsingSource).toContain('Download badge')
    expect(browsingSource).toContain('checked={settings.downloadBadgeEnabled}')
    expect(browsingSource).toContain('downloadBadgeEnabled: checked')
  })

  it('renders the badge toggle on under default settings', () => {
    const defaults = Schema.decodeUnknownSync(Settings)({})
    expect(defaults.downloadBadgeEnabled).toBe(true)
    expect(browsingSource).toContain('checked={settings.downloadBadgeEnabled}')
  })
})
