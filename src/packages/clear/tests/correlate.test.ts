import { describe, expect, it } from 'vitest'
import type { DownloadTraceEntry } from '@/packages/schema'
import {
  CORRELATION_WINDOW_MS,
  computeReleaseCorrelationCounters,
  correlateMutation,
  EMPTY_CORRELATION_STATE,
  formatCorrelationVerdict,
  formatReleaseSummaryLine,
  parseClearResolveEvent,
  parseMutationEvent,
  recordResolve,
  type ClearResolveEvent,
  type CorrelationState,
  type MutationEvent,
} from '../correlate'

const entry = (over: Partial<DownloadTraceEntry> = {}): DownloadTraceEntry => ({
  source: 'clear',
  stage: 'clear-flip',
  t: 1000,
  ...over,
})

describe('parseClearResolveEvent', () => {
  it('parses a clear-flip line into a confirmBranch of testid or detached', () => {
    expect(
      parseClearResolveEvent(
        entry({
          stage: 'clear-flip',
          tweetId: '1',
          t: 5000,
          detail:
            'scope=bookmark arm=testid attempt=1 elapsedMs=200 target=button disabled=false reresolved=cleared origin=settle',
        }),
      ),
    ).toEqual({
      tweetId: '1',
      scope: 'bookmark',
      t: 5000,
      origin: 'settle',
      confirmBranch: 'testid',
    })

    expect(
      parseClearResolveEvent(
        entry({
          stage: 'clear-flip',
          tweetId: '2',
          detail:
            'scope=like arm=detached attempt=1 elapsedMs=200 target=button disabled=false reresolved=gone origin=drain',
        }),
      )?.confirmBranch,
    ).toBe('detached')
  })

  it('parses a verified clear-already-cleared line as confirmBranch=already-cleared', () => {
    expect(
      parseClearResolveEvent(
        entry({
          stage: 'clear-already-cleared',
          tweetId: '3',
          detail: 'scope=bookmark clicked=false alreadyCleared=true testids=bookmark origin=manual',
        }),
      ),
    ).toEqual({
      tweetId: '3',
      scope: 'bookmark',
      t: 1000,
      origin: 'manual',
      confirmBranch: 'already-cleared',
    })
  })

  it('rejects an UNVERIFIED already-cleared line (alreadyCleared=false is not a resolve)', () => {
    expect(
      parseClearResolveEvent(
        entry({
          stage: 'clear-already-cleared',
          tweetId: '3',
          detail: 'scope=bookmark clicked=false alreadyCleared=false testids= origin=manual',
        }),
      ),
    ).toBe(null)
  })

  it('ignores clear-flip-fabricated — it duplicates an already-parsed clear-flip', () => {
    expect(
      parseClearResolveEvent(
        entry({
          stage: 'clear-flip-fabricated',
          tweetId: '1',
          detail:
            'scope=bookmark arm=detached attempt=1 elapsedMs=200 target=button disabled=false reresolved=member origin=settle',
        }),
      ),
    ).toBe(null)
  })

  it('null for every non-resolve stage', () => {
    expect(parseClearResolveEvent(entry({ stage: 'clear-attempt-fail', tweetId: '1' }))).toBe(null)
    expect(parseClearResolveEvent(entry({ stage: 'clear-recheck', tweetId: '1' }))).toBe(null)
    expect(parseClearResolveEvent(entry({ stage: 'clear-mutation', tweetId: '1' }))).toBe(null)
  })

  it('null (never throws) with no tweetId, no detail, or malformed tokens', () => {
    expect(parseClearResolveEvent(entry({ stage: 'clear-flip', detail: 'scope=bookmark' }))).toBe(
      null,
    )
    expect(parseClearResolveEvent(entry({ stage: 'clear-flip', tweetId: '1' }))).toBe(null)
    expect(
      parseClearResolveEvent(
        entry({
          stage: 'clear-flip',
          tweetId: '1',
          detail: 'scope=notascope arm=testid origin=settle',
        }),
      ),
    ).toBe(null)
    expect(
      parseClearResolveEvent(
        entry({
          stage: 'clear-flip',
          tweetId: '1',
          detail: 'scope=bookmark arm=bogus origin=settle',
        }),
      ),
    ).toBe(null)
    expect(
      parseClearResolveEvent(
        entry({
          stage: 'clear-flip',
          tweetId: '1',
          detail: 'scope=bookmark arm=testid origin=nonsense',
        }),
      ),
    ).toBe(null)
  })
})

