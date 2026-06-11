import { describe, it, expect } from 'vitest'
import {
  startSession,
  recordUnitOutcome,
  isTweetSaved,
  cleanupCandidates,
  markCleanup,
  summarize,
} from './session'
import type { ArchiveSession, SessionTweet } from './session'

const start = (
  over: {
    removeAfterSave?: boolean
    tweets?: ReadonlyArray<{ tweetId: string; unitIds: ReadonlyArray<string>; skipped: number }>
    source?: 'bookmarks' | 'likes'
  } = {},
): ArchiveSession =>
  startSession({
    id: 's1',
    source: over.source ?? 'bookmarks',
    startedAt: 1000,
    removeAfterSave: over.removeAfterSave ?? true,
    tweets: over.tweets ?? [
      { tweetId: 'T1', unitIds: ['u1', 'u2'], skipped: 0 },
      { tweetId: 'T2', unitIds: ['u3'], skipped: 1 },
    ],
  })

const tweet = (s: ArchiveSession, id: string): SessionTweet =>
  s.tweets.find((t) => t.tweetId === id)!

describe('startSession', () => {
  it('seeds cleanup=pending for every tweet when removeAfterSave is on', () => {
    const s = start({ removeAfterSave: true })
    expect(s.tweets.every((t) => t.cleanup === 'pending')).toBe(true)
    expect(s.startedAt).toBe(1000)
    expect(s.source).toBe('bookmarks')
  })

  it('seeds cleanup=kept for every tweet when removeAfterSave is off', () => {
    const s = start({ removeAfterSave: false })
    expect(s.tweets.every((t) => t.cleanup === 'kept')).toBe(true)
  })

  it('initializes savedIds/failedIds empty and preserves unitIds + skipped', () => {
    const s = start()
    const t1 = tweet(s, 'T1')
    expect(t1.unitIds).toEqual(['u1', 'u2'])
    expect(t1.savedIds).toEqual([])
    expect(t1.failedIds).toEqual([])
    expect(tweet(s, 'T2').skipped).toBe(1)
  })
})

describe('recordUnitOutcome', () => {
  it('moves a settled unit into savedIds (ok) without mutating the input', () => {
    const s = start()
    const next = recordUnitOutcome(s, 'u1', true)
    expect(tweet(next, 'T1').savedIds).toEqual(['u1'])
    // input untouched
    expect(tweet(s, 'T1').savedIds).toEqual([])
  })

  it('records a failed unit into failedIds', () => {
    const s = recordUnitOutcome(start(), 'u1', false)
    expect(tweet(s, 'T1').failedIds).toEqual(['u1'])
    expect(tweet(s, 'T1').savedIds).toEqual([])
  })

  it('is idempotent per unit: applying the same outcome twice counts once', () => {
    let s = start()
    s = recordUnitOutcome(s, 'u1', true)
    s = recordUnitOutcome(s, 'u1', true)
    expect(tweet(s, 'T1').savedIds).toEqual(['u1'])
  })

  it('does not let a duplicate delta flip a unit between saved and failed', () => {
    // first outcome wins; the duplicate (with opposite ok) must not re-classify
    let s = start()
    s = recordUnitOutcome(s, 'u1', true)
    s = recordUnitOutcome(s, 'u1', false)
    expect(tweet(s, 'T1').savedIds).toEqual(['u1'])
    expect(tweet(s, 'T1').failedIds).toEqual([])
  })

  it('ignores unknown unit ids', () => {
    const s = recordUnitOutcome(start(), 'nope', true)
    expect(tweet(s, 'T1').savedIds).toEqual([])
    expect(tweet(s, 'T2').savedIds).toEqual([])
  })
})

describe('isTweetSaved', () => {
  it('is true when every unit settled and none failed', () => {
    let s = start()
    s = recordUnitOutcome(s, 'u1', true)
    s = recordUnitOutcome(s, 'u2', true)
    expect(isTweetSaved(tweet(s, 'T1'))).toBe(true)
  })

  it('is false while a unit is still pending (not all settled)', () => {
    const s = recordUnitOutcome(start(), 'u1', true)
    expect(isTweetSaved(tweet(s, 'T1'))).toBe(false)
  })

  it('is false for a tweet with a mix of saved and failed units', () => {
    let s = start()
    s = recordUnitOutcome(s, 'u1', true)
    s = recordUnitOutcome(s, 'u2', false)
    expect(isTweetSaved(tweet(s, 'T1'))).toBe(false)
  })

  it('a zero-unit tweet (everything skipped) is saved immediately', () => {
    const s = start({
      tweets: [{ tweetId: 'Z', unitIds: [], skipped: 3 }],
    })
    expect(isTweetSaved(tweet(s, 'Z'))).toBe(true)
  })
})

