import { describe, it, expect } from 'vitest'
import { Schema } from 'effect'
import { planClearSeed } from './seed'
import type { Scope } from './ledger'
import { Settings as SettingsSchema, type Settings, type MediaItem } from '../schema'
import type { SaveRequest } from '../download/strategy'

// Minimal Settings fixture — same pattern as clear-coordinator.test.ts: decode the
// schema's defaults once, then spread-override just the fields each case cares
// about, so every test only names the toggles it actually varies.
const baseSettings = Schema.decodeUnknownSync(SettingsSchema)({})
const settings = (over: Partial<Settings> = {}): Settings => ({ ...baseSettings, ...over })

// Minimal MediaItem fixture — only the fields planClearSeed reads (id, tweetId);
// the rest are filled with harmless placeholders to satisfy the struct's required
// fields (handle/type/url/ext/index).
const media = (over: Partial<MediaItem> & { id: string; tweetId: string }): MediaItem => ({
  handle: 'jack',
  type: 'photo',
  url: 'https://example.com/x.jpg',
  ext: 'jpg',
  index: 0,
  ...over,
})

const req = (id: string): SaveRequest => ({ id, url: `https://example.com/${id}`, filename: id })

describe('planClearSeed — skip verdicts', () => {
  it('aria2 skip: downloadStrategy === "aria2" skips regardless of other settings', () => {
    const verdict = planClearSeed({
      requests: [req('m0')],
      mediaById: new Map([['m0', media({ id: 'm0', tweetId: '1' })]]),
      settings: settings({
        downloadStrategy: 'aria2',
        clearOnSave: true,
        autoUnbookmarkOnSave: true,
      }),
    })
    expect(verdict).toEqual({ decision: 'skip', reason: 'aria2' })
  })

  it('clear-off skip: clearOnSave === false skips even with scopes enabled', () => {
    const verdict = planClearSeed({
      requests: [req('m0')],
      mediaById: new Map([['m0', media({ id: 'm0', tweetId: '1' })]]),
      settings: settings({ clearOnSave: false, autoUnbookmarkOnSave: true }),
    })
    expect(verdict).toEqual({ decision: 'skip', reason: 'clear-off' })
  })

  // no-scopes is only reachable via the hook path (no sweep): a sweep request
  // unconditionally includes sweep.scope in clearScopes, so clearScopes.length===0
  // can never happen when sweep is given — there is deliberately no sweep-path
  // no-scopes test here; it would assert something unreachable by construction.
  it('no-scopes skip (hook path only): no sweep, all three per-scope toggles off', () => {
    const verdict = planClearSeed({
      requests: [req('m0')],
      mediaById: new Map([['m0', media({ id: 'm0', tweetId: '1' })]]),
      settings: settings({
        clearOnSave: true,
        autoUnbookmarkOnSave: false,
        autoUnlikeOnSave: false,
        autoNotInterestedOnSave: false,
      }),
    })
    expect(verdict).toEqual({ decision: 'skip', reason: 'no-scopes' })
  })
})

