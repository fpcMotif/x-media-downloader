import { describe, expect, it } from 'vitest'
import { makeRecoveryEpoch } from './recovery-epoch'

describe('recovery epoch', () => {
  it('rejects a reply begun before Find new media clears and rescans', () => {
    const epoch = makeRecoveryEpoch()
    const stale = epoch.current()
    epoch.advance()
    expect(epoch.isCurrent(stale)).toBe(false)
    expect(epoch.isCurrent(epoch.current())).toBe(true)
  })
})
