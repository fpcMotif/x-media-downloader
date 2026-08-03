import { readFileSync } from 'node:fs'
import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { Settings } from '@/packages/schema'

const source = readFileSync('src/entrypoints/options/panels/saving.tsx', 'utf8')

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

describe('Saving panel: nothing dropped from General + Downloads + Filters', () => {
  it('carries every settings field the three merged panels used to render', () => {
    for (const key of SETTINGS_KEYS) {
      expect(source, `missing "${key}"`).toContain(key)
    }
  })

  it('orders its 8 sections On-page controls → Files & naming → Speed → Download mode → Duplicates → Media filters → Daily budget → Advanced', () => {
    const titles = [
      'On-page controls',
      'Files & naming',
      'Speed',
      'Download mode',
      'Duplicates',
      'Media filters',
      'Daily budget',
      'Advanced',
    ]
    let cursor = -1
    for (const title of titles) {
      const idx = source.indexOf(`title="${title}"`)
      expect(idx, `section "${title}" missing or out of order`).toBeGreaterThan(cursor)
      cursor = idx
    }
  })

  it('merges under one PanelHeader titled Saving', () => {
    expect(source).toContain('title="Saving"')
    expect(source).toContain('SavingPanel')
  })

  it('drops the dead per-item radius-4 class and overrides --radius on the Download mode wrapper (finding 6)', () => {
    expect(source).not.toContain('rounded-[var(--xmd-radius-4)]')
    expect(source).toContain("'--radius': 'var(--xmd-radius-3)'")
  })

  it('reaches 40px on every options action Button via call-site min-h-10 (finding 17)', () => {
    expect(source).toContain('Grant localhost access')
    expect(source).toContain('Reset today')
    // Both buttons carry the call-site class; button.tsx itself is untouched.
    expect(source.match(/min-h-10/g)?.length).toBeGreaterThanOrEqual(2)
  })
})

// Ported from popup-layout.test.ts's "settings controls live on the options
// page" describe block, which read `panels/general.tsx` directly — that file
// no longer exists (absorbed into Saving, §3.3). Spec §6.1: "General-panel
// assertions move to saving.test.ts (the file they grep no longer exists)."
describe('settings controls live on the options page (General → Saving)', () => {
  it('hosts the download badge toggle alongside the Quick Grab controls', () => {
    expect(source).toContain('checked={settings.quickGrabEnabled}')
    expect(source).toContain('id="downloadBadgeEnabled"')
    expect(source).toContain('Show download badge on media')
    expect(source).toContain('checked={settings.downloadBadgeEnabled}')
    expect(source).toContain('downloadBadgeEnabled: checked')
  })

  it('renders the badge toggle on under default settings', () => {
    const defaults = Schema.decodeUnknownSync(Settings)({})
    expect(defaults.downloadBadgeEnabled).toBe(true)
    expect(source).toContain('checked={settings.downloadBadgeEnabled}')
  })
})