describe('planClearSeed — seed composition', () => {
  it('quote-card filtered: a non-numeric tweetId is excluded + counted, other tweets unaffected', () => {
    // m3 is a sidecar `.json` request (like the real ones handleDownload builds
    // for metadata sidecars) — its id has no MediaItem in mediaById, so it must
    // be skipped entirely: neither counted in byTweet nor in unclearableCount.
    const requests = [req('m0'), req('m1'), req('m2'), req('m3.json')]
    const mediaById = new Map<string, MediaItem>([
      ['m0', media({ id: 'm0', tweetId: '123' })], // clearable
      ['m1', media({ id: 'm1', tweetId: '123' })], // clearable, same tweet as m0
      ['m2', media({ id: 'm2', tweetId: 'media-key-abc' })], // NOT numeric — unclearable
    ])
    const verdict = planClearSeed({
      requests,
      mediaById,
      settings: settings({ clearOnSave: true, autoUnbookmarkOnSave: true }),
    })
    expect(verdict.decision).toBe('seed')
    if (verdict.decision !== 'seed') throw new Error('unreachable')
    expect(verdict.byTweet).toEqual(new Map([['123', ['m0', 'm1']]]))
    expect(verdict.unclearableCount).toBe(1)
  })

  it('clearExpect widening: unions overlapping + new ids into an existing byTweet entry, deduped', () => {
    const requests = [req('m0')]
    const mediaById = new Map<string, MediaItem>([['m0', media({ id: 'm0', tweetId: '123' })]])
    const verdict = planClearSeed({
      requests,
      mediaById,
      clearExpect: [{ tweetId: '123', ids: ['m0', 'm1'] }],
      settings: settings({ clearOnSave: true, autoUnbookmarkOnSave: true }),
    })
    expect(verdict.decision).toBe('seed')
    if (verdict.decision !== 'seed') throw new Error('unreachable')
    expect(verdict.byTweet.get('123')).toEqual(['m0', 'm1'])
  })

  it('clearExpect no-op: a tweetId absent from byTweet gains no entry', () => {
    const requests = [req('m0')]
    const mediaById = new Map<string, MediaItem>([['m0', media({ id: 'm0', tweetId: '123' })]])
    const verdict = planClearSeed({
      requests,
      mediaById,
      clearExpect: [{ tweetId: '999', ids: ['mX'] }],
      settings: settings({ clearOnSave: true, autoUnbookmarkOnSave: true }),
    })
    expect(verdict.decision).toBe('seed')
    if (verdict.decision !== 'seed') throw new Error('unreachable')
    expect(verdict.byTweet.has('999')).toBe(false)
    expect(verdict.byTweet.get('123')).toEqual(['m0'])
  })

  it("sweep-widens-but-hook-doesn't: sweep widens scopes via clearAllListsOnSave; hook never does (CURRENT pinned behavior, not a bug to fix here)", () => {
    const requests = [req('m0')]
    const mediaById = new Map<string, MediaItem>([['m0', media({ id: 'm0', tweetId: '123' })]])
    const sharedSettings = settings({
      clearOnSave: true,
      clearAllListsOnSave: true,
      autoUnbookmarkOnSave: true,
      autoUnlikeOnSave: true,
      autoNotInterestedOnSave: true,
    })

    const sweepVerdict = planClearSeed({
      requests,
      mediaById,
      sweep: { scope: 'bookmark' },
      settings: sharedSettings,
    })
    expect(sweepVerdict.decision).toBe('seed')
    if (sweepVerdict.decision !== 'seed') throw new Error('unreachable')
    // Widened: sweep.scope unioned with the non-notInterested hook scopes.
    expect(new Set(sweepVerdict.scopes)).toEqual(new Set<Scope>(['bookmark', 'like']))
    expect(sweepVerdict.scopes).not.toContain('notInterested')

    const hookVerdict = planClearSeed({
      requests,
      mediaById,
      settings: sharedSettings,
    })
    expect(hookVerdict.decision).toBe('seed')
    if (hookVerdict.decision !== 'seed') throw new Error('unreachable')
    // Hook path: verbatim hookScopes(settings) — includes notInterested, never widened.
    expect(new Set(hookVerdict.scopes)).toEqual(
      new Set<Scope>(['bookmark', 'like', 'notInterested']),
    )
  })

  it('scope dedup: sweep.scope already present among the hook scopes appears exactly once', () => {
    const requests = [req('m0')]
    const mediaById = new Map<string, MediaItem>([['m0', media({ id: 'm0', tweetId: '123' })]])
    const verdict = planClearSeed({
      requests,
      mediaById,
      sweep: { scope: 'like' },
      settings: settings({
        clearOnSave: true,
        clearAllListsOnSave: true,
        autoUnlikeOnSave: true,
        autoUnbookmarkOnSave: false,
        autoNotInterestedOnSave: false,
      }),
    })
    expect(verdict.decision).toBe('seed')
    if (verdict.decision !== 'seed') throw new Error('unreachable')
    expect(verdict.scopes.filter((s) => s === 'like')).toHaveLength(1)
    expect(verdict.scopes).toEqual(['like'])
  })

  it('origin field: sweep request yields origin "sweep", hook request yields origin "hook"', () => {
    const requests = [req('m0')]
    const mediaById = new Map<string, MediaItem>([['m0', media({ id: 'm0', tweetId: '123' })]])
    const base = settings({ clearOnSave: true, autoUnbookmarkOnSave: true })

    const sweepVerdict = planClearSeed({
      requests,
      mediaById,
      sweep: { scope: 'bookmark' },
      settings: base,
    })
    expect(sweepVerdict.decision).toBe('seed')
    if (sweepVerdict.decision !== 'seed') throw new Error('unreachable')
    expect(sweepVerdict.origin).toBe('sweep')

    const hookVerdict = planClearSeed({ requests, mediaById, settings: base })
    expect(hookVerdict.decision).toBe('seed')
    if (hookVerdict.decision !== 'seed') throw new Error('unreachable')
    expect(hookVerdict.origin).toBe('hook')
  })
})
