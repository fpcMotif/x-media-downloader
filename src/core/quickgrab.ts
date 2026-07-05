import type { Settings } from './schema'

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

const BADGE_LABEL: Record<QuickGrabUiPhase, string> = {
  charging: 'Grabbing',
  queued: 'Queued',
  saved: 'Started',
  noted: 'Already queued',
  failed: 'Failed',
}

export function quickGrabBadgeLabel(phase: QuickGrabUiPhase): string {
  return BADGE_LABEL[phase]
}

const FLAG: Record<GrabModifier, keyof ModifierFlags> = {
  alt: 'altKey',
  shift: 'shiftKey',
  ctrl: 'ctrlKey',
  meta: 'metaKey',
}

/** `KeyboardEvent.key` for each modifier (for keydown/keyup detection). */
const KEY_NAME: Record<GrabModifier, string> = {
  alt: 'Alt',
  shift: 'Shift',
  ctrl: 'Control',
  meta: 'Meta',
}

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
 * Quick Grab arming state. `active` mirrors the held modifier; `grabbed` holds the
 * media keys already downloaded during the *current* press, so hovering one item
 * fires exactly once — the guard against a cursor sweep mass-downloading a grid.
 * Releasing the modifier forgets the set, so a fresh press can re-grab.
 */
export interface QuickGrabState {
  readonly active: boolean
  readonly grabbed: ReadonlySet<string>
}

export const idleQuickGrab: QuickGrabState = { active: false, grabbed: new Set() }

/**
 * Enter grab mode. Idempotent across auto-repeat keydowns: only the first press
 * (when not already `active`) resets the grabbed set, so holding the key down
 * doesn't re-arm already-grabbed items.
 */
export function pressModifier(state: QuickGrabState): QuickGrabState {
  return state.active ? state : { active: true, grabbed: new Set() }
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
