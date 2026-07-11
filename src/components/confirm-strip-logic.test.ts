import { describe, it, expect } from 'vitest'
import {
  disarmDeadline,
  guardMs,
  isGuardElapsed,
  outsideClickArmed,
  typedWordSatisfied,
  underlineStart,
} from './confirm-strip-logic'

describe('guardMs', () => {
  it('is 450ms for one-shot destructive triggers', () => {
    expect(guardMs('one-shot')).toBe(450)
  })

  it('is 250ms for the settings-precommitted toggle-ON gate', () => {
    expect(guardMs('pre-committed')).toBe(250)
  })
})

describe('isGuardElapsed', () => {
  it('is false before the guard window elapses', () => {
    expect(isGuardElapsed(1000, 1449, 'one-shot')).toBe(false)
  })

  it('is true exactly at the guard boundary (>=, not >)', () => {
    expect(isGuardElapsed(1000, 1450, 'one-shot')).toBe(true)
  })

  it('is true past the guard window', () => {
    expect(isGuardElapsed(1000, 2000, 'one-shot')).toBe(true)
  })

  it('uses the 250ms window for pre-committed strips', () => {
    expect(isGuardElapsed(1000, 1249, 'pre-committed')).toBe(false)
    expect(isGuardElapsed(1000, 1250, 'pre-committed')).toBe(true)
  })
})

describe('disarmDeadline', () => {
  it('is 8000ms after arming', () => {
    expect(disarmDeadline(1000)).toBe(9000)
  })
})

describe('underlineStart', () => {
  it('is 6000ms after arming (the last 2s of the 8s window)', () => {
    expect(underlineStart(1000)).toBe(7000)
  })

  it('sits exactly 2000ms before the auto-disarm deadline', () => {
    const armedAt = 5000
    expect(disarmDeadline(armedAt) - underlineStart(armedAt)).toBe(2000)
  })
})

describe('outsideClickArmed', () => {
  it('is false inside the 300ms grace window', () => {
    expect(outsideClickArmed(1000, 1300)).toBe(false)
  })

  it('is false exactly at the 300ms boundary (> not >=)', () => {
    expect(outsideClickArmed(1000, 1300)).toBe(false)
  })

  it('is true past the grace window', () => {
    expect(outsideClickArmed(1000, 1301)).toBe(true)
  })
})

describe('typedWordSatisfied', () => {
  it.each(['release', ' RELEASE ', 'Release'])('matches %j against the default word', (value) => {
    expect(typedWordSatisfied(value)).toBe(true)
  })

  it.each(['', 'releas', 'release the list'])('rejects %j against the default word', (value) => {
    expect(typedWordSatisfied(value)).toBe(false)
  })

  it('is parametrized by a custom word', () => {
    expect(typedWordSatisfied('confirm', 'confirm')).toBe(true)
    expect(typedWordSatisfied('release', 'confirm')).toBe(false)
  })
})