describe('parseMutationEvent', () => {
  it('parses a clear-mutation line', () => {
    expect(
      parseMutationEvent(
        entry({
          stage: 'clear-mutation',
          tweetId: '9',
          t: 2000,
          detail: 'op=DeleteBookmark status=403 error=true',
        }),
      ),
    ).toEqual({ tweetId: '9', op: 'DeleteBookmark', status: 403, error: true, t: 2000 })
  })

  it('null for every non-mutation stage', () => {
    expect(parseMutationEvent(entry({ stage: 'clear-flip', tweetId: '1' }))).toBe(null)
  })

  it('null when detail is absent entirely', () => {
    expect(parseMutationEvent(entry({ stage: 'clear-mutation', tweetId: '1' }))).toBe(null)
  })

  it('null (never throws) with no tweetId or malformed tokens', () => {
    expect(
      parseMutationEvent(
        entry({ stage: 'clear-mutation', detail: 'op=DeleteBookmark status=200 error=false' }),
      ),
    ).toBe(null)
    expect(
      parseMutationEvent(
        entry({ stage: 'clear-mutation', tweetId: '1', detail: 'op=Bogus status=200 error=false' }),
      ),
    ).toBe(null)
    expect(
      parseMutationEvent(
        entry({
          stage: 'clear-mutation',
          tweetId: '1',
          detail: 'op=DeleteBookmark status=abc error=false',
        }),
      ),
    ).toBe(null)
    expect(
      parseMutationEvent(
        entry({
          stage: 'clear-mutation',
          tweetId: '1',
          detail: 'op=DeleteBookmark status=200 error=maybe',
        }),
      ),
    ).toBe(null)
  })
})

const resolve = (over: Partial<ClearResolveEvent> = {}): ClearResolveEvent => ({
  tweetId: '1',
  scope: 'bookmark',
  t: 10_000,
  origin: 'settle',
  confirmBranch: 'testid',
  ...over,
})

const mutation = (over: Partial<MutationEvent> = {}): MutationEvent => ({
  tweetId: '1',
  op: 'DeleteBookmark',
  status: 403,
  error: true,
  t: 12_000,
  ...over,
})

describe('recordResolve', () => {
  it('adds an entry keyed by tweetId+scope', () => {
    const state = recordResolve(EMPTY_CORRELATION_STATE, resolve(), 10_000)
    expect(state.resolves.get('1:bookmark')).toEqual(resolve())
  })

  it('a fresh resolve for the SAME key replaces the old one', () => {
    let state = recordResolve(EMPTY_CORRELATION_STATE, resolve({ t: 1000, origin: 'settle' }), 1000)
    state = recordResolve(state, resolve({ t: 2000, origin: 'drain' }), 2000)
    expect(state.resolves.get('1:bookmark')?.origin).toBe('drain')
    expect(state.resolves.size).toBe(1)
  })

  it('bookmark and like scopes for the same tweet are independent entries', () => {
    let state = recordResolve(EMPTY_CORRELATION_STATE, resolve({ scope: 'bookmark' }), 10_000)
    state = recordResolve(state, resolve({ scope: 'like' }), 10_000)
    expect(state.resolves.size).toBe(2)
  })

  it('prunes entries older than the correlation window relative to now', () => {
    let state = recordResolve(EMPTY_CORRELATION_STATE, resolve({ tweetId: 'old', t: 0 }), 0)
    state = recordResolve(
      state,
      resolve({ tweetId: 'new', t: CORRELATION_WINDOW_MS + 1 }),
      CORRELATION_WINDOW_MS + 1,
    )
    expect(state.resolves.has('old:bookmark')).toBe(false)
    expect(state.resolves.has('new:bookmark')).toBe(true)
  })

  it('never mutates the state passed in', () => {
    const before = EMPTY_CORRELATION_STATE
    recordResolve(before, resolve(), 10_000)
    expect(before.resolves.size).toBe(0)
  })
})

const withResolve = (r: ClearResolveEvent = resolve()): CorrelationState =>
  recordResolve(EMPTY_CORRELATION_STATE, r, r.t)

