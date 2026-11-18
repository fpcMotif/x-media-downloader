import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Source-grep pin (house idiom — see App.test.ts / worklist.test.ts): the
// component has no DOM-rendering harness available in this repo, so its
// mount/unmount contract is pinned on the shipped source.
const source = readFileSync(
  fileURLToPath(import.meta.resolve('./capture-quick-actions.tsx')),
  'utf8',
)

describe('CaptureQuickActions stays mounted while an erase flash is pending (Batch B adversarial review)', () => {
  it('early-returns only when tweets is 0 AND no flash is pending, not on tweets===0 alone', () => {
    // A bare `if (tweets === 0) return null` unmounts the block in the same
    // batched render that eraseArchive sets statusMsg — the "Erased {n}
    // tweets…" flash could never paint. The fix keeps the block mounted
    // until its own flashStatus timeout clears statusMsg.
    expect(source).toContain('if (tweets === 0 && statusMsg === null) return null')
    expect(source).not.toMatch(/if \(tweets === 0\) return null/u)
  })

  it('flashes through one owned timer, which cancels on rearm and unmount', () => {
    expect(source).toContain('const statusTimer = useOwnedTimer()')
    expect(source).toContain('statusTimer.arm(() => setStatusMsg(null), 5000)')
  })

  it('mounts the live region output node in the persistent container outside the open conditional', () => {
    expect(source).toContain(
      '</Collapse>\n\n      <Collapse open={statusMsg !== null}>\n        <output\n          aria-live="polite"',
    )
    expect(source).not.toMatch(/\{statusMsg !== null && \(\s*<output/u)
  })
})
