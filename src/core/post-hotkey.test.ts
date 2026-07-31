import { describe, it, expect } from 'vitest'
import {
  POST_GRAB_DOUBLE_TAP_MS,
  X_G_CHORD_MS,
  idlePostHotkey,
  isTypingTarget,
  postHotkeyKey,
  type PostHotkeyEvent,
} from './post-hotkey'

const key = (k: string, over: Partial<PostHotkeyEvent> = {}): PostHotkeyEvent => ({
  key: k,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  repeat: false,
  target: null,
  ...over,
})

const T = 10_000

describe('postHotkeyKey', () => {
  it('arms on the first bare d, fires on the second inside the window', () => {
    const first = postHotkeyKey(idlePostHotkey, key('d'), T)
    expect(first.action).toBe('armed')
    const second = postHotkeyKey(first.state, key('d'), T + POST_GRAB_DOUBLE_TAP_MS)
    expect(second).toEqual({ state: idlePostHotkey, action: 'fire' })
  })

  it('re-arms instead of firing when the window has expired', () => {
    const first = postHotkeyKey(idlePostHotkey, key('d'), T)
    const late = postHotkeyKey(first.state, key('d'), T + POST_GRAB_DOUBLE_TAP_MS + 1)
    expect(late).toEqual({
      state: { dArmedAt: T + POST_GRAB_DOUBLE_TAP_MS + 1, gArmedAt: 0 },
      action: 'armed',
    })
  })

  it('any other key breaks the sequence', () => {
    const armed = postHotkeyKey(idlePostHotkey, key('d'), T).state
    const broken = postHotkeyKey(armed, key('j'), T + 100)
    expect(broken).toEqual({ state: idlePostHotkey, action: null })
    // …so the next d is a fresh first press, not a fire.
    expect(postHotkeyKey(broken.state, key('d'), T + 200).action).toBe('armed')
  })

  it('g arms X’s chord window; a d inside it is X’s, then the window is spent', () => {
    const g = postHotkeyKey(idlePostHotkey, key('g'), T)
    expect(g).toEqual({ state: { dArmedAt: 0, gArmedAt: T }, action: null })
    const swallowed = postHotkeyKey(g.state, key('d'), T + 300)
    expect(swallowed).toEqual({ state: idlePostHotkey, action: null })
    // The chord is concluded: a later d d pair fires normally.
    const armed = postHotkeyKey(swallowed.state, key('d'), T + 500)
    expect(armed.action).toBe('armed')
    expect(postHotkeyKey(armed.state, key('d'), T + 700).action).toBe('fire')
  })

  it('a d past the g window is ours again', () => {
    const g = postHotkeyKey(idlePostHotkey, key('g'), T).state
    const after = postHotkeyKey(g, key('d'), T + X_G_CHORD_MS)
    expect(after.action).toBe('armed')
  })

  it('g also breaks a pending d', () => {
    const armed = postHotkeyKey(idlePostHotkey, key('d'), T).state
    const g = postHotkeyKey(armed, key('g'), T + 100)
    expect(g.state).toEqual({ dArmedAt: 0, gArmedAt: T + 100 })
  })

  it('ignores a d with any modifier held, and resets the sequence', () => {
    for (const over of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }] as const) {
      const armed = postHotkeyKey(idlePostHotkey, key('d'), T).state
      expect(postHotkeyKey(armed, key('d', over), T + 100)).toEqual({
        state: idlePostHotkey,
        action: null,
      })
    }
  })

  it('never fires on auto-repeat (held d)', () => {
    const armed = postHotkeyKey(idlePostHotkey, key('d'), T).state
    expect(postHotkeyKey(armed, key('d', { repeat: true }), T + 100)).toEqual({
      state: idlePostHotkey,
      action: null,
    })
  })

  it('is case-sensitive: Shift+D is not the hotkey', () => {
    const armed = postHotkeyKey(idlePostHotkey, key('d'), T).state
    expect(postHotkeyKey(armed, key('D'), T + 100)).toEqual({
      state: idlePostHotkey,
      action: null,
    })
  })

  it('modifier keydowns themselves break the sequence', () => {
    const armed = postHotkeyKey(idlePostHotkey, key('d'), T).state
    expect(postHotkeyKey(armed, key('Alt'), T + 100)).toEqual({
      state: idlePostHotkey,
      action: null,
    })
  })

  it('typing targets are text, not hotkeys: state passes through unchanged', () => {
    const input = document.createElement('input')
    const armed = postHotkeyKey(idlePostHotkey, key('d'), T).state
    const typed = postHotkeyKey(armed, key('d', { target: input }), T + 100)
    expect(typed).toEqual({ state: armed, action: null })
    // …so a real d right after still completes the pair.
    expect(postHotkeyKey(typed.state, key('d'), T + 200).action).toBe('fire')
  })
})

describe('isTypingTarget', () => {
  it('matches editable elements only', () => {
    expect(isTypingTarget(document.createElement('input'))).toBe(true)
    expect(isTypingTarget(document.createElement('textarea'))).toBe(true)
    expect(isTypingTarget(document.createElement('select'))).toBe(true)
    const editable = document.createElement('div')
    editable.contentEditable = 'true'
    expect(isTypingTarget(editable)).toBe(true)
    expect(isTypingTarget(document.createElement('div'))).toBe(false)
    // A non-element target (e.g. a text node) carries no tagName at all.
    expect(isTypingTarget(document.createTextNode('x'))).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})
