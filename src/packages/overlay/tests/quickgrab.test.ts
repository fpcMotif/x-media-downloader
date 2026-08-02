import { describe, it, expect } from 'vitest'
import {
  modifierHeld,
  isModifierKey,
  quickGrabDwellMs,
  quickGrabBadgeLabel,
  idleQuickGrab,
  pressModifier,
  releaseModifier,
  canGrab,
  markGrabbed,
  syncModifierFromFlags,
  allAugmentModifier,
  postGrabActive,
  markAllGrabbed,
  markWholePostGrabbed,
} from '../quickgrab'

const flags = (over: Partial<Record<'altKey' | 'shiftKey' | 'ctrlKey' | 'metaKey', boolean>>) => ({
  altKey: false,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  ...over,
})

describe('modifierHeld', () => {
  it('maps each modifier to its event flag', () => {
    expect(modifierHeld(flags({ altKey: true }), 'alt')).toBe(true)
    expect(modifierHeld(flags({ shiftKey: true }), 'shift')).toBe(true)
    expect(modifierHeld(flags({ ctrlKey: true }), 'ctrl')).toBe(true)
    expect(modifierHeld(flags({ metaKey: true }), 'meta')).toBe(true)
    expect(modifierHeld(flags({ shiftKey: true }), 'alt')).toBe(false)
  })
})

describe('isModifierKey', () => {
  it('matches the KeyboardEvent.key name for the modifier', () => {
    expect(isModifierKey('Alt', 'alt')).toBe(true)
    expect(isModifierKey('Control', 'ctrl')).toBe(true)
    expect(isModifierKey('Meta', 'meta')).toBe(true)
    expect(isModifierKey('a', 'alt')).toBe(false)
  })
})

describe('Quick Grab dwell threshold', () => {
  it('triggers after a 0.5s Alt-hover dwell', () => {
    expect(quickGrabDwellMs).toBe(500)
  })
})

describe('Quick Grab badge labels', () => {
  it('separates dwell, queued, started, repeat, and failed feedback', () => {
    expect(quickGrabBadgeLabel('charging')).toBe('Grabbing')
    expect(quickGrabBadgeLabel('queued')).toBe('Queued')
    expect(quickGrabBadgeLabel('saved')).toBe('Started')
    expect(quickGrabBadgeLabel('noted')).toBe('Already queued')
    expect(quickGrabBadgeLabel('failed')).toBe('Failed')
  })
})

describe('QuickGrab state machine', () => {
  it('arms on press and clears on release', () => {
    const armed = pressModifier(idleQuickGrab)
    expect(armed.active).toBe(true)
    expect(releaseModifier().active).toBe(false)
  })

  it('fires once per media item per press, re-grabbable after release', () => {
    let s = pressModifier(idleQuickGrab)
    expect(canGrab(s, 'P1')).toBe(true)
    s = markGrabbed(s, 'P1')
    expect(canGrab(s, 'P1')).toBe(false) // already grabbed this press
    expect(canGrab(s, 'P2')).toBe(true) // a different item still fires

    s = pressModifier(releaseModifier()) // release + fresh press
    expect(canGrab(s, 'P1')).toBe(true) // re-grabbable
  })

  it('never grabs while inactive', () => {
    expect(canGrab(idleQuickGrab, 'P1')).toBe(false)
  })

  it('ignores auto-repeat keydowns (does not re-arm grabbed items)', () => {
    const pressed = markGrabbed(pressModifier(idleQuickGrab), 'P1')
    const repeated = pressModifier(pressed) // key-repeat while held
    expect(repeated).toBe(pressed) // same reference: no reset
    expect(canGrab(repeated, 'P1')).toBe(false)
  })

  it('markGrabbed is idempotent', () => {
    const once = markGrabbed(pressModifier(idleQuickGrab), 'P1')
    expect(markGrabbed(once, 'P1')).toBe(once)
  })

  it('can arm from live pointer modifier flags when keydown was missed', () => {
    const synced = syncModifierFromFlags(idleQuickGrab, flags({ altKey: true }), 'alt')
    expect(synced.active).toBe(true)
    expect(canGrab(synced, 'V1')).toBe(true)
  })

  it('preserves grabbed items while the pointer still reports the modifier held', () => {
    const grabbed = markGrabbed(pressModifier(idleQuickGrab), 'V1')
    expect(syncModifierFromFlags(grabbed, flags({ altKey: true }), 'alt')).toBe(grabbed)
  })

  it('releases when the next pointer event no longer has the modifier', () => {
    const grabbed = markGrabbed(pressModifier(idleQuickGrab), 'V1')
    const synced = syncModifierFromFlags(grabbed, flags({}), 'alt')
    expect(synced.active).toBe(false)
    expect(canGrab(synced, 'V1')).toBe(false)
  })

  it('stays idle when an inactive state sees no modifier (no spurious release)', () => {
    expect(syncModifierFromFlags(idleQuickGrab, flags({}), 'alt')).toBe(idleQuickGrab)
  })
})

