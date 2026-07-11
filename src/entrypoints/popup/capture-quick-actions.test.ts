import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Source-grep pin (house idiom — see App.test.ts / worklist.test.ts): the
// component has no DOM-rendering harness available in this repo, so its
// mount/unmount contract is pinned on the shipped source.
const source = readFileSync('src/entrypoints/popup/capture-quick-actions.tsx', 'utf8')

describe('CaptureQuickActions stays mounted while an erase flash is pending (Batch B adversarial review)', () => {
  it('early-returns only when tweets is 0 AND no flash is pending, not on tweets===0 alone', () => {
    // A bare `if (tweets === 0) return null` unmounts the block in the same
    // batched render that eraseArchive sets statusMsg — the "Erased {n}
    // tweets…" flash could never paint. The fix keeps the block mounted
    // until its own flashStatus timeout clears statusMsg.
    expect(source).toContain('if (tweets === 0 && statusMsg === null) return null')
    expect(source).not.toMatch(/if \(tweets === 0\) return null/u)
  })

  it('flashStatus is still the sole owner of clearing statusMsg (no early unmount races it)', () => {
    expect(source).toContain('setTimeout(() => setStatusMsg(null), 5000)')
  })
})
