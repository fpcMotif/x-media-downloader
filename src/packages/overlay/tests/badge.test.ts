import { describe, it, expect } from 'vitest'
import {
  hiddenBadge,
  badgeNudgeDelayMs,
  badgeSavedRevertMs,
  badgeAriaLabel,
  badgeStatusMessage,
  canShowBadge,
  enterMedia,
  leaveMedia,
  nudgeBadge,
  beginSave,
  resolveSave,
  resolveOutcome,
} from '../badge'

const showable = { enabled: true, resolvable: true, modifierHeld: false }

describe('badge timing constants', () => {
  it('nudges after a 2.2s unclicked dwell and reverts saved after 1.6s', () => {
    expect(badgeNudgeDelayMs).toBe(2200)
    expect(badgeSavedRevertMs).toBe(1600)
  })
})

describe('canShowBadge', () => {
  it('shows only for resolvable media with the setting on and no modifier held', () => {
    expect(canShowBadge(showable)).toBe(true)
    expect(canShowBadge({ ...showable, enabled: false })).toBe(false)
    expect(canShowBadge({ ...showable, resolvable: false })).toBe(false)
    expect(canShowBadge({ ...showable, modifierHeld: true })).toBe(false)
  })
})

describe('badge entrance', () => {
  it('shows for a resolvable item when enabled', () => {
    const s = enterMedia(hiddenBadge, 'P1', showable)
    expect(s.phase).toBe('shown')
    expect(s.key).toBe('P1')
  })

  it('never shows when the setting is off', () => {
    expect(enterMedia(hiddenBadge, 'P1', { ...showable, enabled: false })).toBe(hiddenBadge)
  })

  it('never shows for unresolvable media', () => {
    expect(enterMedia(hiddenBadge, 'P1', { ...showable, resolvable: false })).toBe(hiddenBadge)
  })

  it('hides while the Quick Grab modifier is held', () => {
    const shown = enterMedia(hiddenBadge, 'P1', showable)
    const held = enterMedia(shown, 'P1', { ...showable, modifierHeld: true })
    expect(held.phase).toBe('hidden')
  })

  it('re-entering the same shown key is a no-op', () => {
    const shown = enterMedia(hiddenBadge, 'P1', showable)
    expect(enterMedia(shown, 'P1', showable)).toBe(shown)
  })

  it('entering a different key replaces the entrance, even mid-save', () => {
    const queued = beginSave(enterMedia(hiddenBadge, 'P1', showable))
    const next = enterMedia(queued, 'P2', showable)
    expect(next.phase).toBe('shown')
    expect(next.key).toBe('P2')
  })
})

describe('badge nudge', () => {
  it('nudges once per entrance', () => {
    const shown = enterMedia(hiddenBadge, 'P1', showable)
    const nudged = nudgeBadge(shown)
    expect(nudged.phase).toBe('nudged')
    expect(nudged.key).toBe('P1')
    expect(nudgeBadge(nudged)).toBe(nudged) // a second nudge is rejected
  })

  it('never nudges hidden, queued, saved, or failed badges', () => {
    expect(nudgeBadge(hiddenBadge)).toBe(hiddenBadge)
    const queued = beginSave(enterMedia(hiddenBadge, 'P1', showable))
    expect(nudgeBadge(queued)).toBe(queued)
    const saved = resolveSave(queued, true)
    expect(nudgeBadge(saved)).toBe(saved)
    const failed = resolveSave(beginSave(enterMedia(hiddenBadge, 'P2', showable)), false)
    expect(nudgeBadge(failed)).toBe(failed)
  })

  it('a fresh entrance may nudge again', () => {
    const first = nudgeBadge(enterMedia(hiddenBadge, 'P1', showable))
    const again = nudgeBadge(enterMedia(leaveMedia(first), 'P1', showable))
    expect(again.phase).toBe('nudged')
  })
})

describe('badge save flow', () => {
  it('click queues from shown, then a start ack saves', () => {
    const queued = beginSave(enterMedia(hiddenBadge, 'P1', showable))
    expect(queued.phase).toBe('queued')
    expect(queued.key).toBe('P1')
    const saved = resolveSave(queued, true)
    expect(saved.phase).toBe('saved')
    expect(saved.key).toBe('P1')
  })

  it('click queues from nudged too', () => {
    const queued = beginSave(nudgeBadge(enterMedia(hiddenBadge, 'P1', showable)))
    expect(queued.phase).toBe('queued')
  })

  it('a start failure lands in failed and a second click retries', () => {
    const failed = resolveSave(beginSave(enterMedia(hiddenBadge, 'P1', showable)), false)
    expect(failed.phase).toBe('failed')
    expect(beginSave(failed).phase).toBe('queued')
  })

  it('beginSave is a no-op for hidden, queued, and saved badges', () => {
    expect(beginSave(hiddenBadge)).toBe(hiddenBadge)
    const queued = beginSave(enterMedia(hiddenBadge, 'P1', showable))
    expect(beginSave(queued)).toBe(queued)
    const saved = resolveSave(queued, true)
    expect(beginSave(saved)).toBe(saved)
  })

  it('resolveSave only resolves an in-flight queue', () => {
    expect(resolveSave(hiddenBadge, true)).toBe(hiddenBadge)
    const shown = enterMedia(hiddenBadge, 'P1', showable)
    expect(resolveSave(shown, false)).toBe(shown)
  })
})

