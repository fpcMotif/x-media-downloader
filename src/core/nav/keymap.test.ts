import { describe, it, expect } from 'vitest'
import {
  commandForKey,
  idleKeymap,
  isEditableTarget,
  type KeyContext,
  type KeymapState,
} from './keymap'

const ctx = (over: Partial<KeyContext> = {}): KeyContext => ({
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
})

const pending: KeymapState = { pendingG: true }

describe('isEditableTarget', () => {
  it('is false for non-Element targets', () => {
    expect(isEditableTarget(null)).toBe(false)
    expect(isEditableTarget(window)).toBe(false)
  })

  it('is true for a textarea', () => {
    const el = document.createElement('textarea')
    expect(isEditableTarget(el)).toBe(true)
  })

  it('is true for text-ish inputs and false for non-text inputs', () => {
    for (const type of ['text', 'search', 'url', 'email', 'password', 'tel', 'number']) {
      const el = document.createElement('input')
      el.type = type
      expect(isEditableTarget(el)).toBe(true)
    }
    for (const type of ['checkbox', 'radio', 'button', 'submit', 'range', 'file']) {
      const el = document.createElement('input')
      el.type = type
      expect(isEditableTarget(el)).toBe(false)
    }
  })

  it('is true for a contenteditable element', () => {
    const el = document.createElement('div')
    el.setAttribute('contenteditable', 'true')
    document.body.appendChild(el)
    expect(isEditableTarget(el)).toBe(true)
    el.remove()
  })

  it('is true for an element inside a role=textbox ancestor', () => {
    const box = document.createElement('div')
    box.setAttribute('role', 'textbox')
    const inner = document.createElement('span')
    box.appendChild(inner)
    document.body.appendChild(box)
    expect(isEditableTarget(inner)).toBe(true)
    box.remove()
  })

  it('is false for a plain element', () => {
    const el = document.createElement('div')
    expect(isEditableTarget(el)).toBe(false)
  })
})

describe('commandForKey', () => {
  it('maps movement keys, arrows mirroring j/k', () => {
    expect(commandForKey(idleKeymap, 'j', ctx()).command).toBe('nextPost')
    expect(commandForKey(idleKeymap, 'ArrowDown', ctx()).command).toBe('nextPost')
    expect(commandForKey(idleKeymap, 'k', ctx()).command).toBe('prevPost')
    expect(commandForKey(idleKeymap, 'ArrowUp', ctx()).command).toBe('prevPost')
  })

  it('maps spatial keys: arrows both ways, h left only — l means like', () => {
    expect(commandForKey(idleKeymap, 'ArrowLeft', ctx()).command).toBe('spatialLeft')
    expect(commandForKey(idleKeymap, 'h', ctx()).command).toBe('spatialLeft')
    expect(commandForKey(idleKeymap, 'ArrowRight', ctx()).command).toBe('spatialRight')
    expect(commandForKey(idleKeymap, 'l', ctx()).command).toBe('likePost')
  })

  it('maps action keys: open, download, like, reply, repost', () => {
    expect(commandForKey(idleKeymap, 'o', ctx()).command).toBe('openPost')
    expect(commandForKey(idleKeymap, 'Enter', ctx()).command).toBe('openPost')
    expect(commandForKey(idleKeymap, 'd', ctx()).command).toBe('downloadPost')
    expect(commandForKey(idleKeymap, 'r', ctx()).command).toBe('replyPost')
    expect(commandForKey(idleKeymap, 't', ctx()).command).toBe('repostPost')
  })

  it('maps G to lastPost', () => {
    expect(commandForKey(idleKeymap, 'G', ctx({ shiftKey: true })).command).toBe('lastPost')
  })

  it('returns null and the same state for unmapped keys', () => {
    const out = commandForKey(idleKeymap, 'z', ctx())
    expect(out.command).toBeNull()
    expect(out.state).toBe(idleKeymap)
  })

  it('ignores shifted letters (arrive uppercase, no match)', () => {
    expect(commandForKey(idleKeymap, 'J', ctx({ shiftKey: true })).command).toBeNull()
  })

  it('passes modified keys through untouched and clears a pending chord', () => {
    for (const over of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }] as const) {
      const out = commandForKey(pending, 'j', ctx(over))
      expect(out.command).toBeNull()
      expect(out.state).toBe(idleKeymap)
    }
  })

  it('enters the gg chord on g and fires firstPost on the second g', () => {
    const first = commandForKey(idleKeymap, 'g', ctx())
    expect(first.command).toBeNull()
    expect(first.state.pendingG).toBe(true)
    const second = commandForKey(first.state, 'g', ctx())
    expect(second.command).toBe('firstPost')
    expect(second.state).toBe(idleKeymap)
  })

  it('drops the chord and evaluates the next key normally after g', () => {
    const out = commandForKey(pending, 'j', ctx())
    expect(out.command).toBe('nextPost')
    expect(out.state).toBe(idleKeymap)
  })

  it('drops the chord with no command when the next key is unmapped', () => {
    const out = commandForKey(pending, 'z', ctx())
    expect(out.command).toBeNull()
    expect(out.state).toBe(idleKeymap)
  })
})
