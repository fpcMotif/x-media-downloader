/**
 * Completion Ledger — the sole authority gating Clear-on-complete (the worklist
 * un-bookmark / un-like). Pure reducer, no I/O — the background SW persists it to
 * `storage.local` and reconciles it against `chrome.downloads.search`. Lifted
 * verbatim from the prototype that validated the eight race/edge cases
 * (`ledger.prototype.ts` + `NOTES.md`); see the design spec
 * `docs/superpowers/specs/2026-06-15-worklist-clear-on-complete-design.md`.
 *
 * The irreversible Clear fires only on a Truly Complete tweet: every expected
 * Media Item reached the real `onChanged` terminal `complete` AND left the
 * in-progress set (Settle, confirmed via search) — never the start-time verdict.
 */

import type { Settings } from '@/packages/schema'

export type Scope = 'bookmark' | 'like' | 'notInterested'
export type ClearStatus = 'none' | 'clearing' | 'cleared' | 'failed'
export type Origin = 'hook' | 'drain' | 'sweep'
export type Strategy = 'browser' | 'aria2'

export interface LedgerEntry {
  readonly tweetId: string
  readonly scopes: ReadonlySet<Scope>
  readonly origin: Origin
  readonly strategy: Strategy
  readonly expected: ReadonlySet<string>
  readonly done: ReadonlySet<string>
  readonly failed: ReadonlySet<string>
  readonly inProgress: ReadonlySet<string> // ids not yet confirmed settled via downloads.search
  readonly clear: Readonly<Record<Scope, ClearStatus>>
}

export type Action =
  | { type: 'Complete'; mediaId: string } // onChanged 'complete' — recorded, but still settling
  | { type: 'Settle'; mediaId: string } // download left the in-progress set (search confirms)
  | { type: 'Fail'; mediaId: string } // onChanged 'interrupted'/'failed'
  | { type: 'LateInterrupt'; mediaId: string } // a recorded 'complete' that later interrupts pre-settle
  | { type: 'Extend'; ids: string[] } // re-download of the same tweet: union new media ids in
  | { type: 'ClaimClear'; scope: Scope } // CAS: none|failed -> clearing
  | { type: 'ResolveClear'; scope: Scope; ok: boolean } // clearing -> cleared|failed

export function createEntry(input: {
  tweetId: string
  scopes: Scope[]
  origin: Origin
  strategy: Strategy
  expected: string[]
}): LedgerEntry {
  return {
    tweetId: input.tweetId,
    scopes: new Set(input.scopes),
    origin: input.origin,
    strategy: input.strategy,
    expected: new Set(input.expected),
    done: new Set(),
    failed: new Set(),
    inProgress: new Set(input.expected), // everything starts in-flight
    clear: { bookmark: 'none', like: 'none', notInterested: 'none' },
  }
}

/**
 * Scopes for a (re)seed. A sweep is strictly list-scoped: it must claim ONLY the
 * scope(s) explicitly swept — it UNIONS a prior SWEEP entry's scopes (each was a
 * deliberate sweep) but NEVER inherits a hook/drain entry's wider scopes, which
 * would let a Likes sweep un-bookmark (or vice-versa) if the tab navigated to the
 * other list before the download settled. Non-sweep seeds keep their own scopes.
 */
export function seedScopes(
  existing: LedgerEntry | undefined,
  origin: Origin,
  scopes: Scope[],
): Set<Scope> {
  if (origin === 'sweep' && existing?.origin === 'sweep') {
    return new Set<Scope>([...existing.scopes, ...scopes])
  }
  return new Set(scopes)
}

const without = <T>(s: ReadonlySet<T>, x: T): Set<T> => {
  const n = new Set(s)
  n.delete(x)
  return n
}
const withItem = <T>(s: ReadonlySet<T>, x: T): Set<T> => new Set(s).add(x)

