import { describe, it, expect } from 'vitest'
import { Schema } from 'effect'
import { planClearSeed } from '../seed'
import { Settings as SettingsSchema, type MediaItem, type Settings } from '@/packages/schema'
import type { SaveRequest } from '@/packages/download/strategy'

const baseSettings = Schema.decodeUnknownSync(SettingsSchema)({})
const settings = (over: Partial<Settings> = {}): Settings => ({ ...baseSettings, ...over })

// Clear-on-save + un-bookmark enabled — the minimal settings under which a hook
// seed actually proceeds (mirrors clear-session.test.ts's CLEAR_ON).
const CLEAR_ON = settings({
  clearOnSave: true,
  autoUnbookmarkOnSave: true,
  autoUnlikeOnSave: false,
})

const photo = (id: string, postId: string): MediaItem => ({
  id,
  platform: 'x',
  postId,
  author: 'alice',
  type: 'photo',
  url: `https://pbs.twimg.com/media/${id}.jpg`,
  ext: 'jpg',
  index: 0,
})

const req = (id: string): SaveRequest => ({ id, url: `https://x/${id}`, filename: `${id}.jpg` })

const mediaById = (...items: MediaItem[]): ReadonlyMap<string, MediaItem> =>
  new Map(items.map((i) => [i.id, i]))

describe('planClearSeed — skip reasons', () => {
  it('aria2 strategy skips regardless of clear settings', () => {
    const verdict = planClearSeed({
      requests: [req('m0')],
      mediaById: mediaById(photo('m0', '100')),
      settings: { ...CLEAR_ON, downloadStrategy: 'aria2' },
    })
    expect(verdict).toEqual({ decision: 'skip', reason: 'aria2' })
  })

  it('clear-off skips when "Clear after download" is off', () => {
    const verdict = planClearSeed({
      requests: [req('m0')],
      mediaById: mediaById(photo('m0', '100')),
      settings: settings({ clearOnSave: false }),
    })
    expect(verdict).toEqual({ decision: 'skip', reason: 'clear-off' })
  })

  it('no-scopes skips a hook request when every per-scope toggle is off', () => {
    const verdict = planClearSeed({
      requests: [req('m0')],
      mediaById: mediaById(photo('m0', '100')),
      settings: settings({
        clearOnSave: true,
        autoUnbookmarkOnSave: false,
        autoUnlikeOnSave: false,
        autoNotInterestedOnSave: false,
      }),
    })
    expect(verdict).toEqual({ decision: 'skip', reason: 'no-scopes' })
  })

  it('a sweep never hits no-scopes: its own list scope alone is enough, even with every hook toggle off', () => {
    // Unlike the hook path, `clearScopes` for a sweep always includes `sweep.scope`,
    // so it can never observe clearScopes.length === 0 — this pins that asymmetry.
    const verdict = planClearSeed({
      requests: [],
      mediaById: mediaById(),
      sweep: { scope: 'bookmark' },
      settings: settings({
        clearOnSave: true,
        autoUnbookmarkOnSave: false,
        autoUnlikeOnSave: false,
        autoNotInterestedOnSave: false,
      }),
    })
    expect(verdict).toMatchObject({ decision: 'seed', origin: 'sweep', scopes: ['bookmark'] })
  })
})

describe('planClearSeed — seeding', () => {
  it('quote-card filtered: a non-numeric postId is excluded from byTweet and counted', () => {
    const verdict = planClearSeed({
      requests: [req('m0'), req('m1')],
      mediaById: mediaById(photo('m0', 'quote-card-key'), photo('m1', '200')),
      settings: CLEAR_ON,
    })
    expect(verdict.decision).toBe('seed')
    if (verdict.decision !== 'seed') return
    expect(verdict.unclearableCount).toBe(1)
    expect([...verdict.byTweet.keys()]).toEqual(['200'])
    expect(verdict.byTweet.get('200')).toEqual(['m1'])
  })

  it('a sidecar request with no MediaItem is skipped, not counted as unclearable', () => {
    // Sidecar `.json` requests carry no MediaItem (their id is `<media-id>.json`),
    // the same derivation gap `handleDownload`'s sync/history mirrors also skip.
    const verdict = planClearSeed({
      requests: [req('m0'), req('m0.json')],
      mediaById: mediaById(photo('m0', '100')),
      settings: CLEAR_ON,
    })
    expect(verdict.decision).toBe('seed')
    if (verdict.decision !== 'seed') return
    expect(verdict.unclearableCount).toBe(0)
    expect(verdict.byTweet.get('100')).toEqual(['m0'])
  })

  it('other tweets in the same batch are unaffected by an unclearable one', () => {
    const verdict = planClearSeed({
      requests: [req('m0'), req('m1'), req('m2')],
      mediaById: mediaById(photo('m0', 'bad-key'), photo('m1', '100'), photo('m2', '100')),
      settings: CLEAR_ON,
    })
    expect(verdict.decision).toBe('seed')
    if (verdict.decision !== 'seed') return
    expect(verdict.unclearableCount).toBe(1)
    expect(verdict.byTweet.get('100')).toEqual(['m1', 'm2'])
  })

  it('clearExpect widens byTweet ids for a matching tweetId (union, deduped)', () => {
    const verdict = planClearSeed({
      requests: [req('m0')],
      mediaById: mediaById(photo('m0', '100')),
      clearExpect: [{ tweetId: '100', ids: ['m0', 'm1', 'm2'] }],
      settings: CLEAR_ON,
    })
    expect(verdict.decision).toBe('seed')
    if (verdict.decision !== 'seed') return
    expect(verdict.byTweet.get('100')).toEqual(['m0', 'm1', 'm2'])
  })

  it('clearExpect is a no-op when the tweetId is not already in byTweet', () => {
    const verdict = planClearSeed({
      requests: [req('m0')],
      mediaById: mediaById(photo('m0', '100')),
      clearExpect: [{ tweetId: '999', ids: ['x0', 'x1'] }],
      settings: CLEAR_ON,
    })
    expect(verdict.decision).toBe('seed')
    if (verdict.decision !== 'seed') return
    expect([...verdict.byTweet.keys()]).toEqual(['100'])
    expect(verdict.byTweet.get('100')).toEqual(['m0'])
  })
})

