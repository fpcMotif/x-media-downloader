import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Source-grep pins (house idiom — see popup-layout.test.ts / worklist.test.ts):
// ConfirmStrip's safety properties (focus management, Escape handling, the
// typed-word Enter-inert gate, no keyboard accelerators) are structural
// contracts on the shipped source, not behavior worth mounting a DOM for.
const source = readFileSync('src/components/confirm-strip.tsx', 'utf8')

describe('ConfirmStrip source', () => {
  it('moves focus to the Cancel button on arm', () => {
    expect(source).toContain('cancelRef.current?.focus()')
  })

  it('handles Escape and refocuses the original trigger', () => {
    expect(source).toContain("e.key === 'Escape'")
    expect(source).toContain('triggerFocusRef.current?.focus()')
  })

  it('renders the confirm button aria-disabled while guarded (or the word is unmet)', () => {
    expect(source).toContain('aria-disabled={confirmInert}')
    expect(source).toContain('!guardElapsed')
  })

  it('makes Enter inert inside the typed-word input — the gate cannot fire on Enter alone', () => {
    expect(source).toContain("e.key === 'Enter'")
    expect(source).toContain('e.preventDefault()')
  })

  it('never binds a keyboard accelerator to the destructive confirm control', () => {
    expect(source).not.toContain('accesskey')
  })

  it('locks the confirm button out with pointer-events-none during the guard state', () => {
    expect(source).toContain('pointer-events-none')
  })

  it('arms only one strip at a time via the module-level registry', () => {
    expect(source).toContain('let disarmCurrent: (() => void) | null = null')
  })

  it('never renders the bare word "Confirm" as a button label', () => {
    expect(source).not.toContain('>Confirm<')
  })
})
