import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/entrypoints/options/panels/worklist.tsx', 'utf8')

describe('Worklist & clearing: CLEAR FROM sub-toggles are visually grouped', () => {
  it('wraps the conditional sub-toggles under a CLEAR FROM label, indented from the main toggle', () => {
    const mainToggleIdx = source.indexOf('id="clearOnSave"')
    const labelIdx = source.indexOf('CLEAR FROM')
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
})
