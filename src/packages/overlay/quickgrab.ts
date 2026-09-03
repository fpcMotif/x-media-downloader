import type { Settings } from '@/packages/schema'

/** The modifier a user holds to enter Quick Grab mode. */
export type GrabModifier = Settings['quickGrabModifier']

/** Modifier-key flags as they appear on a pointer or keyboard event. */
export interface ModifierFlags {
  readonly altKey: boolean
  readonly shiftKey: boolean
  readonly ctrlKey: boolean
  readonly metaKey: boolean
}

/** Intentional modifier-hover dwell before Quick Grab starts a download. */
export const quickGrabDwellMs = 500

export type QuickGrabUiPhase = 'charging' | 'queued' | 'saved' | 'noted' | 'failed'

const BADGE_LABEL = {
  charging: 'Grabbing',
  queued: 'Queued',
  saved: 'Started',
  noted: 'Already queued',
  failed: 'Failed',
} satisfies Record<QuickGrabUiPhase, string>

const ALL_BADGE_LABEL = {
  charging: () => 'Grab all',
  queued: (n) => `${n} queued`,
  saved: (n) => `${n} started`,
  noted: () => 'Already queued',
  failed: () => 'Failed',
} satisfies Record<QuickGrabUiPhase, (count: number) => string>

export function quickGrabBadgeLabel(phase: QuickGrabUiPhase, all?: { count: number }): string {
  return all ? ALL_BADGE_LABEL[phase](all.count) : BADGE_LABEL[phase]
}

const FLAG = {
  alt: 'altKey',
  shift: 'shiftKey',
  ctrl: 'ctrlKey',
  meta: 'metaKey',
} satisfies Record<GrabModifier, keyof ModifierFlags>

/** `KeyboardEvent.key` for each modifier (for keydown/keyup detection). */
const KEY_NAME = {
  alt: 'Alt',
  shift: 'Shift',
  ctrl: 'Control',
  meta: 'Meta',
} satisfies Record<GrabModifier, string>

/** Whether the chosen modifier is currently held on this event. */
export function modifierHeld(e: ModifierFlags, mod: GrabModifier): boolean {
  return e[FLAG[mod]]
}

/** Whether a key event's `key` is the chosen modifier itself. */
export function isModifierKey(key: string, mod: GrabModifier): boolean {
  return key === KEY_NAME[mod]
}

/**
 * The second modifier the user adds on top of the Quick Grab modifier to grab
 * the WHOLE post instead of one item. Meta (Cmd) by default; falls back to Alt
 * when the base modifier is itself Meta, so the two can never be the same key.
 */
export function allAugmentModifier(base: GrabModifier): GrabModifier {
  return base === 'meta' ? 'alt' : 'meta'
}

/**
 * Whether a hover-dwell should grab the WHOLE post rather than one item:
 * the Quick Grab modifier is active and the augment modifier
 * ({@link allAugmentModifier}) is also held. `flags` is any pointer/keyboard
 * event (both carry the modifier flags). Enabled on every platform — the
 * 2026-07-05 Instagram/Threads-only scoping is superseded by issue #57.
 */
export function postGrabActive(
  baseActive: boolean,
  flags: ModifierFlags,
  base: GrabModifier,
): boolean {
  return baseActive && modifierHeld(flags, allAugmentModifier(base))
}

/**
 * Quick Grab arming state. `active` mirrors the held modifier; `grabbed` holds
 * media keys already downloaded in the current press, plus a bare `d d`
 * whole-post payload waiting for its next modifier press. Releasing the
 * modifier forgets the set, so a fresh press can re-grab.
 */
export interface QuickGrabState {
  readonly active: boolean
  readonly grabbed: ReadonlySet<string>
}

export const idleQuickGrab: QuickGrabState = { active: false, grabbed: new Set() }

/**
 * Enter grab mode. Idempotent across auto-repeat keydowns and preserves keys
 * preseeded by a bare `d d` whole-post action until this modifier is released.
 */
export function pressModifier(state: QuickGrabState): QuickGrabState {
  return state.active ? state : { active: true, grabbed: state.grabbed }
}

/** Leave grab mode and forget what was grabbed this press. */
export function releaseModifier(): QuickGrabState {
  return idleQuickGrab
}

/** Whether hovering `key` should fire a grab now: active and not yet grabbed. */
export function canGrab(state: QuickGrabState, key: string): boolean {
  return state.active && !state.grabbed.has(key)
}

/** Reconcile grab mode with live pointer-event modifier flags. */
export function syncModifierFromFlags(
  state: QuickGrabState,
  e: ModifierFlags,
  mod: GrabModifier,
): QuickGrabState {
  return modifierHeld(e, mod) ? pressModifier(state) : state.active ? releaseModifier() : state
}

/** Record that `key` was grabbed during this press (idempotent). */
export function markGrabbed(state: QuickGrabState, key: string): QuickGrabState {
  if (state.grabbed.has(key)) return state
  const grabbed = new Set(state.grabbed)
  grabbed.add(key)
  return { ...state, grabbed }
}

/** Record that every key in `keys` was grabbed this press (idempotent; returns
 *  the same state object when nothing changed). */
export function markAllGrabbed(state: QuickGrabState, keys: Iterable<string>): QuickGrabState {
  let next = state
  for (const key of keys) next = markGrabbed(next, key)
  return next
}

/**
 * Record a whole-post Quick Grab: the rendered preview key plus every resolved
 * Original-quality key. The preview can differ from the tee's captured keys.
 */
export function markWholePostGrabbed(
  state: QuickGrabState,
  previewKey: string,
  keys: Iterable<string>,
): QuickGrabState {
  return markAllGrabbed(markGrabbed(state, previewKey), keys)
}