export function reduce(e: LedgerEntry, a: Action): LedgerEntry {
  switch (a.type) {
    case 'Complete':
      // Only expected, not-failed ids count. Set semantics dedupe a double onChanged.
      if (!e.expected.has(a.mediaId) || e.failed.has(a.mediaId)) return e
      return { ...e, done: withItem(e.done, a.mediaId) }

    case 'Settle':
      return { ...e, inProgress: without(e.inProgress, a.mediaId) }

    case 'Fail':
      return {
        ...e,
        failed: withItem(e.failed, a.mediaId),
        done: without(e.done, a.mediaId),
        inProgress: without(e.inProgress, a.mediaId),
      }

    case 'LateInterrupt':
      // A recorded completion that interrupts before it settled: it must NOT count.
      if (!e.done.has(a.mediaId)) return e
      return {
        ...e,
        done: without(e.done, a.mediaId),
        failed: withItem(e.failed, a.mediaId),
        inProgress: without(e.inProgress, a.mediaId),
      }

    case 'Extend': {
      // A second download of the same tweet must never SHRINK what's tracked
      // (overwriting `expected` with a subset would let the Clear fire while the
      // first batch's media is still in-flight). Union the new ids into expected
      // and inProgress; a re-issued id restarts (drops from done/failed) so it
      // must re-complete + settle before Truly Complete.
      const expected = new Set(e.expected)
      const inProgress = new Set(e.inProgress)
      const done = new Set(e.done)
      const failed = new Set(e.failed)
      for (const id of a.ids) {
        expected.add(id)
        inProgress.add(id)
        done.delete(id)
        failed.delete(id)
      }
      return { ...e, expected, inProgress, done, failed }
    }

    case 'ClaimClear':
      if (!canClaim(e, a.scope)) return e
      return { ...e, clear: { ...e.clear, [a.scope]: 'clearing' } }

    case 'ResolveClear':
      if (e.clear[a.scope] !== 'clearing') return e
      return { ...e, clear: { ...e.clear, [a.scope]: a.ok ? 'cleared' : 'failed' } }
  }
}

// ── derived predicates ──

export const isStrategyEligible = (e: LedgerEntry): boolean => e.strategy !== 'aria2'

export const isTrulyComplete = (e: LedgerEntry): boolean =>
  isStrategyEligible(e) &&
  e.expected.size > 0 &&
  e.failed.size === 0 &&
  e.inProgress.size === 0 && // left the in-progress set — not just first 'complete'
  [...e.expected].every((id) => e.done.has(id))

/** A scope can be claimed when the tweet is truly complete, in that scope, and not
 *  already cleared or mid-clear. `failed` IS re-claimable (retry); `cleared`/`clearing` are not. */
export const canClaim = (e: LedgerEntry, scope: Scope): boolean =>
  isTrulyComplete(e) &&
  e.scopes.has(scope) &&
  (e.clear[scope] === 'none' || e.clear[scope] === 'failed')

/** Atomic claim: the CAS surface real code uses so hook and drain can't double-fire. */
export function tryClaim(e: LedgerEntry, scope: Scope) {
  if (!canClaim(e, scope)) return { entry: e, won: false }
  return { entry: reduce(e, { type: 'ClaimClear', scope }), won: true }
}

/** The tweet is removable from the worklist only once every scope it's in is cleared. */
export const isFullyCleared = (e: LedgerEntry): boolean =>
  [...e.scopes].every((s) => e.clear[s] === 'cleared')

/** The auto-hook's enabled clear scopes, derived from the per-scope kill
 *  switches — the single mapping shared by ledger seeding and re-checks. The
 *  page the download happens on decides which of these is actually clicked
 *  (handleClearTweet's onScope): un-bookmark/un-like on a list page, "Not
 *  interested" on the For You feed; the off-page scopes no-op. */
export const hookScopes = (s: Settings): Scope[] => {
  const scopes: Scope[] = []
  if (s.autoUnbookmarkOnSave) scopes.push('bookmark')
  if (s.autoUnlikeOnSave) scopes.push('like')
  if (s.autoNotInterestedOnSave) scopes.push('notInterested')
  return scopes
}
