import { describe, it, expect } from 'vitest'
import {
  modifierHeld,
  isModifierKey,
  idleQuickGrab,
  pressModifier,
  releaseModifier,
  canGrab,
  markGrabbed,
} from './quickgrab'

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

describe('QuickGrab state machine', () => {
  it('arms on press and clears on release', () => {
    const armed = pressModifier(idleQuickGrab)
    expect(armed.active).toBe(true)
    expect(releaseModifier().active).toBe(false)
  })

  it('fires once per photo per press, re-grabbable after release', () => {
    let s = pressModifier(idleQuickGrab)
    expect(canGrab(s, 'P1')).toBe(true)
    s = markGrabbed(s, 'P1')
    expect(canGrab(s, 'P1')).toBe(false) // already grabbed this press
    expect(canGrab(s, 'P2')).toBe(true) // a different photo still fires

    s = pressModifier(releaseModifier()) // release + fresh press
    expect(canGrab(s, 'P1')).toBe(true) // re-grabbable
  })

  it('never grabs while inactive', () => {
    expect(canGrab(idleQuickGrab, 'P1')).toBe(false)
  })

  it('ignores auto-repeat keydowns (does not re-arm grabbed photos)', () => {
    const pressed = markGrabbed(pressModifier(idleQuickGrab), 'P1')
    const repeated = pressModifier(pressed) // key-repeat while held
    expect(repeated).toBe(pressed) // same reference: no reset
    expect(canGrab(repeated, 'P1')).toBe(false)
  })

  it('markGrabbed is idempotent', () => {
    const once = markGrabbed(pressModifier(idleQuickGrab), 'P1')
    expect(markGrabbed(once, 'P1')).toBe(once)
  })
})
