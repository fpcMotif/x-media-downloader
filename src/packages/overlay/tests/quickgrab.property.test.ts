// Property-based tests over the pure Quick Grab state machine in
// `../quickgrab` (imported via the package root, per src/packages/README.md).
import { describe, it } from 'vitest'
import * as fc from 'fast-check'
import {
  idleQuickGrab,
  pressModifier,
  releaseModifier,
  canGrab,
  markGrabbed,
  markAllGrabbed,
  syncModifierFromFlags,
  modifierHeld,
  allAugmentModifier,
  postGrabActive,
  type QuickGrabState,
  type ModifierFlags,
  type GrabModifier,
} from '../quickgrab'

const modArb: fc.Arbitrary<GrabModifier> = fc.constantFrom('alt', 'shift', 'ctrl', 'meta')

const flagsArb: fc.Arbitrary<ModifierFlags> = fc.record({
  altKey: fc.boolean(),
  shiftKey: fc.boolean(),
  ctrlKey: fc.boolean(),
  metaKey: fc.boolean(),
})

const keysArb = fc.array(fc.string(), { maxLength: 8 })
const activeArb = fc.boolean()

/** Builds an arbitrary reachable state: optionally pressed, with `keys`
 *  recorded grabbed (grabbing works whether active or not, mirroring how a
 *  bare `d d` whole-post payload can preseed `grabbed` before a press). */
const buildState = (keys: readonly string[], active: boolean): QuickGrabState =>
  markAllGrabbed(active ? pressModifier(idleQuickGrab) : idleQuickGrab, keys)

const setsEqual = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
  a.size === b.size && [...a].every((k) => b.has(k))

describe('markGrabbed / markAllGrabbed', () => {
  it('markGrabbed is idempotent: marking the same key twice is the same as marking it once', () => {
    fc.assert(
      fc.property(keysArb, activeArb, fc.string(), (keys, active, key) => {
        const state = buildState(keys, active)
        const once = markGrabbed(state, key)
        const twice = markGrabbed(once, key)
        return twice === once
      }),
    )
  })

  it('markAllGrabbed does not depend on the order the keys are marked in', () => {
    fc.assert(
      fc.property(keysArb, activeArb, (keys, active) => {
        const state = buildState([], active)
        const forward = markAllGrabbed(state, keys)
        const backward = markAllGrabbed(state, keys.toReversed())
        return setsEqual(forward.grabbed, backward.grabbed) && forward.active === backward.active
      }),
    )
  })
})

describe('canGrab', () => {
  it('is false for every key marked grabbed while active', () => {
    fc.assert(
      fc.property(keysArb, (keys) => {
        const state = markAllGrabbed(pressModifier(idleQuickGrab), keys)
        return keys.every((key) => canGrab(state, key) === false)
      }),
    )
  })
})

describe('releaseModifier', () => {
  it('always resets to idle regardless of the prior state, and a following press starts with an empty grabbed set', () => {
    fc.assert(
      fc.property(keysArb, activeArb, (keys, active) => {
        buildState(keys, active) // varies the prior state; releaseModifier ignores it entirely
        const released = releaseModifier()
        const repressed = pressModifier(released)
        return (
          released.active === false &&
          released.grabbed.size === 0 &&
          repressed.active === true &&
          repressed.grabbed.size === 0
        )
      }),
    )
  })
})

describe('syncModifierFromFlags', () => {
  it('is active iff the chosen modifier flag is held, and never mutates grabbed while staying active', () => {
    fc.assert(
      fc.property(keysArb, activeArb, flagsArb, modArb, (keys, active, flags, mod) => {
        const state = buildState(keys, active)
        const result = syncModifierFromFlags(state, flags, mod)
        const held = modifierHeld(flags, mod)
        if (result.active !== held) return false
        // Whenever the sync leaves grab mode active, grabbed must be the
        // exact same set (same reference) as before the sync — no key can
        // be silently dropped or added by a pointer-event reconciliation.
        if (result.active && result.grabbed !== state.grabbed) return false
        return true
      }),
    )
  })
})

describe('allAugmentModifier', () => {
  it('never returns the same modifier it was given', () => {
    fc.assert(fc.property(modArb, (base) => allAugmentModifier(base) !== base))
  })
})

describe('postGrabActive', () => {
  it('is false whenever the base modifier is not active, regardless of the flags or chosen modifier', () => {
    fc.assert(
      fc.property(flagsArb, modArb, (flags, mod) => postGrabActive(false, flags, mod) === false),
    )
  })
})
