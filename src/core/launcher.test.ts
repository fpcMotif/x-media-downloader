import { describe, it, expect } from 'vitest'
import {
  beginSendAll,
  launcherSavedRevertMs,
  launcherFailedRevertMs,
  resolveOutcomeAll,
  resolveSendAll,
  settleLauncher,
} from './launcher'

describe('launcher revert constants', () => {
  it('lingers a saved confirmation briefly and a failure notice longer', () => {
    expect(launcherSavedRevertMs).toBe(1600)
    expect(launcherFailedRevertMs).toBe(4000)
    // A failure must outlast a save so the user can read the Retry affordance.
    expect(launcherFailedRevertMs).toBeGreaterThan(launcherSavedRevertMs)
  })
})

describe('beginSendAll', () => {
  it('arms an idle pill to queued', () => {
    expect(beginSendAll('idle')).toBe('queued')
  })

  it('is a no-op while a hand-off is in flight or a confirmation still lingers', () => {
    expect(beginSendAll('queued')).toBe('queued')
    expect(beginSendAll('saved')).toBe('saved')
    expect(beginSendAll('failed')).toBe('failed')
  })
})

describe('resolveSendAll', () => {
  it('settles an in-flight queue to saved on a start ack and failed otherwise', () => {
    expect(resolveSendAll('queued', true)).toBe('saved')
    expect(resolveSendAll('queued', false)).toBe('failed')
  })

  it('only resolves the in-flight queue — every other phase is left untouched', () => {
    // A late background reply must not retro-flip a pill that already settled or
    // was reset (the SPA-navigation / settings-toggle reset path sets it to idle).
    expect(resolveSendAll('idle', true)).toBe('idle')
    expect(resolveSendAll('idle', false)).toBe('idle')
    expect(resolveSendAll('saved', false)).toBe('saved')
    expect(resolveSendAll('failed', true)).toBe('failed')
  })
})

describe('settleLauncher', () => {
  it('expires a settled confirmation back to idle', () => {
    expect(settleLauncher('saved')).toBe('idle')
    expect(settleLauncher('failed')).toBe('idle')
  })

  it('leaves idle and in-flight phases put', () => {
    expect(settleLauncher('idle')).toBe('idle')
    expect(settleLauncher('queued')).toBe('queued')
  })
})

describe('resolveOutcomeAll (late per-item outcome)', () => {
  it('downgrades a saved pill to failed when an item actually failed to land', () => {
    // The start ack optimistically said "saved"; a later 403/timeout corrects it.
    expect(resolveOutcomeAll('saved', false)).toBe('failed')
    expect(resolveOutcomeAll('queued', false)).toBe('failed')
  })

  it('leaves the pill untouched on a late success (other items may still be in flight)', () => {
    expect(resolveOutcomeAll('saved', true)).toBe('saved')
    expect(resolveOutcomeAll('queued', true)).toBe('queued')
  })

  it('never resurrects a settled-to-idle or already-failed pill', () => {
    expect(resolveOutcomeAll('idle', false)).toBe('idle')
    expect(resolveOutcomeAll('idle', true)).toBe('idle')
    expect(resolveOutcomeAll('failed', false)).toBe('failed')
  })
})
