import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync('src/entrypoints/options/App.tsx', 'utf8')

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

  it('groups every non-utility section under Settings or Library', () => {
    // Each id's group is asserted directly (rather than checking that some
    // "SETTINGS_IDS"/"LIBRARY_IDS" constant exists) so the test still catches
    // a mis-grouped section regardless of how the grouping is implemented.
    const settingsIds = ['general', 'downloads', 'filters', 'clearing', 'capture', 'cloud']
    const libraryIds = ['archive', 'history']
    for (const id of settingsIds) expect(sectionGroup(id)).toBe('settings')
    for (const id of libraryIds) expect(sectionGroup(id)).toBe('library')
    expect(sectionGroup('about')).toBe('utility')
  })
})
