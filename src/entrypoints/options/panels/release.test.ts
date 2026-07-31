import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/entrypoints/options/panels/release.tsx', 'utf8')

describe('Release panel: tier + verb system (Stage redesign)', () => {
  it('carries the destructive "Account" tier badge on its header', () => {
    expect(source).toContain('Release')
    expect(source).toContain('variant="destructive"')
    expect(source).toContain('Account')
  })

  it('never calls itself "Clearing" or uses the bare "Clear from" label', () => {
    expect(source).not.toContain('Clearing')
    expect(source).not.toMatch(/>Clear from</)
  })

  it('wraps the Release-after-download sub-toggles under a "Release from" label, indented from the main toggle', () => {
    const mainToggleIdx = source.indexOf('id="clearOnSave"')
    const labelIdx = source.indexOf('Release from')
    const firstSubToggleIdx = source.indexOf('autoUnbookmarkOnSave')
    expect(mainToggleIdx).toBeGreaterThan(-1)
    expect(labelIdx).toBeGreaterThan(mainToggleIdx)
    expect(firstSubToggleIdx).toBeGreaterThan(labelIdx)
  })

  it('keeps the trailing hint text after the grouped sub-toggles', () => {
    const lastToggleIdx = source.indexOf('clearAllListsOnSave')
    const hintIdx = source.indexOf('Run the worklist from the toolbar popup')
    expect(lastToggleIdx).toBeGreaterThan(-1)
    expect(hintIdx).toBeGreaterThan(lastToggleIdx)
  })

  it('gates the toggle-ON transition behind a ConfirmStrip, never a native confirm()', () => {
    expect(source).toContain('ConfirmStrip')
    expect(source).toContain('kind="pre-committed"')
    expect(source).not.toMatch(/\bconfirm\(/)
  })

  it('documents the popup-only release rows, including the typed-word gate', () => {
    const docIdx = source.indexOf('Release from the popup')
    expect(docIdx).toBeGreaterThan(-1)
    expect(source.indexOf('Release the whole list', docIdx)).toBeGreaterThan(docIdx)
    expect(source.indexOf('RELEASE', docIdx)).toBeGreaterThan(docIdx)
  })

  it('never binds a keyboard accelerator to a destructive control', () => {
    expect(source).not.toContain('accesskey')
  })

  it('offers the mutation-observation toggle inside the Diagnostics section, off by default, above the export button', () => {
    const sectionIdx = source.indexOf('title="Diagnostics"')
    const toggleIdx = source.indexOf('id="releaseMutationDiagnosticsEnabled"')
    const exportIdx = source.indexOf('Export diagnostics')
    expect(sectionIdx).toBeGreaterThan(-1)
    expect(toggleIdx).toBeGreaterThan(sectionIdx)
    expect(exportIdx).toBeGreaterThan(toggleIdx)
    expect(source).toContain('Off by default')
  })
})
