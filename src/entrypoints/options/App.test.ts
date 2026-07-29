import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync('src/entrypoints/options/App.tsx', 'utf8')

/** Pull the `group: '<...>'` value out of a `{ id: '<id>', ... }` SECTIONS entry. */
const sectionGroup = (id: string): string | undefined => {
  const idx = appSource.search(new RegExp(`id:\\s*['"]${id}['"]`))
  if (idx === -1) return undefined
  const chunk = appSource.slice(idx, appSource.indexOf('}', idx) + 1)
  return chunk.match(/group:\s*['"](\w+)['"]/)?.[1]
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
    const settingsIds = ['saving', 'release', 'capture', 'sync']
    const libraryIds = ['archive', 'history']
    for (const id of settingsIds) expect(sectionGroup(id)).toBe('settings')
    for (const id of libraryIds) expect(sectionGroup(id)).toBe('library')
    expect(sectionGroup('about')).toBe('utility')
  })

  it('no longer carries the old 9-section ids (General/Downloads/Filters/Clearing/Cloud absorbed or renamed)', () => {
    for (const staleId of ['general', 'downloads', 'filters', 'clearing', 'cloud', 'worklist']) {
      expect(sectionGroup(staleId)).toBeUndefined()
    }
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
    ]
    for (const [from, to] of pairs) {
      expect(appSource).toMatch(new RegExp(`${from}:\\s*['"]${to}['"]`))
    }
  })

  it('resolves through a lookup table, not the old single-ternary alias', () => {
    expect(appSource).toContain('HASH_ALIASES[hash] ?? hash')
    expect(appSource).not.toMatch(/hash === 'worklist' \? 'clearing' : hash/)
  })
})

describe('Settings recovery warning', () => {
  it('explains the global safe projection and links to Recovery', () => {
    expect(appSource).toMatch(
      /Safe Direct mode is active\. Cloud upload, Cloud Sync, Clear, and Capture Mirror\s*are paused\./,
    )
    expect(appSource).toContain("onClick={() => select('recovery')}")
    expect(appSource).toContain('inspectSettingsRecovery')
    expect(appSource).toContain('await refreshSettingsRecovery()')
    expect(appSource).not.toContain('watchSettings')
  })
})
