import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Source-grep pin (house idiom — see capture-quick-actions.test.ts).
const source = readFileSync('src/entrypoints/options/panels/archive.tsx', 'utf8')

describe('ArchivePanel status flash owns its timer', () => {
  it('flashStatus cancels the prior timer before rearming (latest flash wins)', () => {
    expect(source).toContain('clearTimeout(statusTimer.current)')
    expect(source).toContain(
      'statusTimer.current = setTimeout(() => {\n      setStatusMsg(null)',
    )
  })

  it('unmount cancels the pending flash timer', () => {
    expect(source).toContain('return () => clearTimeout(statusTimer.current)')
  })

  it('keeps the 5000ms flash delay', () => {
    expect(source).toContain('}, 5000)')
  })
})