describe('cleanupCandidates', () => {
  it('returns only saved tweets whose cleanup is still pending', () => {
    let s = start({
      tweets: [
        { tweetId: 'A', unitIds: ['a1'], skipped: 0 },
        { tweetId: 'B', unitIds: ['b1'], skipped: 0 },
        { tweetId: 'C', unitIds: [], skipped: 2 }, // zero-unit => saved immediately
      ],
    })
    s = recordUnitOutcome(s, 'a1', true) // A saved + pending
    s = recordUnitOutcome(s, 'b1', false) // B not saved
    const ids = cleanupCandidates(s).map((t) => t.tweetId)
    expect(ids).toContain('A')
    expect(ids).toContain('C')
    expect(ids).not.toContain('B')
  })

  it('excludes saved tweets whose cleanup is kept (removeAfterSave off)', () => {
    let s = start({ removeAfterSave: false })
    s = recordUnitOutcome(s, 'u1', true)
    s = recordUnitOutcome(s, 'u2', true)
    expect(cleanupCandidates(s)).toEqual([])
  })

  it('excludes a tweet already removed', () => {
    let s = start({ tweets: [{ tweetId: 'A', unitIds: ['a1'], skipped: 0 }] })
    s = recordUnitOutcome(s, 'a1', true)
    s = markCleanup(s, 'A', true)
    expect(cleanupCandidates(s)).toEqual([])
  })
})

describe('markCleanup', () => {
  it('transitions pending => removed on ok', () => {
    let s = start({ tweets: [{ tweetId: 'A', unitIds: ['a1'], skipped: 0 }] })
    s = recordUnitOutcome(s, 'a1', true)
    s = markCleanup(s, 'A', true)
    expect(tweet(s, 'A').cleanup).toBe('removed')
  })

  it('transitions pending => failed on not-ok', () => {
    let s = start({ tweets: [{ tweetId: 'A', unitIds: ['a1'], skipped: 0 }] })
    s = recordUnitOutcome(s, 'a1', true)
    s = markCleanup(s, 'A', false)
    expect(tweet(s, 'A').cleanup).toBe('failed')
  })

  it('only transitions from pending — a kept tweet stays kept', () => {
    let s = start({
      removeAfterSave: false,
      tweets: [{ tweetId: 'A', unitIds: ['a1'], skipped: 0 }],
    })
    s = recordUnitOutcome(s, 'a1', true)
    s = markCleanup(s, 'A', true)
    expect(tweet(s, 'A').cleanup).toBe('kept')
  })

  it('does not mutate the input session', () => {
    let s = start({ tweets: [{ tweetId: 'A', unitIds: ['a1'], skipped: 0 }] })
    s = recordUnitOutcome(s, 'a1', true)
    const before = s
    markCleanup(s, 'A', true)
    expect(tweet(before, 'A').cleanup).toBe('pending')
  })
})

describe('summarize', () => {
  it('counts units for saved/failed and sums skipped across tweets', () => {
    let s = start({
      tweets: [
        { tweetId: 'A', unitIds: ['a1', 'a2'], skipped: 1 },
        { tweetId: 'B', unitIds: ['b1'], skipped: 2 },
      ],
    })
    s = recordUnitOutcome(s, 'a1', true)
    s = recordUnitOutcome(s, 'a2', false)
    s = recordUnitOutcome(s, 'b1', true)
    const sum = summarize(s)
    expect(sum.tweets).toBe(2)
    expect(sum.saved).toBe(2) // a1 + b1 (units)
    expect(sum.failed).toBe(1) // a2
    expect(sum.skipped).toBe(3) // 1 + 2
    expect(sum.source).toBe('bookmarks')
    expect(sum.startedAt).toBe(1000)
  })

  it('counts removed / removeFailed by tweet', () => {
    let s = start({
      tweets: [
        { tweetId: 'A', unitIds: ['a1'], skipped: 0 },
        { tweetId: 'B', unitIds: ['b1'], skipped: 0 },
      ],
    })
    s = recordUnitOutcome(s, 'a1', true)
    s = recordUnitOutcome(s, 'b1', true)
    s = markCleanup(s, 'A', true)
    s = markCleanup(s, 'B', false)
    const sum = summarize(s)
    expect(sum.removed).toBe(1)
    expect(sum.removeFailed).toBe(1)
  })

  it('done is false while a saved tweet is still pending cleanup', () => {
    let s = start({ tweets: [{ tweetId: 'A', unitIds: ['a1'], skipped: 0 }] })
    s = recordUnitOutcome(s, 'a1', true)
    // unit settled, but cleanup still pending => not done
    expect(summarize(s).done).toBe(false)
  })

  it('done is false while a unit is still unsettled', () => {
    const s = start({ tweets: [{ tweetId: 'A', unitIds: ['a1', 'a2'], skipped: 0 }] })
    const after = recordUnitOutcome(s, 'a1', true)
    expect(summarize(after).done).toBe(false)
  })

  it('done is true once all units settled and no saved tweet is left pending', () => {
    let s = start({ tweets: [{ tweetId: 'A', unitIds: ['a1'], skipped: 0 }] })
    s = recordUnitOutcome(s, 'a1', true)
    s = markCleanup(s, 'A', true)
    expect(summarize(s).done).toBe(true)
  })

  it('done is true when cleanup is off and all units have settled', () => {
    let s = start({
      removeAfterSave: false,
      tweets: [{ tweetId: 'A', unitIds: ['a1'], skipped: 0 }],
    })
    s = recordUnitOutcome(s, 'a1', true)
    expect(summarize(s).done).toBe(true)
  })

  it('done is true for an all-skipped (zero-unit, kept) session', () => {
    const s = start({ removeAfterSave: false, tweets: [{ tweetId: 'Z', unitIds: [], skipped: 4 }] })
    expect(summarize(s).done).toBe(true)
  })
})
