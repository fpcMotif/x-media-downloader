import { describe, it, expect } from 'vitest'
import {
  beginSendAll,
  launcherAriaLabel,
  launcherStatusMessage,
  launcherSavedRevertMs,
  launcherFailedRevertMs,
  resolveOutcomeAll,
  resolveSendAll,
  settleLauncher,
} from '../launcher'

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
  })

  it('makes the visible Retry real: a failed batch re-arms to queued', () => {
    expect(beginSendAll('failed')).toBe('queued')
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

describe('launcher aria name and status copy', () => {
  it('names idle as the download action and stays silent', () => {
    expect(launcherAriaLabel('idle', 3)).toBe('Download all detected media (3)')
    expect(launcherStatusMessage('idle', 3)).toBe('')
  })

  it('announces the in-flight save', () => {
    expect(launcherAriaLabel('queued', 3)).toBe('Saving all detected media (3)')
    expect(launcherStatusMessage('queued', 3)).toBe('Saving 3 media items.')
  })

  it('announces success', () => {
    expect(launcherAriaLabel('saved', 3)).toBe('All detected media saved (3)')
    expect(launcherStatusMessage('saved', 3)).toBe('3 media items saved.')
  })

  it('offers a truthful retry on failure', () => {
    expect(launcherAriaLabel('failed', 3)).toBe('Retry all detected media (3)')
    expect(launcherStatusMessage('failed', 3)).toBe('Some media failed to save. Retry available.')
  })

  it('singularizes one media item', () => {
    expect(launcherStatusMessage('queued', 1)).toBe('Saving 1 media item.')
    expect(launcherStatusMessage('saved', 1)).toBe('1 media item saved.')
    expect(launcherAriaLabel('idle', 1)).toBe('Download all detected media (1)')
  })
})
