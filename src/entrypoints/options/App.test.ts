import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(fileURLToPath(import.meta.resolve('./App.tsx')), 'utf8')

/** Pull the `group: '<...>'` value out of a `{ id: '<id>', ... }` SECTIONS entry. */
const sectionGroup = (id: string): string | undefined => {
  const idx = appSource.indexOf(`id: '${id}'`)
  if (idx === -1) return undefined
  const chunk = appSource.slice(idx, appSource.indexOf('}', idx) + 1)
  return chunk.match(/group:\s*'(\w+)'/)?.[1]
}

describe('settings sidebar is text-only (R4: no icon tiles anywhere in Settings)', () => {
  it('does not carry an icon field on the SECTIONS entries', () => {
    // R4 kills icon tiles in the sidebar — locking this in guards against
    // regressing back to the pre-redesign icon-per-row nav.
    expect(appSource).not.toMatch(/icon:\s*\w*Icon/)
  })

  it('groups every non-utility section under Settings or Library (Stage redesign 7-cluster nav)', () => {
    // Each id's group is asserted directly (rather than checking that some
    // "SETTINGS_IDS"/"LIBRARY_IDS" constant exists) so the test still catches
    // a mis-grouped section regardless of how the grouping is implemented.
    const settingsIds = ['saving', 'browsing', 'sync', 'release']
    const libraryIds = ['archive', 'history']
    for (const id of settingsIds) expect(sectionGroup(id)).toBe('settings')
    for (const id of libraryIds) expect(sectionGroup(id)).toBe('library')
    expect(sectionGroup('about')).toBe('utility')
  })

  it('no longer carries the old 9-section ids (General/Downloads/Filters/Clearing/Cloud absorbed or renamed)', () => {
    for (const staleId of [
      'general',
      'downloads',
      'filters',
      'clearing',
      'cloud',
      'worklist',
      'capture',
    ]) {
      expect(sectionGroup(staleId)).toBeUndefined()
    }
  })
})

describe('settings sidebar order puts the account-changing Release panel last', () => {
  it('lists Downloads, Browsing, Sync, then Release', () => {
    const order = ['saving', 'browsing', 'sync', 'release'].map((id) =>
      appSource.indexOf(`id: '${id}'`),
    )
    expect(order.every((idx) => idx > -1)).toBe(true)
    expect(order.toSorted((a, b) => a - b)).toEqual(order)
  })
})

describe('the dead "Appearance · System" sidebar control-lookalike is gone', () => {
  it('does not render the bare Appearance line in the sidebar corner', () => {
    expect(appSource).not.toContain('Appearance · System')
  })
})

describe('hash aliases (§3.2 — add-only, every old deep-link must still resolve)', () => {
  it('defines every documented alias pair', () => {
    const pairs: ReadonlyArray<[string, string]> = [
      ['worklist', 'release'],
      ['clearing', 'release'],
      ['general', 'saving'],
      ['downloads', 'saving'],
      ['filters', 'saving'],
      ['cloud', 'sync'],
      ['capture', 'archive'],
    ]
    for (const [from, to] of pairs) {
      expect(appSource).toMatch(new RegExp(`${from}:\\s*'${to}'`))
    }
  })

  it('resolves through a lookup table, not the old single-ternary alias', () => {
    expect(appSource).toContain('isHashAlias(hash) ? HASH_ALIASES[hash] : hash')
    expect(appSource).not.toMatch(/hash === 'worklist' \? 'clearing' : hash/)
  })
})

describe('the "Saved" feedback timer is owned (cancel-before-rearm, unmount cleanup)', () => {
  it('arms one owned timer with the same 1400ms delay, then the exit step', () => {
    expect(appSource).toContain('const savedTimer = useOwnedTimer()')
    expect(appSource).toContain('savedTimer.arm(() => {')
    expect(appSource).toContain('savedTimer.arm(() => setSaved(false), TOAST_EXIT_MS)')
    expect(appSource).toContain('}, 1400)')
  })
})

describe('sidebar navigation landmarks are named by their visible labels', () => {
  it('Settings nav references its visible label exactly once each', () => {
    expect(appSource.match(/id="settings-nav-label"/g)).toHaveLength(1)
    expect(appSource.match(/aria-labelledby="settings-nav-label"/g)).toHaveLength(1)
  })

  it('Library nav references its visible label exactly once each', () => {
    expect(appSource.match(/id="library-nav-label"/g)).toHaveLength(1)
    expect(appSource.match(/aria-labelledby="library-nav-label"/g)).toHaveLength(1)
  })

  it('uses no aria-label or hidden duplicate for the nav landmarks', () => {
    const sidebar = appSource.slice(appSource.indexOf('function SettingsSidebar'))
    expect(sidebar).not.toMatch(/aria-label="/u)
    expect(sidebar).not.toContain('sr-only')
  })
})
describe('save-status toast live region (a11y announcement)', () => {
  it('uses semantic output tag, aria-atomic="true", and conditionally renders saved text', () => {
    expect(appSource).toContain('<output')
    expect(appSource).toContain('aria-live="polite"')
    expect(appSource).toContain('aria-atomic="true"')
    expect(appSource).toContain('{saved &&')
  })
})