describe('allAugmentModifier', () => {
  it('is Meta for any non-meta base, and Alt when the base is already Meta', () => {
    expect(allAugmentModifier('alt')).toBe('meta')
    expect(allAugmentModifier('shift')).toBe('meta')
    expect(allAugmentModifier('ctrl')).toBe('meta')
    expect(allAugmentModifier('meta')).toBe('alt')
  })
})

describe('postGrabActive', () => {
  const held = flags({ altKey: true, metaKey: true }) // base=alt + augment=meta both held

  it('is true only when base is active and the augment is held', () => {
    expect(postGrabActive(true, held, 'alt')).toBe(true)
  })
  it('is false when the base modifier is not active', () => {
    expect(postGrabActive(false, held, 'alt')).toBe(false)
  })
  it('is false when the augment modifier is not held', () => {
    expect(postGrabActive(true, flags({ altKey: true }), 'alt')).toBe(false)
  })
})

describe('markAllGrabbed', () => {
  it('marks every key grabbed so none re-fire this press', () => {
    const s = markAllGrabbed(pressModifier(idleQuickGrab), ['A', 'B'])
    expect(canGrab(s, 'A')).toBe(false)
    expect(canGrab(s, 'B')).toBe(false)
    expect(canGrab(s, 'C')).toBe(true)
  })
  it('is a no-op (same reference) when every key is already grabbed', () => {
    const once = markAllGrabbed(pressModifier(idleQuickGrab), ['A', 'B'])
    expect(markAllGrabbed(once, ['A', 'B'])).toBe(once)
  })
  it('is a no-op (same reference) for an empty key list', () => {
    const s = pressModifier(idleQuickGrab)
    expect(markAllGrabbed(s, [])).toBe(s)
  })
})

describe('markWholePostGrabbed', () => {
  it('marks a rendered preview key even when it differs from every captured key', () => {
    const state = markWholePostGrabbed(pressModifier(idleQuickGrab), 'PREVIEW', ['ORIGINAL-A'])

    expect(canGrab(state, 'PREVIEW')).toBe(false)
    expect(canGrab(state, 'ORIGINAL-A')).toBe(false)
    expect(canGrab(state, 'OTHER')).toBe(true)
  })

  it('carries keyboard whole-post keys into the next modifier press, then clears them on release', () => {
    const primed = markWholePostGrabbed(idleQuickGrab, 'PREVIEW', ['ORIGINAL-A'])
    const pressed = pressModifier(primed)

    expect(canGrab(pressed, 'PREVIEW')).toBe(false)
    expect(canGrab(pressed, 'ORIGINAL-A')).toBe(false)
    expect(canGrab(pressModifier(releaseModifier()), 'PREVIEW')).toBe(true)
  })
})

describe('Quick Grab all-mode badge labels', () => {
  it('shows the whole-post variant with a count for queued/started', () => {
    expect(quickGrabBadgeLabel('charging', { count: 4 })).toBe('Grab all')
    expect(quickGrabBadgeLabel('queued', { count: 4 })).toBe('4 queued')
    expect(quickGrabBadgeLabel('saved', { count: 4 })).toBe('4 started')
    expect(quickGrabBadgeLabel('noted', { count: 4 })).toBe('Already queued')
    expect(quickGrabBadgeLabel('failed', { count: 4 })).toBe('Failed')
  })
  it('keeps the single-item labels when no all-mode descriptor is passed', () => {
    expect(quickGrabBadgeLabel('charging')).toBe('Grabbing')
    expect(quickGrabBadgeLabel('saved')).toBe('Started')
  })
})