describe('correlateMutation', () => {
  it('IN-WINDOW: a failed DeleteBookmark shortly after the resolve ⇒ server-reject', () => {
    const state = withResolve(resolve({ t: 10_000 }))
    const v = correlateMutation(state, mutation({ t: 15_000, status: 403, error: true }))
    expect(v?.kind).toBe('server-reject')
    expect(v?.resolve.t).toBe(10_000)
  })

  it('a 200-with-errors-array DeleteBookmark ALSO counts as a server-reject (error=true, not just status)', () => {
    const state = withResolve()
    const v = correlateMutation(state, mutation({ status: 200, error: true }))
    expect(v?.kind).toBe('server-reject')
  })

  it('a genuinely successful DeleteBookmark (200, no errors) is NOT a server-reject', () => {
    const state = withResolve()
    expect(correlateMutation(state, mutation({ status: 200, error: false }))).toBe(null)
  })

  it('OUT-OF-WINDOW: a failure long after the resolve is not attributed to it', () => {
    const state = withResolve(resolve({ t: 0 }))
    const v = correlateMutation(state, mutation({ t: CORRELATION_WINDOW_MS + 1 }))
    expect(v).toBe(null)
  })

  it('OUT-OF-WINDOW (other direction): a DeleteBookmark timestamped BEFORE the resolve is not its mutation', () => {
    const state = withResolve(resolve({ t: 10_000 }))
    const v = correlateMutation(state, mutation({ t: 5_000 }))
    expect(v).toBe(null)
  })

  it('ID-MISSING: no resolve recorded for this tweetId ⇒ null', () => {
    const v = correlateMutation(EMPTY_CORRELATION_STATE, mutation({ tweetId: 'unseen' }))
    expect(v).toBe(null)
  })

  it('DUPLICATE-MUTATION: the same failure correlated twice reports server-reject BOTH times — each mutation event is judged independently, not deduped', () => {
    const state = withResolve()
    const dup = mutation()
    expect(correlateMutation(state, dup)?.kind).toBe('server-reject')
    expect(correlateMutation(state, dup)?.kind).toBe('server-reject')
  })

  it('IN-WINDOW: a CreateBookmark near the resolve ⇒ re-add-fingerprint, symmetric in time', () => {
    const state = withResolve(resolve({ t: 10_000 }))
    const after = correlateMutation(
      state,
      mutation({ op: 'CreateBookmark', t: 15_000, status: 200, error: false }),
    )
    expect(after?.kind).toBe('re-add-fingerprint')
    const before = correlateMutation(
      state,
      mutation({ op: 'CreateBookmark', t: 5_000, status: 200, error: false }),
    )
    expect(before?.kind).toBe('re-add-fingerprint')
  })

  it('OUT-OF-WINDOW: a CreateBookmark far from the resolve is not a fingerprint', () => {
    const state = withResolve(resolve({ t: 10_000 }))
    const v = correlateMutation(
      state,
      mutation({
        op: 'CreateBookmark',
        t: 10_000 + CORRELATION_WINDOW_MS + 1,
        status: 200,
        error: false,
      }),
    )
    expect(v).toBe(null)
  })

  it('a FavoriteTweet/UnfavoriteTweet mutation never correlates (bookmark-scoped only, per spec)', () => {
    const state = withResolve()
    expect(
      correlateMutation(state, mutation({ op: 'FavoriteTweet', status: 403, error: true })),
    ).toBe(null)
    expect(
      correlateMutation(state, mutation({ op: 'UnfavoriteTweet', status: 403, error: true })),
    ).toBe(null)
  })

  it('only checks the bookmark-scope resolve, even if a like-scope resolve exists for the same tweet', () => {
    let state = recordResolve(
      EMPTY_CORRELATION_STATE,
      resolve({ scope: 'like', t: 10_000 }),
      10_000,
    )
    // No bookmark resolve recorded — a DeleteBookmark failure must not borrow the like resolve.
    expect(correlateMutation(state, mutation({ t: 11_000 }))).toBe(null)
    state = recordResolve(state, resolve({ scope: 'bookmark', t: 10_000 }), 10_000)
    expect(correlateMutation(state, mutation({ t: 11_000 }))?.kind).toBe('server-reject')
  })
})

describe('formatCorrelationVerdict', () => {
  it('formats a server-reject verdict with status/error and a signed elapsedMs', () => {
    const v = correlateMutation(
      recordResolve(
        EMPTY_CORRELATION_STATE,
        resolve({ t: 10_000, origin: 'drain', confirmBranch: 'detached' }),
        10_000,
      ),
      mutation({ t: 12_000, status: 403, error: true }),
    )!
    expect(formatCorrelationVerdict(v)).toEqual({
      stage: 'clear-server-reject',
      detail:
        'scope=bookmark origin=drain confirmBranch=detached resolvedAt=10000 elapsedMs=2000 status=403 error=true',
    })
  })

  it('formats a re-add-fingerprint verdict with a NEGATIVE elapsedMs when the mutation preceded the resolve', () => {
    const v = correlateMutation(
      recordResolve(EMPTY_CORRELATION_STATE, resolve({ t: 10_000 }), 10_000),
      mutation({ op: 'CreateBookmark', t: 9_000, status: 200, error: false }),
    )!
    expect(formatCorrelationVerdict(v)).toEqual({
      stage: 'clear-re-add-fingerprint',
      detail: 'scope=bookmark origin=settle confirmBranch=testid resolvedAt=10000 elapsedMs=-1000',
    })
  })
})

