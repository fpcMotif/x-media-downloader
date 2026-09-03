import { describe, it, expect } from 'vitest'
import { Schema } from 'effect'
import {
  canClaim,
  createEntry,
  hookScopes,
  isFullyCleared,
  isStrategyEligible,
  isTrulyComplete,
  reduce,
  seedScopes,
  tryClaim,
  type LedgerEntry,
  type Scope,
  type Strategy,
} from '../ledger'
import { Settings as SettingsSchema, type Settings } from '@/packages/schema'

// Decoded from the schema's own defaults (same pattern as seed.test.ts) so the
// three toggles below sit on a fully-typed Settings — no assertion needed.
const baseSettings = Schema.decodeUnknownSync(SettingsSchema)({})

const toggles = (bookmark: boolean, like: boolean, notInterested: boolean): Settings => ({
  ...baseSettings,
  autoUnbookmarkOnSave: bookmark,
  autoUnlikeOnSave: like,
  autoNotInterestedOnSave: notInterested,
})

const seed = (over: Partial<{ scopes: Scope[]; strategy: Strategy; expected: string[] }> = {}) =>
  createEntry({
    tweetId: 'T',
    scopes: over.scopes ?? ['bookmark'],
    origin: 'hook',
    strategy: over.strategy ?? 'browser',
    expected: over.expected ?? ['m0'],
  })

const completeAndSettle = (e: LedgerEntry, id: string): LedgerEntry =>
  reduce(reduce(e, { type: 'Complete', mediaId: id }), { type: 'Settle', mediaId: id })

const sweepEntry = (scopes: Scope[]): LedgerEntry =>
  createEntry({ tweetId: 'T', scopes, origin: 'sweep', strategy: 'browser', expected: ['m0'] })
const hookEntry = (scopes: Scope[]): LedgerEntry =>
  createEntry({ tweetId: 'T', scopes, origin: 'hook', strategy: 'browser', expected: ['m0'] })

describe('hookScopes', () => {
  it('maps each per-scope toggle to its clear scope (incl. For You notInterested)', () => {
    expect(hookScopes(toggles(true, true, true))).toEqual(['bookmark', 'like', 'notInterested'])
    expect(hookScopes(toggles(true, false, false))).toEqual(['bookmark'])
    expect(hookScopes(toggles(false, true, false))).toEqual(['like'])
    // Regression guard: the For You toggle alone MUST seed 'notInterested', or the
    // timeline clear is dead code — the ledger never gets the scope to claim. (This
    // is exactly the wiring that was missing on the first cut of the feature.)
    expect(hookScopes(toggles(false, false, true))).toEqual(['notInterested'])
    expect(hookScopes(toggles(false, false, false))).toEqual([])
  })
})

describe('seedScopes (sweep is strictly list-scoped)', () => {
  it('fresh sweep → exactly the swept scope', () => {
    expect(seedScopes(undefined, 'sweep', ['like'])).toEqual(new Set(['like']))
  })

  it('sweep NEVER inherits a hook entry’s wider scopes (the HIGH-severity fix)', () => {
    // A Likes sweep over a tweet with an in-flight {bookmark,like} hook entry must
    // narrow to {like} — never claim bookmark and risk an un-bookmark on nav.
    expect(seedScopes(hookEntry(['bookmark', 'like']), 'sweep', ['like'])).toEqual(
      new Set(['like']),
    )
  })

  it('sweep UNIONS a prior sweep entry’s scopes (each was explicit)', () => {
    expect(seedScopes(sweepEntry(['like']), 'sweep', ['bookmark'])).toEqual(
      new Set(['like', 'bookmark']),
    )
  })

  it('non-sweep seed keeps its own scopes', () => {
    expect(seedScopes(hookEntry(['like']), 'hook', ['bookmark', 'like'])).toEqual(
      new Set(['bookmark', 'like']),
    )
  })
})

