import { describe, it, expect } from 'vitest'
import { clearVerdict, flippedScopes, formatClearResults, type ClearScopeResult } from '../result'

describe('clearVerdict', () => {
  it.each<[string, ClearScopeResult, 'flipped' | 'skipped' | 'failed']>([
    ['ok, no noop → flipped', { scope: 'like', ok: true }, 'flipped'],
    ['ok, noop:false → flipped', { scope: 'like', ok: true, noop: false }, 'flipped'],
    ['ok, noop:true → skipped', { scope: 'bookmark', ok: true, noop: true }, 'skipped'],
    ['not ok → failed', { scope: 'notInterested', ok: false }, 'failed'],
    ['not ok even with noop → failed', { scope: 'like', ok: false, noop: true }, 'failed'],
  ])('%s', (_label, input, expected) => {
    expect(clearVerdict(input)).toBe(expected)
  })
})

describe('flippedScopes', () => {
  it('keeps only verified flips — never a no-op or a fail', () => {
    const results: ClearScopeResult[] = [
      { scope: 'like', ok: true },
      { scope: 'bookmark', ok: true, noop: true },
      { scope: 'notInterested', ok: false },
    ]
    expect(flippedScopes(results)).toEqual(['like'])
  })

  it('is empty for an empty list', () => {
    expect(flippedScopes([])).toEqual([])
  })
})

describe('formatClearResults', () => {
  it('joins scope:token with the exact ok/noop/fail vocabulary', () => {
    const results: ClearScopeResult[] = [
      { scope: 'like', ok: true },
      { scope: 'bookmark', ok: true, noop: true },
      { scope: 'notInterested', ok: false },
    ]
    expect(formatClearResults(results)).toBe('like:ok bookmark:noop notInterested:fail')
  })

  it('is the empty string for an empty list', () => {
    expect(formatClearResults([])).toBe('')
  })
})