const ZERO_COUNTERS = {
  clears: 0,
  clearsByBranch: { testid: 0, detached: 0, alreadyCleared: 0 },
  mutations: 0,
  serverRejects: 0,
  reAddFingerprints: 0,
  reappearances: 0,
}

describe('computeReleaseCorrelationCounters', () => {
  it('counts clear-flip and VERIFIED already-cleared lines as clears, split by confirmBranch, ignoring clear-flip-fabricated', () => {
    const events: DownloadTraceEntry[] = [
      entry({
        stage: 'clear-flip',
        tweetId: '1',
        detail: 'scope=bookmark arm=testid origin=settle',
      }),
      entry({
        stage: 'clear-flip',
        tweetId: '4',
        detail: 'scope=bookmark arm=detached origin=settle',
      }),
      entry({
        stage: 'clear-flip-fabricated',
        tweetId: '1',
        detail: 'scope=bookmark arm=detached origin=settle',
      }),
      entry({
        stage: 'clear-already-cleared',
        tweetId: '2',
        detail: 'scope=bookmark clicked=false alreadyCleared=true testids=bookmark origin=settle',
      }),
      entry({
        stage: 'clear-already-cleared',
        tweetId: '3',
        detail: 'scope=bookmark clicked=false alreadyCleared=false testids= origin=settle',
      }),
    ]
    const counters = computeReleaseCorrelationCounters(events)
    expect(counters.clears).toBe(3)
    expect(counters.clearsByBranch).toEqual({ testid: 1, detached: 1, alreadyCleared: 1 })
  })

  it('counts mutations, server-rejects, re-add-fingerprints, and reappearances independently', () => {
    const events: DownloadTraceEntry[] = [
      entry({ stage: 'clear-mutation', tweetId: '1' }),
      entry({ stage: 'clear-mutation', tweetId: '2' }),
      entry({ stage: 'clear-server-reject', tweetId: '1' }),
      entry({ stage: 'clear-re-add-fingerprint', tweetId: '2' }),
      entry({ stage: 'clear-re-add-fingerprint', tweetId: '3' }),
      entry({ stage: 'clear-reappeared', tweetId: '4' }),
    ]
    const counters = computeReleaseCorrelationCounters(events)
    expect(counters).toEqual({
      ...ZERO_COUNTERS,
      mutations: 2,
      serverRejects: 1,
      reAddFingerprints: 2,
      reappearances: 1,
    })
  })

  it('zero counters for an empty log', () => {
    expect(computeReleaseCorrelationCounters([])).toEqual(ZERO_COUNTERS)
  })

  it('ignores unrelated stages entirely', () => {
    const events: DownloadTraceEntry[] = [
      entry({ stage: 'clear-recheck', tweetId: '1' }),
      entry({ stage: 'clear-sweep-request' }),
      entry({ stage: 'clear-visible-start' }),
    ]
    expect(computeReleaseCorrelationCounters(events)).toEqual(ZERO_COUNTERS)
  })
})

describe('formatReleaseSummaryLine', () => {
  it('the clean-run demo line: N released, N flips, 0 mismatches', () => {
    expect(
      formatReleaseSummaryLine({
        ...ZERO_COUNTERS,
        clears: 12,
        clearsByBranch: { testid: 10, detached: 2, alreadyCleared: 0 },
      }),
    ).toBe('12 released · 12 flips · 0 mismatches')
  })

  it('flips excludes alreadyCleared — a verified no-op is not a flip', () => {
    expect(
      formatReleaseSummaryLine({
        ...ZERO_COUNTERS,
        clears: 5,
        clearsByBranch: { testid: 2, detached: 0, alreadyCleared: 3 },
      }),
    ).toBe('5 released · 2 flips · 0 mismatches')
  })

  it('mismatches sums server-rejects, re-add fingerprints, and reappearances', () => {
    expect(
      formatReleaseSummaryLine({
        ...ZERO_COUNTERS,
        clears: 14,
        clearsByBranch: { testid: 14, detached: 0, alreadyCleared: 0 },
        serverRejects: 1,
        reAddFingerprints: 1,
        reappearances: 1,
      }),
    ).toBe('14 released · 14 flips · 3 mismatches')
  })

  it('singular "flip"/"mismatch" at exactly 1', () => {
    expect(
      formatReleaseSummaryLine({
        ...ZERO_COUNTERS,
        clears: 1,
        clearsByBranch: { testid: 1, detached: 0, alreadyCleared: 0 },
        reappearances: 1,
      }),
    ).toBe('1 released · 1 flip · 1 mismatch')
  })

  it('the true zero-state line reads 0 released · 0 flips · 0 mismatches', () => {
    expect(formatReleaseSummaryLine(ZERO_COUNTERS)).toBe('0 released · 0 flips · 0 mismatches')
  })
})
