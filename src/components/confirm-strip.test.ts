import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Source-grep pins (house idiom — see popup-layout.test.ts / worklist.test.ts):
// ConfirmStrip's safety properties (focus management, Escape handling, the
// typed-word Enter-inert gate, no keyboard accelerators) are structural
// contracts on the shipped source, not behavior worth mounting a DOM for.
const source = readFileSync(fileURLToPath(import.meta.resolve('./confirm-strip.tsx')), 'utf8')

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
    expect(source).toContain("pointerEvents: 'none'")
  })

  it('arms only one strip at a time via the module-level registry', () => {
    expect(source).toContain('const armedStrip = (() => {')
    expect(source).toContain('holder?.disarm()')
    expect(source).toContain('armedStrip.take(owner, disarm)')
    expect(source).toContain('armedStrip.release(owner)')
  })

  it('hands arm to the trigger through a hook, never a render-prop call during render', () => {
    expect(source).toContain('export function useConfirmStrip(): ConfirmStripControl')
    expect(source).toContain('readonly children: VNode')
    expect(source).not.toContain('children(arm)')
  })

  it('never renders the bare word "Confirm" as a button label', () => {
    expect(source).not.toContain('>Confirm<')
  })

  it('mounts a single keyed live-region output node outside the idle/armed conditional', () => {
    expect(source).toContain('key="confirm-strip-output"')
    expect(source).toContain('const announceText = armedAt !== null')
  })

  it('auto-disarms from the tick itself, with no effect chained on now', () => {
    expect(source).toContain('if (tickedAt >= disarmDeadline(armedAt)) disarm()')
    expect(source).not.toContain('}, [now, armedAt, disarm])')
  })
})