describe('planClearSeed — sweep-vs-hook scope asymmetry (pinned as current behavior)', () => {
  const scopeSettings = settings({
    clearOnSave: true,
    clearAllListsOnSave: true,
    autoUnbookmarkOnSave: true,
    autoUnlikeOnSave: true,
    autoNotInterestedOnSave: true,
  })

  it('sweep + clearAllListsOnSave widens to sweep.scope ∪ hookScopes minus notInterested', () => {
    const verdict = planClearSeed({
      requests: [req('m0')],
      mediaById: mediaById(photo('m0', '100')),
      sweep: { scope: 'bookmark' },
      settings: scopeSettings,
    })
    expect(verdict.decision).toBe('seed')
    if (verdict.decision !== 'seed') return
    expect(verdict.origin).toBe('sweep')
    expect([...verdict.scopes].toSorted()).toEqual(['bookmark', 'like'])
  })

  it('sweep + clearAllListsOnSave dedups the sweep scope against hookScopes', () => {
    const verdict = planClearSeed({
      requests: [req('m0')],
      mediaById: mediaById(photo('m0', '100')),
      sweep: { scope: 'like' },
      settings: scopeSettings,
    })
    expect(verdict.decision).toBe('seed')
    if (verdict.decision !== 'seed') return
    expect(verdict.scopes).toEqual(['like', 'bookmark'])
  })

  it('sweep WITHOUT clearAllListsOnSave stays scoped to only sweep.scope', () => {
    const verdict = planClearSeed({
      requests: [req('m0')],
      mediaById: mediaById(photo('m0', '100')),
      sweep: { scope: 'bookmark' },
      settings: settings({ ...scopeSettings, clearAllListsOnSave: false }),
    })
    expect(verdict.decision).toBe('seed')
    if (verdict.decision !== 'seed') return
    expect(verdict.origin).toBe('sweep')
    expect(verdict.scopes).toEqual(['bookmark'])
  })

  // ── consentedScope: the release pin's `consented` source ──
  //
  // A permalink page owns no list scope, so whatever scope the release leg is handed is
  // the only thing that can authorize an irreversible click there. For a sweep that
  // scope is not derived from anything — it IS the list the user pressed Release on,
  // carried straight through so no later url read can contradict it.

  it('carries the sweep’s own scope through as the consented release scope', () => {
    const verdict = planClearSeed({
      requests: [req('m0')],
      mediaById: mediaById(photo('m0', '100')),
      sweep: { scope: 'like' },
      settings: settings({ ...scopeSettings, clearAllListsOnSave: false }),
    })
    expect(verdict).toMatchObject({ decision: 'seed', consentedScope: 'like' })
  })

  it('a widened all-lists sweep still consents to only the list it was pressed on', () => {
    const verdict = planClearSeed({
      requests: [req('m0')],
      mediaById: mediaById(photo('m0', '100')),
      sweep: { scope: 'bookmark' },
      settings: scopeSettings,
    })
    // scopes widen to bookmark+like, but consent — and therefore the page-scoped
    // release pin — stays the pressed list. (All-lists mode omits the pin anyway.)
    expect(verdict).toMatchObject({ decision: 'seed', consentedScope: 'bookmark' })
  })

  it('a notInterested sweep consents to NO release scope: the feed has no membership control', () => {
    const verdict = planClearSeed({
      requests: [req('m0')],
      mediaById: mediaById(photo('m0', '100')),
      sweep: { scope: 'notInterested' },
      settings: settings({ ...scopeSettings, clearAllListsOnSave: false }),
    })
    expect(verdict.decision).toBe('seed')
    if (verdict.decision !== 'seed') return
    expect(verdict.consentedScope).toBeUndefined()
  })

  it('the hook consents to no list at all — its pin comes from the origin tab', () => {
    const verdict = planClearSeed({
      requests: [req('m0')],
      mediaById: mediaById(photo('m0', '100')),
      settings: CLEAR_ON,
      originTabId: 4,
    })
    expect(verdict.decision).toBe('seed')
    if (verdict.decision !== 'seed') return
    expect(verdict.consentedScope).toBeUndefined()
    expect(verdict.originTabId).toBe(4)
  })

  it('hook (no sweep) with the SAME settings gets only hookScopes — the pinned gap', () => {
    const verdict = planClearSeed({
      requests: [req('m0')],
      mediaById: mediaById(photo('m0', '100')),
      settings: scopeSettings,
    })
    expect(verdict.decision).toBe('seed')
    if (verdict.decision !== 'seed') return
    expect(verdict.origin).toBe('hook')
    expect(verdict.scopes).toEqual(['bookmark', 'like', 'notInterested'])
  })
})