describe('resolveOutcome (late terminal outcome corrects the optimistic save)', () => {
  it('flips an optimistically-saved badge to failed when the bytes never landed', () => {
    // The start ack saved the badge the instant the request was handed off; the
    // real 403/timeout arrives ~seconds later and must correct the green check.
    const saved = resolveSave(beginSave(enterMedia(hiddenBadge, 'P1', showable)), true)
    const corrected = resolveOutcome(saved, false)
    expect(corrected.phase).toBe('failed')
    expect(corrected.key).toBe('P1')
  })

  it('a confirmed completion on an already-saved badge is a same-reference no-op', () => {
    // Same ref so the caller never cancels the pending saved→shown revert timer.
    const saved = resolveSave(beginSave(enterMedia(hiddenBadge, 'P1', showable)), true)
    expect(resolveOutcome(saved, true)).toBe(saved)
  })

  it('also resolves a still-queued entrance (outcome beat the start ack)', () => {
    const queued = beginSave(enterMedia(hiddenBadge, 'P1', showable))
    expect(resolveOutcome(queued, true).phase).toBe('saved')
    expect(resolveOutcome(queued, false).phase).toBe('failed')
  })

  it('never touches an entrance that moved on, reverted to shown, or already failed', () => {
    expect(resolveOutcome(hiddenBadge, false)).toBe(hiddenBadge)
    const shown = enterMedia(hiddenBadge, 'P1', showable)
    expect(resolveOutcome(shown, false)).toBe(shown) // reverted to the idle arrow
    const failed = resolveSave(beginSave(enterMedia(hiddenBadge, 'P2', showable)), false)
    expect(resolveOutcome(failed, true)).toBe(failed)
  })
})

describe('leaving the media', () => {
  it('resets shown, nudged, saved, and failed entrances to hidden', () => {
    const shown = enterMedia(hiddenBadge, 'P1', showable)
    expect(leaveMedia(shown)).toBe(hiddenBadge)
    expect(leaveMedia(nudgeBadge(shown))).toBe(hiddenBadge)
    const queued = beginSave(shown)
    expect(leaveMedia(resolveSave(queued, true))).toBe(hiddenBadge)
    expect(leaveMedia(resolveSave(queued, false))).toBe(hiddenBadge)
  })

  it('leaves an already-hidden badge as the same reference', () => {
    expect(leaveMedia(hiddenBadge)).toBe(hiddenBadge)
  })
})

describe('badge aria name and status copy', () => {
  it('names idle phases as the download action per type', () => {
    for (const phase of ['hidden', 'shown', 'nudged'] as const) {
      expect(badgeAriaLabel(phase, 'photo')).toBe('Download photo')
      expect(badgeAriaLabel(phase, 'video')).toBe('Download video')
      expect(badgeAriaLabel(phase, 'gif')).toBe('Download GIF')
      expect(badgeStatusMessage(phase, 'photo')).toBe('')
      expect(badgeStatusMessage(phase, 'video')).toBe('')
      expect(badgeStatusMessage(phase, 'gif')).toBe('')
    }
  })

  it('announces the in-flight save', () => {
    expect(badgeAriaLabel('queued', 'photo')).toBe('Saving photo')
    expect(badgeStatusMessage('queued', 'photo')).toBe('Saving photo.')
    expect(badgeAriaLabel('queued', 'video')).toBe('Saving video')
    expect(badgeStatusMessage('queued', 'video')).toBe('Saving video.')
    expect(badgeAriaLabel('queued', 'gif')).toBe('Saving GIF')
    expect(badgeStatusMessage('queued', 'gif')).toBe('Saving GIF.')
  })

  it('announces success with an uppercase GIF', () => {
    expect(badgeAriaLabel('saved', 'photo')).toBe('Photo saved')
    expect(badgeStatusMessage('saved', 'photo')).toBe('Photo saved.')
    expect(badgeAriaLabel('saved', 'video')).toBe('Video saved')
    expect(badgeStatusMessage('saved', 'video')).toBe('Video saved.')
    expect(badgeAriaLabel('saved', 'gif')).toBe('GIF saved')
    expect(badgeStatusMessage('saved', 'gif')).toBe('GIF saved.')
  })

  it('offers a truthful retry on failure', () => {
    expect(badgeAriaLabel('failed', 'photo')).toBe('Retry photo download')
    expect(badgeStatusMessage('failed', 'photo')).toBe('Photo save failed. Retry available.')
    expect(badgeAriaLabel('failed', 'video')).toBe('Retry video download')
    expect(badgeStatusMessage('failed', 'video')).toBe('Video save failed. Retry available.')
    expect(badgeAriaLabel('failed', 'gif')).toBe('Retry GIF download')
    expect(badgeStatusMessage('failed', 'gif')).toBe('GIF save failed. Retry available.')
  })
})
