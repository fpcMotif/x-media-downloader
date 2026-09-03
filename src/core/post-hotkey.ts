/**
 * The vim-style `d d` whole-post hotkey: two bare `d` presses inside a short
 * window grab every detected media item of the current post (hovered, else
 * X's j/k-focused). Bare `d` is unbound on x.com, so the hotkey never steals
 * an X shortcut — but bare `g` arms X's two-key chords (`g d` opens display
 * settings), and those keys belong to X, never to us.
 *
 * Pure reducer over a readonly state record, in the `quickgrab.ts` idiom: no
 * DOM, no timers — the windows are exported constants the caller schedules
 * against `Date.now()`.
 */

/** How long a first bare `d` stays armed waiting for the second. */
export const POST_GRAB_DOUBLE_TAP_MS = 800

/** How long a bare `g` arms X's two-key chords (`g d`, `g h`, `g s`, …). */
export const X_G_CHORD_MS = 1000

/**
 * Hotkey sequence state. `dArmedAt` is the timestamp of the first bare `d`
 * (0 = none pending); `gArmedAt` is the timestamp of the bare `g` that armed
 * X's chord window (0 = none pending).
 */
export interface PostHotkeyState {
  readonly dArmedAt: number
  readonly gArmedAt: number
}

export const idlePostHotkey: PostHotkeyState = { dArmedAt: 0, gArmedAt: 0 }

export type PostHotkeyAction = 'armed' | 'fire' | null

/** The reducer's view of one keydown — copied off the event by the caller
 *  (`KeyboardEvent` properties are prototype getters and do not survive an
 *  object spread). */
export interface PostHotkeyEvent {
  readonly key: string
  readonly altKey: boolean
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly repeat: boolean
  readonly target: EventTarget | null
}

/** Whether `target` is an editable element (input/textarea/select or
 *  contentEditable) — keydowns there are text input, never hotkey presses. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName)
}

const isBare = (e: PostHotkeyEvent, key: string): boolean =>
  e.key === key && !e.altKey && !e.ctrlKey && !e.metaKey && !e.repeat

/**
 * Feed one keydown; returns the next state and what to do. Rules:
 * - Typing targets leave the sequence untouched (text is not a hotkey).
 * - Bare `g` arms X's chord window and breaks any pending `d`.
 * - Bare `d` inside the `g` window belongs to X's chord — swallowed, both
 *   windows cleared. Outside it, a second bare `d` within
 *   {@link POST_GRAB_DOUBLE_TAP_MS} of the first `fire`s; otherwise this `d`
 *   becomes the armed first (`armed`).
 * - Anything else — modified `d`, `Shift+D`, auto-repeated `d`, modifier
 *   keydowns themselves — breaks the sequence.
 */
export function postHotkeyKey(state: PostHotkeyState, e: PostHotkeyEvent, now: number) {
  if (isTypingTarget(e.target)) return { state, action: null }
  if (isBare(e, 'g')) return { state: { dArmedAt: 0, gArmedAt: now }, action: null }
  if (isBare(e, 'd')) {
    if (state.gArmedAt > 0 && now < state.gArmedAt + X_G_CHORD_MS) {
      return { state: idlePostHotkey, action: null }
    }
    if (state.dArmedAt > 0 && now - state.dArmedAt <= POST_GRAB_DOUBLE_TAP_MS) {
      return { state: idlePostHotkey, action: 'fire' }
    }
    return { state: { dArmedAt: now, gArmedAt: 0 }, action: 'armed' }
  }
  return { state: idlePostHotkey, action: null }
}
