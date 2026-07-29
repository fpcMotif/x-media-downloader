import { describe, it, expect } from 'vitest'
import {
  attemptReservedClear,
  bindCompletionHandle,
  canReserveClear,
  clearScopeIntent,
  decodeCompletionLedger,
  emptyCompletionLedger,
  encodeCompletionLedger,
  failCompletion,
  failUnboundCompletion,
  hookScopes,
  isTrulyCompleteDurable,
  observeCompletion,
  pruneExpiredAutomaticFailures,
  pruneResolvedEntry,
  rebindPersistedHandle,
  recoverClearClaims,
  releaseReservedClear,
  reserveClear,
  resolveAttemptedClear,
  SETTLE_CONFIRM_MS,
  seedCompletionEntry,
  skipReadyClear,
  settleCompletion,
  type ClearTombstone,
  type Scope,
} from './ledger'
import type { Settings } from '../schema'

/** hookScopes reads only the three per-scope toggles; cast a minimal partial. */
const toggles = (bookmark: boolean, like: boolean, notInterested: boolean): Settings =>
  ({
    autoUnbookmarkOnSave: bookmark,
    autoUnlikeOnSave: like,
    autoNotInterestedOnSave: notInterested,
  }) as Settings

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

// The background owns persistence;
// this module only validates the wire value and applies atomic pure transitions.
describe('durable Completion Ledger', () => {
  const tweetId = '12345678901234567890'
  const seedDurable = (
    over: Partial<{
      expected: string[]
      manualScopes: Scope[]
      automaticScopes: Scope[]
      crossListAutomaticScopes: Scope[]
      at: number
    }> = {},
  ) =>
    seedCompletionEntry(emptyCompletionLedger(), {
      tweetId,
      expected: over.expected ?? ['request-a'],
      starting: over.expected ?? ['request-a'],
      manualScopes: over.manualScopes ?? [],
      automaticScopes: over.automaticScopes ?? ['bookmark'],
      crossListAutomaticScopes: over.crossListAutomaticScopes ?? [],
      at: over.at ?? 10,
    })

  const complete = (ledger = seedDurable()) => {
    let next = bindCompletionHandle(ledger, {
      tweetId,
      requestId: 'request-a',
      downloadId: 1,
      at: 11,
    })
    next = observeCompletion(next, {
      tweetId,
      requestId: 'request-a',
      downloadId: 1,
      at: 12,
    })
    return settleCompletion(next, { tweetId, requestId: 'request-a', downloadId: 1, at: 1512 })
  }

  it('rebinds only a missing persisted live handle; never terminal evidence', () => {
    const live = seedDurable()
    const rebound = rebindPersistedHandle(live, {
      tweetId,
      requestId: 'request-a',
      downloadId: 1,
      at: 11,
    })
    expect(rebound.entries.get(tweetId)?.handles['request-a']).toEqual({
      downloadId: 1,
      startedAt: 11,
    })
    expect(
      rebindPersistedHandle(rebound, { tweetId, requestId: 'request-a', downloadId: 1, at: 12 }),
    ).toBe(rebound)
    expect(
      rebindPersistedHandle(rebound, {
        tweetId,
        requestId: 'request-a',
        downloadId: 2,
        priorDownloadId: 9,
        at: 12,
      }),
    ).toBe(rebound)
    const retry = rebindPersistedHandle(rebound, {
      tweetId,
      requestId: 'request-a',
      downloadId: 2,
      priorDownloadId: 1,
      at: 12,
    })
    expect(retry.entries.get(tweetId)?.handles['request-a']).toEqual({
      downloadId: 2,
      startedAt: 12,
    })
    const settling = observeCompletion(rebound, {
      tweetId,
      requestId: 'request-a',
      downloadId: 1,
      at: 12,
    })
    expect(
      rebindPersistedHandle(settling, {
        tweetId,
        requestId: 'request-a',
        downloadId: 1,
        at: 13,
      }),
    ).toBe(settling)
    const terminal = complete()
    expect(
      rebindPersistedHandle(terminal, {
        tweetId,
        requestId: 'request-a',
        downloadId: 1,
        at: 2000,
      }),
    ).toBe(terminal)
    const failed = failUnboundCompletion(live, { tweetId, requestId: 'request-a', at: 12 })
    expect(
      rebindPersistedHandle(failed, {
        tweetId,
        requestId: 'request-a',
        downloadId: 1,
        at: 13,
      }),
    ).toBe(failed)
    expect(
      rebindPersistedHandle(live, {
        tweetId,
        requestId: 'untracked',
        downloadId: 1,
        at: 11,
      }),
    ).toBe(live)
    const owned = bindCompletionHandle(seedDurable({ expected: ['request-a', 'request-b'] }), {
      tweetId,
      requestId: 'request-a',
      downloadId: 1,
      at: 11,
    })
    expect(
      rebindPersistedHandle(owned, {
        tweetId,
        requestId: 'request-b',
        downloadId: 1,
        at: 12,
      }),
    ).toBe(owned)
  })

  it('round-trips a canonical store and normalizes duplicate wire arrays', () => {
    const raw = {
      version: 1,
      entries: {
        [tweetId]: {
          tweetId,
          manualScopes: ['like', 'like'],
          automaticScopes: ['bookmark'],
          crossListAutomaticScopes: [],
          expected: ['request-b', 'request-a', 'request-a'],
          done: [],
          failed: [],
          inProgress: ['request-a', 'request-b', 'request-a'],
          clear: { bookmark: 'none', like: 'none', notInterested: 'none' },
          handles: {},
          settling: {},
          createdAt: 1,
          touchedAt: 1,
        },
      },
      tombstones: {},
    }
    const decoded = decodeCompletionLedger(raw)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(encodeCompletionLedger(decoded.ledger).entries[tweetId]?.expected).toEqual([
      'request-a',
      'request-b',
    ])
    expect(encodeCompletionLedger(decoded.ledger).entries[tweetId]?.manualScopes).toEqual(['like'])
  })

  it('rejects cross-list scopes outside automatic scopes', () => {
    const stored = encodeCompletionLedger(seedDurable())
    const entry = stored.entries[tweetId]!
    const corrupt = {
      ...stored,
      entries: {
        [tweetId]: { ...entry, crossListAutomaticScopes: ['like'] },
      },
    }
    expect(decodeCompletionLedger(corrupt)).toEqual({
      ok: false,
      reason: `invalid entry ${tweetId}`,
    })
  })

  it('rejects cleared or uncertain active state without its immediate tombstone', () => {
    const stored = encodeCompletionLedger(complete())
    const entry = stored.entries[tweetId]!
    for (const state of ['cleared', 'uncertain'] as const) {
      expect(
        decodeCompletionLedger({
          ...stored,
          entries: {
            [tweetId]: { ...entry, clear: { ...entry.clear, bookmark: state } },
          },
        }),
      ).toEqual({
        ok: false,
        reason: `missing terminal tombstone ${tweetId}/bookmark`,
      })
    }
  })

  it('fails closed on corrupt data; it never returns an empty ledger', () => {
    expect(decodeCompletionLedger({ version: 2, entries: {}, tombstones: {} })).toEqual({
      ok: false,
      reason: 'invalid ledger envelope',
    })
    const corrupt = encodeCompletionLedger(seedDurable()) as {
      entries: Record<string, { tweetId: string }>
    }
    corrupt.entries[tweetId]!.tweetId = 'not-a-snowflake'
    expect(decodeCompletionLedger(corrupt).ok).toBe(false)
  })

  it('rejects impossible witness state: a request cannot have handle and settle witnesses', () => {
    const stored = encodeCompletionLedger(seedDurable())
    const entry = stored.entries[tweetId]!
    const corrupt = {
      ...stored,
      entries: {
        [tweetId]: {
          ...entry,
          done: ['request-a'],
          handles: { 'request-a': { downloadId: 1, startedAt: 11 } },
          settling: { 'request-a': { downloadId: 1, dueAt: 1511 } },
        },
      },
    }
    expect(decodeCompletionLedger(corrupt)).toEqual({
      ok: false,
      reason: `invalid entry ${tweetId}`,
    })
  })

  it('rejects a settle deadline that cannot follow a nonnegative observation time', () => {
    const stored = encodeCompletionLedger(seedDurable())
    const entry = stored.entries[tweetId]!
    const corrupt = {
      ...stored,
      entries: {
        [tweetId]: {
          ...entry,
          done: ['request-a'],
          handles: {},
          settling: {
            'request-a': {
              downloadId: 1,
              dueAt: SETTLE_CONFIRM_MS - 1,
            },
          },
        },
      },
    }
    expect(decodeCompletionLedger(corrupt)).toEqual({
      ok: false,
      reason: `invalid entry ${tweetId}`,
    })
  })

  it('rejects an observed completion without its settle witness', () => {
    const stored = encodeCompletionLedger(seedDurable())
    const entry = stored.entries[tweetId]!
    const corrupt = {
      ...stored,
      entries: {
        [tweetId]: {
          ...entry,
          done: ['request-a'],
          inProgress: ['request-a'],
        },
      },
    }
    expect(decodeCompletionLedger(corrupt)).toEqual({
      ok: false,
      reason: `invalid entry ${tweetId}`,
    })
  })

  it('ignores a late terminal from a replaced retry handle', () => {
    let ledger = seedDurable()
    ledger = bindCompletionHandle(ledger, {
      tweetId,
      requestId: 'request-a',
      downloadId: 1,
      at: 11,
    })
    ledger = bindCompletionHandle(ledger, {
      tweetId,
      requestId: 'request-a',
      downloadId: 2,
      at: 12,
    })
    const stale = failCompletion(ledger, { tweetId, requestId: 'request-a', downloadId: 1, at: 13 })
    expect(stale).toBe(ledger)
    const entry = stale.entries.get(tweetId)!
    expect(entry.failed.has('request-a')).toBe(false)
    expect(entry.handles['request-a']).toEqual({ downloadId: 2, startedAt: 12 })
  })

  it('rejects duplicate download witnesses across entries and refuses a duplicate bind', () => {
    const secondTweetId = '1234567890123456789'
    let ledger = seedCompletionEntry(seedDurable(), {
      tweetId: secondTweetId,
      expected: ['request-b'],
      starting: ['request-b'],
      manualScopes: [],
      automaticScopes: ['bookmark'],
      at: 10,
    })
    ledger = bindCompletionHandle(ledger, {
      tweetId,
      requestId: 'request-a',
      downloadId: 1,
      at: 11,
    })
    expect(
      bindCompletionHandle(ledger, {
        tweetId: secondTweetId,
        requestId: 'request-b',
        downloadId: 1,
        at: 12,
      }),
    ).toBe(ledger)

    const stored = encodeCompletionLedger(ledger)
    const second = stored.entries[secondTweetId]!
    const corrupt = {
      ...stored,
      entries: {
        ...stored.entries,
        [secondTweetId]: {
          ...second,
          done: ['request-b'],
          settling: { 'request-b': { downloadId: 1, dueAt: 1512 } },
        },
      },
    }
    expect(decodeCompletionLedger(corrupt)).toEqual({
      ok: false,
      reason: 'duplicate download witness 1',
    })
  })

  it('accepts Chrome download id zero through bind, settle, and codec', () => {
    let ledger = bindCompletionHandle(seedDurable(), {
      tweetId,
      requestId: 'request-a',
      downloadId: 0,
      at: 11,
    })
    ledger = observeCompletion(ledger, {
      tweetId,
      requestId: 'request-a',
      downloadId: 0,
      at: 12,
    })
    ledger = settleCompletion(ledger, { tweetId, requestId: 'request-a', downloadId: 0, at: 1512 })
    expect(isTrulyCompleteDurable(ledger.entries.get(tweetId)!)).toBe(true)
    expect(decodeCompletionLedger(encodeCompletionLedger(ledger)).ok).toBe(true)
  })

  it('fails only an unbound expected item; a bound item still requires its exact handle', () => {
    let ledger = seedDurable()
    ledger = failUnboundCompletion(ledger, { tweetId, requestId: 'request-a', at: 11 })
    expect(ledger.entries.get(tweetId)?.failed.has('request-a')).toBe(true)

    ledger = seedDurable()
    ledger = bindCompletionHandle(ledger, {
      tweetId,
      requestId: 'request-a',
      downloadId: 1,
      at: 11,
    })
    expect(failUnboundCompletion(ledger, { tweetId, requestId: 'request-a', at: 12 })).toBe(ledger)
  })

  it('derives the exact settle deadline and rejects an overflowing observation clock', () => {
    let ledger = seedDurable()
    ledger = bindCompletionHandle(ledger, {
      tweetId,
      requestId: 'request-a',
      downloadId: 1,
      at: 11,
    })
    expect(
      observeCompletion(ledger, {
        tweetId,
        requestId: 'request-a',
        downloadId: 1,
        at: Number.MAX_SAFE_INTEGER,
      }),
    ).toBe(ledger)
    ledger = observeCompletion(ledger, {
      tweetId,
      requestId: 'request-a',
      downloadId: 1,
      at: 12,
    })
    expect(ledger.entries.get(tweetId)?.settling['request-a']?.dueAt).toBe(12 + SETTLE_CONFIRM_MS)
    expect(
      settleCompletion(ledger, {
        tweetId,
        requestId: 'request-a',
        downloadId: 1,
        at: 12 + SETTLE_CONFIRM_MS - 1,
      }),
    ).toBe(ledger)
  })

  it('requires settle after exact observed completion before Clear reservation', () => {
    let ledger = seedDurable()
    ledger = bindCompletionHandle(ledger, {
      tweetId,
      requestId: 'request-a',
      downloadId: 1,
      at: 11,
    })
    ledger = observeCompletion(ledger, {
      tweetId,
      requestId: 'request-a',
      downloadId: 1,
      at: 12,
    })
    expect(canReserveClear(ledger, tweetId, 'bookmark')).toBe(false)
    ledger = settleCompletion(ledger, { tweetId, requestId: 'request-a', downloadId: 1, at: 1512 })
    expect(isTrulyCompleteDurable(ledger.entries.get(tweetId)!)).toBe(true)
    expect(canReserveClear(ledger, tweetId, 'bookmark')).toBe(true)
  })

  it('reseed restarts a settled request without disturbing a settled sibling', () => {
    let ledger = seedDurable({ expected: ['request-a', 'request-b'] })
    for (const [requestId, downloadId] of [
      ['request-a', 1],
      ['request-b', 2],
    ] as const) {
      ledger = bindCompletionHandle(ledger, { tweetId, requestId, downloadId, at: 11 })
      ledger = observeCompletion(ledger, {
        tweetId,
        requestId,
        downloadId,
        at: 12,
      })
      ledger = settleCompletion(ledger, {
        tweetId,
        requestId,
        downloadId,
        at: 12 + SETTLE_CONFIRM_MS,
      })
    }
    expect(isTrulyCompleteDurable(ledger.entries.get(tweetId)!)).toBe(true)

    ledger = seedCompletionEntry(ledger, {
      tweetId,
      expected: ['request-a', 'request-b'],
      starting: ['request-a'],
      manualScopes: [],
      automaticScopes: ['bookmark'],
      at: 1513,
    })
    const entry = ledger.entries.get(tweetId)!
    expect(entry.done).toEqual(new Set(['request-b']))
    expect(entry.failed.has('request-a')).toBe(false)
    expect(entry.inProgress).toEqual(new Set(['request-a']))
    expect(entry.handles['request-a']).toBeUndefined()
    expect(entry.settling['request-a']).toBeUndefined()
    expect(isTrulyCompleteDurable(entry)).toBe(false)
    expect(canReserveClear(ledger, tweetId, 'bookmark')).toBe(false)

    const stale = failCompletion(ledger, {
      tweetId,
      requestId: 'request-a',
      downloadId: 1,
      at: 1514,
    })
    expect(stale).toBe(ledger)
    expect(decodeCompletionLedger(encodeCompletionLedger(ledger)).ok).toBe(true)
  })

  it('rejects a start that is not an expected prerequisite', () => {
    const ledger = seedDurable()
    expect(
      seedCompletionEntry(ledger, {
        tweetId,
        expected: ['request-a'],
        starting: ['request-b'],
        manualScopes: [],
        automaticScopes: ['bookmark'],
        at: 11,
      }),
    ).toBe(ledger)
  })

  it('reseed drops a stale handle or settle witness before the replacement binds', () => {
    let ledger = seedDurable()
    ledger = bindCompletionHandle(ledger, {
      tweetId,
      requestId: 'request-a',
      downloadId: 1,
      at: 11,
    })
    ledger = seedCompletionEntry(ledger, {
      tweetId,
      expected: ['request-a'],
      starting: ['request-a'],
      manualScopes: [],
      automaticScopes: ['bookmark'],
      at: 12,
    })
    expect(ledger.entries.get(tweetId)?.handles['request-a']).toBeUndefined()

    ledger = bindCompletionHandle(ledger, {
      tweetId,
      requestId: 'request-a',
      downloadId: 2,
      at: 13,
    })
    ledger = observeCompletion(ledger, {
      tweetId,
      requestId: 'request-a',
      downloadId: 2,
      at: 14,
    })
    ledger = seedCompletionEntry(ledger, {
      tweetId,
      expected: ['request-a'],
      starting: ['request-a'],
      manualScopes: [],
      automaticScopes: ['bookmark'],
      at: 15,
    })
    const entry = ledger.entries.get(tweetId)!
    expect(entry.settling['request-a']).toBeUndefined()
    expect(entry.done.has('request-a')).toBe(false)
    expect(entry.inProgress.has('request-a')).toBe(true)
    expect(
      settleCompletion(ledger, {
        tweetId,
        requestId: 'request-a',
        downloadId: 2,
        at: 14 + SETTLE_CONFIRM_MS,
      }),
    ).toBe(ledger)
  })

  it('reseed still restarts tracking when its scope is tombstoned', () => {
    let ledger = complete()
    ledger = {
      ...ledger,
      tombstones: new Map([
        [
          tweetId,
          new Map([
            ['like', { tweetId, scope: 'like' as const, state: 'cleared' as const, at: 1513 }],
          ]),
        ],
      ]),
    }
    ledger = seedCompletionEntry(ledger, {
      tweetId,
      expected: ['request-a'],
      starting: ['request-a'],
      manualScopes: [],
      automaticScopes: ['like'],
      at: 1514,
    })
    const entry = ledger.entries.get(tweetId)!
    expect(entry.automaticScopes.has('like')).toBe(false)
    expect(ledger.tombstones.get(tweetId)?.get('like')).toMatchObject({ state: 'cleared' })
    expect(entry.inProgress).toEqual(new Set(['request-a']))
    expect(entry.done.has('request-a')).toBe(false)
    expect(isTrulyCompleteDurable(entry)).toBe(false)
  })

  it('recovers reserved to failed and attempted to immediate uncertain tombstone', () => {
    let ledger = complete(seedDurable({ automaticScopes: ['bookmark', 'like'] }))
    ledger = reserveClear(ledger, tweetId, 'bookmark', 1513)
    ledger = attemptReservedClear(ledger, tweetId, 'bookmark', 1514)
    ledger = reserveClear(ledger, tweetId, 'like', 1515)
    ledger = recoverClearClaims(ledger, 2000)
    const recovered = ledger.entries.get(tweetId)!
    expect(recovered.clear.bookmark).toBe('uncertain')
    expect(recovered.clear.like).toBe('failed')
    expect(ledger.tombstones.get(tweetId)?.get('bookmark')).toMatchObject({
      state: 'uncertain',
      at: 2000,
    })
    expect(decodeCompletionLedger(encodeCompletionLedger(ledger)).ok).toBe(true)
    ledger = resolveAttemptedClear(
      // Failed is retryable. Reserve + attempt it before a verified result.
      attemptReservedClear(reserveClear(ledger, tweetId, 'like', 2001), tweetId, 'like', 2002),
      { tweetId, scope: 'like', result: 'cleared', at: 2003 },
    )
    ledger = pruneResolvedEntry(ledger, tweetId, 2004)
    expect(ledger.entries.get(tweetId)).toBeUndefined()
    expect(ledger.tombstones.get(tweetId)?.get('bookmark')).toMatchObject({ state: 'uncertain' })
    expect(ledger.tombstones.get(tweetId)?.get('like')).toMatchObject({
      state: 'cleared',
      at: 2003,
    })
    expect(decodeCompletionLedger(encodeCompletionLedger(ledger)).ok).toBe(true)
  })

  it('records partial verified Clears immediately and exposes only them in the Clear Log', () => {
    let ledger = complete(seedDurable({ automaticScopes: ['bookmark', 'like'] }))
    ledger = resolveAttemptedClear(
      attemptReservedClear(
        reserveClear(ledger, tweetId, 'bookmark', 1513),
        tweetId,
        'bookmark',
        1514,
      ),
      { tweetId, scope: 'bookmark', result: 'cleared', at: 1515 },
    )
    ledger = resolveAttemptedClear(
      attemptReservedClear(reserveClear(ledger, tweetId, 'like', 1516), tweetId, 'like', 1517),
      { tweetId, scope: 'like', result: 'failed', at: 1518 },
    )
    expect(ledger.tombstones.get(tweetId)?.get('bookmark')).toMatchObject({
      state: 'cleared',
      at: 1515,
    })
    expect(decodeCompletionLedger(encodeCompletionLedger(ledger)).ok).toBe(true)

    const stored = encodeCompletionLedger(ledger)
    const corrupt = {
      ...stored,
      tombstones: {
        ...stored.tombstones,
        [tweetId]: {
          ...stored.tombstones[tweetId],
          bookmark: { ...stored.tombstones[tweetId]!.bookmark!, state: 'uncertain' },
        },
      },
    }
    expect(decodeCompletionLedger(corrupt)).toEqual({
      ok: false,
      reason: `overlapping tombstone ${tweetId}/bookmark`,
    })
  })

  it('does not attempt a reserved scope after a re-seed adds unsettled media', () => {
    let ledger = complete()
    ledger = reserveClear(ledger, tweetId, 'bookmark', 1513)
    ledger = seedCompletionEntry(ledger, {
      tweetId,
      expected: ['request-b'],
      starting: ['request-b'],
      manualScopes: [],
      automaticScopes: ['bookmark'],
      at: 1514,
    })
    expect(attemptReservedClear(ledger, tweetId, 'bookmark', 1515)).toBe(ledger)
    expect(ledger.entries.get(tweetId)?.clear.bookmark).toBe('reserved')
  })

  it('releases only a persisted reservation before its destructive send', () => {
    let ledger = reserveClear(complete(), tweetId, 'bookmark', 1513)
    ledger = releaseReservedClear(ledger, tweetId, 'bookmark', 1514)
    expect(ledger.entries.get(tweetId)?.clear.bookmark).toBe('failed')
    expect(releaseReservedClear(ledger, tweetId, 'bookmark', 1515)).toBe(ledger)
  })

  it('records read-only already-clear evidence as skipped without a tombstone', () => {
    const ledger = skipReadyClear(complete(), tweetId, 'bookmark', 1513)
    expect(ledger.entries.get(tweetId)?.clear.bookmark).toBe('skipped')
    expect(ledger.tombstones.get(tweetId)).toBeUndefined()
    expect(skipReadyClear(ledger, tweetId, 'bookmark', 1514)).toBe(ledger)
    const incomplete = seedDurable()
    expect(skipReadyClear(incomplete, tweetId, 'bookmark', 11)).toBe(incomplete)
  })

  it('rearms only a newly intended skipped scope for a later save', () => {
    let ledger = complete(seedDurable({ automaticScopes: ['bookmark', 'like'] }))
    ledger = skipReadyClear(ledger, tweetId, 'bookmark', 1513)
    ledger = skipReadyClear(ledger, tweetId, 'like', 1514)
    ledger = seedCompletionEntry(ledger, {
      tweetId,
      expected: ['request-a', 'request-b'],
      starting: ['request-b'],
      manualScopes: [],
      automaticScopes: ['bookmark'],
      at: 1515,
    })
    expect(ledger.entries.get(tweetId)?.clear.bookmark).toBe('none')
    expect(ledger.entries.get(tweetId)?.clear.like).toBe('skipped')

    ledger = bindCompletionHandle(ledger, {
      tweetId,
      requestId: 'request-b',
      downloadId: 2,
      at: 1516,
    })
    ledger = observeCompletion(ledger, {
      tweetId,
      requestId: 'request-b',
      downloadId: 2,
      at: 1517,
    })
    ledger = settleCompletion(ledger, {
      tweetId,
      requestId: 'request-b',
      downloadId: 2,
      at: 1517 + SETTLE_CONFIRM_MS,
    })
    expect(canReserveClear(ledger, tweetId, 'bookmark')).toBe(true)
    expect(canReserveClear(ledger, tweetId, 'like')).toBe(false)
  })

  it('ordinary auto intent permanently outranks later cross-list-only intent', () => {
    let ledger = seedDurable({
      expected: ['request-a'],
      automaticScopes: ['bookmark'],
      crossListAutomaticScopes: ['bookmark'],
    })
    ledger = seedCompletionEntry(ledger, {
      tweetId,
      expected: ['request-a', 'request-b'],
      starting: ['request-b'],
      manualScopes: [],
      automaticScopes: ['bookmark'],
      crossListAutomaticScopes: [],
      at: 11,
    })
    ledger = seedCompletionEntry(ledger, {
      tweetId,
      expected: ['request-a', 'request-b', 'request-c'],
      starting: ['request-c'],
      manualScopes: [],
      automaticScopes: ['bookmark'],
      crossListAutomaticScopes: ['bookmark'],
      at: 12,
    })
    const entry = ledger.entries.get(tweetId)!
    expect(entry.crossListAutomaticScopes.has('bookmark')).toBe(false)
    expect(clearScopeIntent(entry, 'bookmark')).toBe('automatic')

    let ordinaryFirst = seedDurable({
      expected: ['request-a'],
      automaticScopes: ['bookmark'],
      crossListAutomaticScopes: [],
    })
    ordinaryFirst = seedCompletionEntry(ordinaryFirst, {
      tweetId,
      expected: ['request-a', 'request-b'],
      starting: ['request-b'],
      manualScopes: [],
      automaticScopes: ['bookmark'],
      crossListAutomaticScopes: ['bookmark'],
      at: 11,
    })
    expect(ordinaryFirst.entries.get(tweetId)?.crossListAutomaticScopes.has('bookmark')).toBe(false)
  })

  it('seed only widens and preserves intent precedence', () => {
    let ledger = seedDurable({ expected: ['a'], automaticScopes: ['bookmark'], at: 10 })
    ledger = seedCompletionEntry(ledger, {
      tweetId,
      expected: ['a', 'b'],
      starting: ['b'],
      automaticScopes: ['like'],
      manualScopes: [],
      at: 20,
    })
    const entry = ledger.entries.get(tweetId)!
    expect([...entry.expected].toSorted()).toEqual(['a', 'b'])
    expect([...entryScopesForTest(entry)].toSorted()).toEqual(['bookmark', 'like'])
    const explicit = seedCompletionEntry(ledger, {
      tweetId,
      expected: ['a'],
      starting: [],
      manualScopes: ['bookmark'],
      automaticScopes: [],
      at: 21,
    }).entries.get(tweetId)!
    expect(clearScopeIntent(explicit, 'bookmark')).toBe('manual')
    const mixed = seedDurable({
      manualScopes: ['bookmark'],
      automaticScopes: ['bookmark', 'like', 'notInterested'],
      crossListAutomaticScopes: ['like'],
    }).entries.get(tweetId)!
    expect(clearScopeIntent(mixed, 'bookmark')).toBe('manual')
    expect(clearScopeIntent(mixed, 'like')).toBe('cross-list-automatic')
    expect(clearScopeIntent(mixed, 'notInterested')).toBe('automatic')
  })

  it('retention removes only expired automatic download failures', () => {
    const failed = failUnboundCompletion(seedDurable({ at: 10 }), {
      tweetId,
      requestId: 'request-a',
      at: 11,
    })
    expect(pruneExpiredAutomaticFailures(failed, 10)).toBe(failed)
    expect(pruneExpiredAutomaticFailures(failed, 11).entries.has(tweetId)).toBe(false)

    const manualFailed = failUnboundCompletion(
      seedDurable({ at: 10, manualScopes: ['bookmark'], automaticScopes: [] }),
      { tweetId, requestId: 'request-a', at: 11 },
    )
    expect(pruneExpiredAutomaticFailures(manualFailed, 11)).toBe(manualFailed)

    const active = seedDurable({ at: 10 })
    expect(pruneExpiredAutomaticFailures(active, 100)).toBe(active)

    const ready = complete()
    expect(pruneExpiredAutomaticFailures(ready, 2000)).toBe(ready)

    const tombstones = new Map([
      [
        tweetId,
        new Map([
          [
            'like' as const,
            { tweetId, scope: 'like' as const, state: 'uncertain' as const, at: 1 },
          ],
        ]),
      ],
    ])
    const withProof = { ...failed, tombstones }
    expect(pruneExpiredAutomaticFailures(withProof, 11).tombstones).toBe(tombstones)
  })

  it('still tracks a new batch when its only new scope is tombstoned', () => {
    let ledger = seedDurable({ expected: ['a'], automaticScopes: ['bookmark'] })
    ledger = {
      ...ledger,
      tombstones: new Map([
        [
          tweetId,
          new Map([
            ['like', { tweetId, scope: 'like' as const, state: 'cleared' as const, at: 11 }],
          ]),
        ],
      ]),
    }
    ledger = seedCompletionEntry(ledger, {
      tweetId,
      expected: ['b'],
      starting: ['b'],
      manualScopes: [],
      automaticScopes: ['like'],
      at: 12,
    })
    expect([...ledger.entries.get(tweetId)!.expected].toSorted()).toEqual(['a', 'b'])
  })

  it('does nothing when every scope of a new entry is tombstoned', () => {
    const ledger = {
      ...emptyCompletionLedger(),
      tombstones: new Map<string, ReadonlyMap<Scope, ClearTombstone>>([
        [
          tweetId,
          new Map<Scope, ClearTombstone>([
            [
              'bookmark',
              { tweetId, scope: 'bookmark' as const, state: 'cleared' as const, at: 10 },
            ],
          ]),
        ],
      ]),
    }
    expect(
      seedCompletionEntry(ledger, {
        tweetId,
        expected: ['request-a'],
        starting: ['request-a'],
        manualScopes: [],
        automaticScopes: ['bookmark'],
        at: 11,
      }),
    ).toBe(ledger)
  })
})

const entryScopesForTest = (entry: {
  manualScopes: ReadonlySet<Scope>
  automaticScopes: ReadonlySet<Scope>
}): Set<Scope> => new Set([...entry.manualScopes, ...entry.automaticScopes])
