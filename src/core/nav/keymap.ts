/**
 * Keyboard Navigation — the pure keymap. Maps raw key events to semantic
 * {@link NavCommand}s, X-native-shortcuts-parity (j/k move, o/Enter open,
 * l like, r reply, t repost) adapted per the spec (issue #58): arrows mirror
 * j/k vertically and carry the SPATIAL horizontal moves (column switch on
 * Threads multi-column, carousel flip on Instagram), `gg`/`G` jump first/last.
 *
 * Key conflict resolved here: vim's `h`/`l` vs X's `l`=like — X parity wins
 * (`l` likes), `h` aliases left only, no right alias exists.
 */

export type NavCommand =
  | 'nextPost'
  | 'prevPost'
  | 'spatialLeft'
  | 'spatialRight'
  | 'firstPost'
  | 'lastPost'
  | 'openPost'
  | 'downloadPost'
  | 'likePost'
  | 'replyPost'
  | 'repostPost'

/** Modifier flags as they appear on a KeyboardEvent. */
export interface KeyContext {
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
}

/** Pending-chord state for `gg` (the only two-key command). */
export interface KeymapState {
  readonly pendingG: boolean
}

export const idleKeymap: KeymapState = { pendingG: false }

/** Input types that do NOT take text — keyboard nav stays live while one of
 *  these has focus (vim users expect j/k to work with a button focused). */
const NON_TEXT_INPUT_TYPES = {
  checkbox: true,
  radio: true,
  button: true,
  submit: true,
  reset: true,
  file: true,
  image: true,
  range: true,
  hidden: true,
} satisfies Readonly<Record<string, true>>

/**
 * Whether a key event originated in a text-entry surface, where every nav
 * binding must suspend — the X-native rule the spec adopts verbatim (typing
 * "lol" in a reply must never fire like/open/like). Mirrors X's own scope:
 * text-ish inputs, textareas, contenteditables, and ARIA textboxes.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target instanceof HTMLTextAreaElement) return true
  if (target instanceof HTMLInputElement) return !(target.type in NON_TEXT_INPUT_TYPES)
  if (target instanceof HTMLElement && target.isContentEditable) return true
  return target.closest('[role="textbox"]') !== null
}

/** Single-key commands — no chord state. Shifted letters arrive uppercase and
 *  simply miss every entry here (except the intentional `'G'`), so a held
 *  Shift never fires an accidental action. A `Map`, not a `Record`: looking up
 *  an arbitrary key event's `key` string needs a plain "present or not" read
 *  (`.get` returns `NavCommand | undefined` for any string), not a dictionary
 *  contract for keys that are only ever these ten literals. */
const SINGLE_KEY_COMMANDS = new Map<string, NavCommand>([
  ['j', 'nextPost'],
  ['ArrowDown', 'nextPost'],
  ['k', 'prevPost'],
  ['ArrowUp', 'prevPost'],
  ['ArrowLeft', 'spatialLeft'],
  ['h', 'spatialLeft'],
  ['ArrowRight', 'spatialRight'],
  ['o', 'openPost'],
  ['Enter', 'openPost'],
  ['d', 'downloadPost'],
  ['l', 'likePost'],
  ['r', 'replyPost'],
  ['t', 'repostPost'],
  ['G', 'lastPost'],
])

/**
 * Map one key event to a {@link NavCommand}. Modified keypresses
 * (Ctrl/Cmd/Alt held) always pass through as `null` — browser shortcuts and
 * Quick Grab's modifier machinery are never intercepted, and a pending `g`
 * chord is cancelled. A pending chord otherwise completes on the second `g`
 * (`firstPost`) or falls through, evaluating the new key normally.
 */
export function commandForKey(state: KeymapState, key: string, ctx: KeyContext) {
  if (ctx.ctrlKey || ctx.metaKey || ctx.altKey) return { state: idleKeymap, command: null }
  if (state.pendingG) {
    return key === 'g'
      ? { state: idleKeymap, command: 'firstPost' }
      : { state: idleKeymap, command: SINGLE_KEY_COMMANDS.get(key) ?? null }
  }
  if (key === 'g') return { state: { pendingG: true }, command: null }
  return { state, command: SINGLE_KEY_COMMANDS.get(key) ?? null }
}