describe('Completion Ledger', () => {
  it('1. Truly Complete only after every item completes AND settles', () => {
    let e = seed({ expected: ['m0', 'm1', 'm2', 'm3'] })
    for (const m of ['m0', 'm1', 'm2', 'm3']) e = reduce(e, { type: 'Complete', mediaId: m })
    expect(isTrulyComplete(e)).toBe(false) // still in-progress
    for (const m of ['m0', 'm1', 'm2', 'm3']) e = reduce(e, { type: 'Settle', mediaId: m })
    expect(isTrulyComplete(e)).toBe(true)
    expect(canClaim(e, 'bookmark')).toBe(true)
  })

  it('2. Partial failure: 3/4 land, 1 fails → not clearable', () => {
    let e = seed({ expected: ['m0', 'm1', 'm2', 'm3'] })
    for (const m of ['m0', 'm1', 'm2']) e = completeAndSettle(e, m)
    e = reduce(e, { type: 'Fail', mediaId: 'm3' })
    expect(isTrulyComplete(e)).toBe(false)
    expect(canClaim(e, 'bookmark')).toBe(false)
  })

  it('3. Double onChanged for one id is deduped', () => {
    let e = seed()
    e = reduce(e, { type: 'Complete', mediaId: 'm0' })
    e = reduce(e, { type: 'Complete', mediaId: 'm0' })
    expect(e.done.size).toBe(1)
    e = reduce(e, { type: 'Settle', mediaId: 'm0' })
    expect(isTrulyComplete(e)).toBe(true)
  })

  it('4. Late interrupt after complete → Clear never fires', () => {
    let e = seed()
    e = reduce(e, { type: 'Complete', mediaId: 'm0' })
    expect(canClaim(e, 'bookmark')).toBe(false) // still in-progress
    e = reduce(e, { type: 'LateInterrupt', mediaId: 'm0' })
    expect(e.failed.has('m0')).toBe(true)
    expect(e.done.has('m0')).toBe(false)
    expect(isTrulyComplete(e)).toBe(false)
    expect(canClaim(e, 'bookmark')).toBe(false)
  })

  it('5. Per-scope partial: unbookmark ok, unlike fails, then like retry succeeds', () => {
    let e = seed({ scopes: ['bookmark', 'like'] })
    e = completeAndSettle(e, 'm0')
    e = reduce(tryClaim(e, 'bookmark').entry, { type: 'ResolveClear', scope: 'bookmark', ok: true })
    e = reduce(tryClaim(e, 'like').entry, { type: 'ResolveClear', scope: 'like', ok: false })
    expect(e.clear.bookmark).toBe('cleared')
    expect(e.clear.like).toBe('failed')
    expect(isFullyCleared(e)).toBe(false)
    expect(tryClaim(e, 'bookmark').won).toBe(false) // no double-unbookmark
    const retry = tryClaim(e, 'like')
    expect(retry.won).toBe(true) // failed is re-claimable
    e = reduce(retry.entry, { type: 'ResolveClear', scope: 'like', ok: true })
    expect(isFullyCleared(e)).toBe(true)
  })

  it('6. Sweep-vs-hook double-fire → only one claim wins', () => {
    let e = seed()
    e = completeAndSettle(e, 'm0')
    const hook = tryClaim(e, 'bookmark')
    e = hook.entry
    const drain = tryClaim(e, 'bookmark')
    expect(hook.won).toBe(true)
    expect(drain.won).toBe(false)
  })

  it('7. aria2 hand-off is excluded from auto-clear', () => {
    let e = seed({ strategy: 'aria2' })
    e = completeAndSettle(e, 'm0')
    expect(isStrategyEligible(e)).toBe(false)
    expect(isTrulyComplete(e)).toBe(false)
    expect(canClaim(e, 'bookmark')).toBe(false)
  })

  it('8. User re-bookmarks after auto-clear → no second unbookmark', () => {
    let e = seed()
    e = completeAndSettle(e, 'm0')
    e = reduce(tryClaim(e, 'bookmark').entry, { type: 'ResolveClear', scope: 'bookmark', ok: true })
    expect(e.clear.bookmark).toBe('cleared')
    const reattempt = tryClaim(e, 'bookmark')
    expect(reattempt.won).toBe(false)
    expect(e.clear.bookmark).toBe('cleared')
  })

  it('Extend (re-download) never shrinks tracking: a partial tweet stays not-clearable', () => {
    // 4-photo tweet; m0/m1 land, m2/m3 still in flight. A second download re-issues
    // only the completed m0/m1 (the in-flight ones are filtered out upstream).
    let e = seed({ expected: ['m0', 'm1', 'm2', 'm3'] })
    e = completeAndSettle(e, 'm0')
    e = completeAndSettle(e, 'm1')
    expect(isTrulyComplete(e)).toBe(false) // m2/m3 still in progress
    // OVERWRITE would do createEntry(expected:[m0,m1]) → clearable after m0/m1.
    // Extend must keep m2/m3 tracked:
    e = reduce(e, { type: 'Extend', ids: ['m0', 'm1'] })
    expect([...e.expected].toSorted()).toEqual(['m0', 'm1', 'm2', 'm3'])
    e = completeAndSettle(e, 'm0')
    e = completeAndSettle(e, 'm1')
    expect(isTrulyComplete(e)).toBe(false) // STILL blocked on m2/m3 — the fix
    e = completeAndSettle(e, 'm2')
    e = completeAndSettle(e, 'm3')
    expect(isTrulyComplete(e)).toBe(true) // only now, with all four truly done
  })

  it('media-less tweet (no expected) is never Truly Complete (safe: never clears)', () => {
    const e = createEntry({
      tweetId: 'T',
      scopes: ['like'],
      origin: 'drain',
      strategy: 'browser',
      expected: [],
    })
    expect(isTrulyComplete(e)).toBe(false)
    expect(canClaim(e, 'like')).toBe(false)
  })
})

describe('reduce guard branches (no-op early returns)', () => {
  it('Complete for an unexpected id is ignored', () => {
    const e = seed({ expected: ['m0'] })
    const next = reduce(e, { type: 'Complete', mediaId: 'unknown' })
    expect(next).toBe(e) // identity: untouched
    expect(next.done.size).toBe(0)
  })

  it('Complete for an already-failed id is ignored (a fail outranks a stray complete)', () => {
    let e = seed({ expected: ['m0'] })
    e = reduce(e, { type: 'Fail', mediaId: 'm0' })
    const next = reduce(e, { type: 'Complete', mediaId: 'm0' })
    expect(next).toBe(e)
    expect(next.done.has('m0')).toBe(false)
  })

  it('LateInterrupt for an id that never completed is a no-op', () => {
    const e = seed({ expected: ['m0'] })
    const next = reduce(e, { type: 'LateInterrupt', mediaId: 'm0' })
    expect(next).toBe(e)
    expect(next.failed.has('m0')).toBe(false)
  })

  it('ClaimClear when the tweet is not yet claimable is a no-op', () => {
    const e = seed() // m0 still in-progress → not Truly Complete → cannot claim
    const next = reduce(e, { type: 'ClaimClear', scope: 'bookmark' })
    expect(next).toBe(e)
    expect(next.clear.bookmark).toBe('none')
  })

  it('ResolveClear when the scope is not mid-clear is a no-op', () => {
    let e = seed() // bookmark starts at 'none', never claimed
    e = completeAndSettle(e, 'm0')
    const next = reduce(e, { type: 'ResolveClear', scope: 'bookmark', ok: true })
    expect(next).toBe(e)
    expect(next.clear.bookmark).toBe('none')
  })
})
