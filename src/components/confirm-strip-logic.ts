// Pure timing/matching helpers for ConfirmStrip (confirm-strip.tsx). No DOM,
// no state — every function is a deterministic transform over wall-clock
// timestamps (`Date.now()`-shaped numbers) so the strip's safety properties
// (guard lockout, auto-disarm, outside-click grace) are unit-testable without
// mounting anything. See spec §2.4/§2.5.
//
// The guard window is a pointer LOCKOUT, not an animation duration — it must
// never be shortened by `prefers-reduced-motion` (that CSS media query only
// zeroes `transition-duration`/`animation-duration`; because this module
// computes elapsed-ness from timestamps instead of relying on a CSS
// transition finishing, the lockout holds regardless of the user's motion
// preference).

/** `one-shot` = Release page/list, Erase archive/history (450ms).
 *  `pre-committed` = the settings toggle-ON gate, already a lower-stakes
 *  reversible-by-toggling-back action (250ms). */
export type GuardKind = 'one-shot' | 'pre-committed'

const GUARD_MS = {
  'one-shot': 450,
  'pre-committed': 250,
} satisfies Record<GuardKind, number>

const AUTO_DISARM_MS = 8000
const UNDERLINE_LEAD_MS = 2000
const OUTSIDE_CLICK_GRACE_MS = 300

/** The confirm-button guard window length, in ms, for a strip's tier. */
export function guardMs(kind: GuardKind): number {
  return GUARD_MS[kind]
}

/** Whether the confirm button's pointer lockout has elapsed. `>=` at the
 *  boundary — a click landing at exactly the guard's edge is allowed. */
export function isGuardElapsed(armedAt: number, now: number, kind: GuardKind): boolean {
  return now - armedAt >= guardMs(kind)
}

/** The timestamp at which an armed strip auto-disarms (8s after arming). */
export function disarmDeadline(armedAt: number): number {
  return armedAt + AUTO_DISARM_MS
}

/** The timestamp at which the shrinking auto-disarm underline should start
 *  showing (the last 2s before `disarmDeadline`). */
export function underlineStart(armedAt: number): number {
  return armedAt + AUTO_DISARM_MS - UNDERLINE_LEAD_MS
}

/** Whether an outside click at `now` should disarm the strip — false inside
 *  the first 300ms after arming, so the same click/tap that arms the strip
 *  (a "reading position" click just past the trigger) can't also cancel it. */
export function outsideClickArmed(armedAt: number, now: number): boolean {
  return now - armedAt > OUTSIDE_CLICK_GRACE_MS
}

/** The whole-list typed-word gate's match rule: trimmed, case-insensitive
 *  equality against `word` (default `'release'` — the only typed-word gate in
 *  the product today, §2.5). */
export function typedWordSatisfied(value: string, word = 'release'): boolean {
  return value.trim().toLowerCase() === word.toLowerCase()
}
