import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeBrowser } from 'wxt/testing/fake-browser'
import { Schema } from 'effect'
import { makeClearSession, type ClearSessionDeps, type SettleClock } from './clear-session'
import { Settings as SettingsSchema, type Settings, type JsonValue } from '@/packages/schema'
import { decodeWorklist, isCleared } from '@/packages/clear/worklist'

// ── Settle Port seam ──
//
// The pure verdict (`decideSettle`) is exhaustively covered in
// core/clear/settle.test.ts; here we prove the one invariant that makes the port
// worth its keep: the irreversible Clear (dispatchClear) fires ONLY when the
// Settle Port confirms the byte landed, and NEVER when it can't. The fake probe is
// the second adapter that earns the seam.

const baseSettings = Schema.decodeUnknownSync(SettingsSchema)({})
const settings = (over: Partial<Settings>): Settings => ({ ...baseSettings, ...over })

// Clear-on-save, un-bookmark enabled — so a Truly Complete tweet is eligible to clear.
const CLEAR_ON: Settings = settings({ clearOnSave: true, autoUnbookmarkOnSave: true })

const mountedFlip = [{ scope: 'bookmark' as const, ok: true }]

const probeFn = (impl: ClearSessionDeps['settleProbe']) =>
  vi.fn<ClearSessionDeps['settleProbe']>(impl)

/** Hand-rolled fake clock (the retry-plan.ts idiom) — NOT vi.useFakeTimers().
 *  Records every (fn, ms) schedule call; the test fires callbacks explicitly and
 *  waits (via vi.waitFor's real-timer polling) for the resulting async settle
 *  chain to drain, rather than fast-forwarding a fake clock. */
const makeFakeClock = (): SettleClock & {
  readonly calls: { fn: () => void; ms: number; cancel: ReturnType<typeof vi.fn> }[]
} => {
  const calls: { fn: () => void; ms: number; cancel: ReturnType<typeof vi.fn> }[] = []
  const schedule: SettleClock['schedule'] = (fn, ms) => {
    let active = true
    const cancel = vi.fn<() => void>(() => {
      active = false
    })
    calls.push({
      fn: () => {
        if (!active) return
        active = false
        fn()
      },
      ms,
      cancel,
    })
    return cancel
  }
  return { schedule, calls }
}

/** No list scope could be pinned when the entry was seeded — the fail-CLOSED pin every
 *  seed without an origin page ends up with, and what the permalink leg is handed. */
const NO_PIN = { source: 'none' } as const

const makeDeps = (over: Partial<ClearSessionDeps> = {}) => {
  const dispatchClear = vi.fn<ClearSessionDeps['dispatchClear']>(async () => mountedFlip)
  const settleProbe = over.settleProbe ?? probeFn(async () => ({ state: 'complete', exists: true }))
  const resolveOriginScope =
    over.resolveOriginScope ?? vi.fn<ClearSessionDeps['resolveOriginScope']>(async () => undefined)
  const clock = makeFakeClock()
  const deps: ClearSessionDeps = {
    queueError: () => () => {},
    getSettings: async () => CLEAR_ON,
    trace: () => {},
    dispatchClear,
    clock,
    ...over,
    settleProbe,
    resolveOriginScope,
  }
  return { deps, dispatchClear, settleProbe, resolveOriginScope, clock }
}

/** Fire every settle-window callback the fake clock captured, then wait for every
 *  probe to have run — vi.waitFor's real-timer polling forces the queued settle
 *  chain (probe → reduce → maybe-clear) to fully drain before the caller asserts. */
const fireSettleWindow = async (
  clock: ReturnType<typeof makeFakeClock>,
  settleProbe: ClearSessionDeps['settleProbe'],
): Promise<void> => {
  const n = clock.calls.length
  clock.calls.forEach(({ fn }) => fn())
  await vi.waitFor(() => expect(settleProbe).toHaveBeenCalledTimes(n))
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

/** Seed a tweet's media as one batch, then record each complete with its OWN
 *  download id — so the Settle Port can land some ids and late-interrupt others. */
const seedAndComplete = async (
  c: ReturnType<typeof makeClearSession>,
  media: ReadonlyArray<{ id: string; downloadId: number }>,
): Promise<void> => {
  await c.seedLedger({
    decision: 'seed',
    byTweet: new Map([['T', media.map((m) => m.id)]]),
    scopes: ['bookmark'],
    origin: 'hook',
    unclearableCount: 0,
  })
  for (const m of media) c.recordComplete('T', m.id, m.downloadId)
}

/** Seed one tweet, record its only media complete, then settle. */
const downloadAndSettle = async (
  c: ReturnType<typeof makeClearSession>,
  clock: ReturnType<typeof makeFakeClock>,
  settleProbe: ClearSessionDeps['settleProbe'],
): Promise<void> => {
  await seedAndComplete(c, [{ id: 'm0', downloadId: 123 }])
  await fireSettleWindow(clock, settleProbe)
}

describe('Settle Port gate (irreversible Clear)', () => {
  beforeEach(() => {
    fakeBrowser.reset()
  })

  it('fires the Clear once the probe confirms the byte landed', async () => {
    const { deps, dispatchClear, settleProbe, clock } = makeDeps()
    await downloadAndSettle(makeClearSession(deps), clock, settleProbe)
    expect(dispatchClear).toHaveBeenCalledTimes(1)
    // allLists defaults false → page-scoped clear (current page's list only).
    expect(dispatchClear).toHaveBeenCalledWith('T', ['bookmark'], false, undefined, NO_PIN)
  })

  it('passes allLists=true when "Clear from every list" is on', async () => {
    const { deps, dispatchClear, settleProbe, clock } = makeDeps({
      getSettings: async () =>
        settings({ clearOnSave: true, autoUnbookmarkOnSave: true, clearAllListsOnSave: true }),
    })
    await downloadAndSettle(makeClearSession(deps), clock, settleProbe)
    expect(dispatchClear).toHaveBeenCalledWith('T', ['bookmark'], true, undefined, NO_PIN)
  })

  it('keeps the origin tab inside the session', async () => {
    const { deps, dispatchClear, settleProbe, clock, resolveOriginScope } = makeDeps()
    const c = makeClearSession(deps)
    await c.seedLedger({
      decision: 'seed',
      byTweet: new Map([['T', ['m0']]]),
      scopes: ['bookmark'],
      origin: 'hook',
      unclearableCount: 0,
      originTabId: 9,
    })
    c.recordComplete('T', 'm0', 123)
    await fireSettleWindow(clock, settleProbe)
    // The origin tab was asked for its list scope ONCE, at seed time; it isn't a list
    // page (undefined), so the release leg is handed the fail-closed pin.
    expect(resolveOriginScope).toHaveBeenCalledExactlyOnceWith(9)
    expect(dispatchClear).toHaveBeenCalledWith('T', ['bookmark'], false, 9, NO_PIN)
  })

  it('reset cancels stale settle timers', async () => {
    const { deps, dispatchClear, settleProbe, clock } = makeDeps()
    const c = makeClearSession(deps)
    await c.seedLedger({
      decision: 'seed',
      byTweet: new Map([['T', ['m0']]]),
      scopes: ['bookmark'],
      origin: 'hook',
      unclearableCount: 0,
    })
    c.recordComplete('T', 'm0', 123)
    expect(clock.calls).toHaveLength(1)

    await c.reset()
    expect(clock.calls[0]?.cancel).toHaveBeenCalledOnce()
    clock.calls[0]?.fn()
    await Promise.resolve()

    expect(settleProbe).not.toHaveBeenCalled()
    expect(dispatchClear).not.toHaveBeenCalled()
  })

  it('a fresh worker session cannot clear an old unseeded completion', async () => {
    const { deps, dispatchClear, settleProbe, clock } = makeDeps()
    const fresh = makeClearSession(deps)
    fresh.recordComplete('T', 'm0', 123)
    clock.calls[0]?.fn()
    await Promise.resolve()
    expect(settleProbe).toHaveBeenCalledWith(123)
    expect(dispatchClear).not.toHaveBeenCalled()
  })

  it('traces a seeded Release media failure with ledger counts before pruning', async () => {
    const trace = vi.fn<ClearSessionDeps['trace']>()
    const { deps } = makeDeps({ trace })
    const c = makeClearSession(deps)

    c.recordFailure(undefined, 'unrelated')
    c.recordFailure('unseeded', 'm0')
    await Promise.resolve()
    expect(trace).not.toHaveBeenCalled()

    await c.seedLedger({
      decision: 'seed',
      byTweet: new Map([['T', ['m0']]]),
      scopes: ['bookmark'],
      origin: 'sweep',
      unclearableCount: 0,
    })
    trace.mockClear()

    c.recordFailure('T', 'm0')
    await vi.waitFor(() =>
      expect(trace).toHaveBeenCalledWith('clear-download-failed', {
        tweetId: 'T',
        itemId: 'm0',
        detail: 'origin=sweep scopes=bookmark outcome=failed expected=1 done=0 inFlight=0 failed=1',
      }),
    )

    trace.mockClear()
    c.recordFailure('T', 'm0')
    await Promise.resolve()
    expect(trace).not.toHaveBeenCalled()
  })

  it('a dispatch rejection releases the claim for a later retry', async () => {
    let attempt = 0
    const dispatchClear = vi.fn<ClearSessionDeps['dispatchClear']>(async () => {
      attempt += 1
      if (attempt === 1) throw new Error('tabs query failed')
      return mountedFlip
    })
    const { deps, settleProbe, clock } = makeDeps({ dispatchClear })
    const c = makeClearSession(deps)
    await c.seedLedger({
      decision: 'seed',
      byTweet: new Map([['T', ['m0']]]),
      scopes: ['bookmark'],
      origin: 'hook',
      unclearableCount: 0,
    })

    c.recordComplete('T', 'm0', 123)
    await fireSettleWindow(clock, settleProbe)
    await vi.waitFor(() => expect(dispatchClear).toHaveBeenCalledTimes(1))

    c.recordComplete('T', 'm0', 123)
    await fireSettleWindow(clock, settleProbe)
    await vi.waitFor(() => expect(dispatchClear).toHaveBeenCalledTimes(2))
  })

  it('one slow Drain does not block another tweet settling', async () => {
    let releaseFirst!: (value: typeof mountedFlip) => void
    const first = new Promise<typeof mountedFlip>((resolve) => {
      releaseFirst = resolve
    })
    const dispatchClear = vi.fn<ClearSessionDeps['dispatchClear']>(async (tweetId) =>
      tweetId === 'T1' ? first : mountedFlip,
    )
    const { deps, settleProbe, clock } = makeDeps({ dispatchClear })
    const c = makeClearSession(deps)
    await c.seedLedger({
      decision: 'seed',
      byTweet: new Map([
        ['T1', ['m1']],
        ['T2', ['m2']],
      ]),
      scopes: ['bookmark'],
      origin: 'hook',
      unclearableCount: 0,
    })
    c.recordComplete('T1', 'm1', 1)
    c.recordComplete('T2', 'm2', 2)
    await fireSettleWindow(clock, settleProbe)

    await vi.waitFor(() =>
      expect(dispatchClear.mock.calls.map(([tweetId]) => tweetId)).toEqual(
        expect.arrayContaining(['T1', 'T2']),
      ),
    )
    releaseFirst(mountedFlip)
  })

  it('probes the exact download id recorded for the tweet', async () => {
    const { deps, settleProbe, clock } = makeDeps()
    await downloadAndSettle(makeClearSession(deps), clock, settleProbe)
    expect(settleProbe).toHaveBeenCalledWith(123)
  })

  // The negatives assert the settle path DID run (settleProbe called) AND the gate
  // withheld the Clear — so a future wiring regression (no probe / no timer) goes
  // red here too, not just a vacuous not.toHaveBeenCalled() on a path that never ran.
  it('NEVER fires the Clear when the probe is missing (search threw / no row)', async () => {
    const { deps, dispatchClear, settleProbe, clock } = makeDeps({
      settleProbe: probeFn(async () => undefined),
    })
    await downloadAndSettle(makeClearSession(deps), clock, settleProbe)
    expect(settleProbe).toHaveBeenCalledWith(123)
    expect(dispatchClear).not.toHaveBeenCalled()
  })

  it('NEVER fires the Clear when the file vanished after completing (exists:false)', async () => {
    const { deps, dispatchClear, settleProbe, clock } = makeDeps({
      settleProbe: probeFn(async () => ({ state: 'complete', exists: false })),
    })
    await downloadAndSettle(makeClearSession(deps), clock, settleProbe)
    expect(settleProbe).toHaveBeenCalledWith(123)
    expect(dispatchClear).not.toHaveBeenCalled()
  })

  it('NEVER fires the Clear on a late post-complete interrupt', async () => {
    const { deps, dispatchClear, settleProbe, clock } = makeDeps({
      settleProbe: probeFn(async () => ({ state: 'interrupted' })),
    })
    await downloadAndSettle(makeClearSession(deps), clock, settleProbe)
    expect(settleProbe).toHaveBeenCalledWith(123)
    expect(dispatchClear).not.toHaveBeenCalled()
  })

  it('clears a multi-media tweet only once EVERY media verifiably lands', async () => {
    const { deps, dispatchClear, settleProbe, clock } = makeDeps({
      settleProbe: probeFn(async () => ({ state: 'complete', exists: true })),
    })
    const c = makeClearSession(deps)
    await seedAndComplete(c, [
      { id: 'm0', downloadId: 10 },
      { id: 'm1', downloadId: 20 },
    ])
    await fireSettleWindow(clock, settleProbe)
    expect(dispatchClear).toHaveBeenCalledTimes(1)
    expect(dispatchClear).toHaveBeenCalledWith('T', ['bookmark'], false, undefined, NO_PIN)
  })

  it('one media late-interrupting VETOES the whole-tweet clear (the load-bearing gate)', async () => {
    // m0 lands, m1 late-interrupts. The tweet is no longer Truly Complete (a failure
    // remains), so the irreversible un-bookmark MUST NOT fire — one un-landed byte
    // vetoes clearing the entire tweet. A gate that cleared on ANY landed probe
    // (instead of requiring every media to settle) would wrongly fire here.
    const settleProbe = probeFn(async (downloadId) =>
      downloadId === 10 ? { state: 'complete', exists: true } : { state: 'interrupted' },
    )
    const { deps, dispatchClear, clock } = makeDeps({ settleProbe })
    const c = makeClearSession(deps)
    await seedAndComplete(c, [
      { id: 'm0', downloadId: 10 },
      { id: 'm1', downloadId: 20 },
    ])
    await fireSettleWindow(clock, settleProbe)
    expect(settleProbe).toHaveBeenCalledTimes(2)
    expect(dispatchClear).not.toHaveBeenCalled()
  })

  it('supports multiple scopes for sweep when clearAllListsOnSave is true', async () => {
    const { deps, dispatchClear, settleProbe, clock } = makeDeps({
      getSettings: async () =>
        settings({
          clearOnSave: true,
          autoUnbookmarkOnSave: true,
          autoUnlikeOnSave: true,
          clearAllListsOnSave: true,
        }),
    })
    const c = makeClearSession(deps)
    await c.seedLedger({
      decision: 'seed',
      byTweet: new Map([['T', ['m0']]]),
      scopes: ['bookmark', 'like'],
      origin: 'sweep',
      unclearableCount: 0,
    })
    c.recordComplete('T', 'm0', 123)
    await fireSettleWindow(clock, settleProbe)
    expect(dispatchClear).toHaveBeenCalledWith('T', ['bookmark', 'like'], true, undefined, NO_PIN)
  })

  it('keeps single scope for sweep when clearAllListsOnSave is false', async () => {
    const { deps, dispatchClear, settleProbe, clock } = makeDeps({
      getSettings: async () =>
        settings({
          clearOnSave: true,
          autoUnbookmarkOnSave: true,
          autoUnlikeOnSave: true,
          clearAllListsOnSave: false,
        }),
    })
    const c = makeClearSession(deps)
    await c.seedLedger({
      decision: 'seed',
      byTweet: new Map([['T', ['m0']]]),
      scopes: ['bookmark'],
      origin: 'sweep',
      unclearableCount: 0,
    })
    c.recordComplete('T', 'm0', 123)
    await fireSettleWindow(clock, settleProbe)
    expect(dispatchClear).toHaveBeenCalledWith('T', ['bookmark'], false, undefined, NO_PIN)
  })

  it('resolves an authorized Drain result through the claim and worklist', async () => {
    let stored: JsonValue = null
    const { deps, settleProbe, clock } = makeDeps({
      worklistStorage: {
        get: async () => stored,
        set: async (value) => {
          stored = value
        },
      },
    })
    const c = makeClearSession(deps)
    await c.enqueueSweep('bookmark', [{ tweetId: 'T', items: ['m0'] }])
    await c.seedLedger({
      decision: 'seed',
      byTweet: new Map([['T', ['m0']]]),
      scopes: ['bookmark'],
      origin: 'sweep',
      unclearableCount: 0,
    })
    c.recordComplete('T', 'm0', 123)
    await fireSettleWindow(clock, settleProbe)

    await vi.waitFor(() => expect(isCleared(decodeWorklist(stored), 'T', 'bookmark')).toBe(true))
  })

  it('a noop Drain result never marks the worklist cleared', async () => {
    let stored: JsonValue = null
    const { deps, settleProbe, clock } = makeDeps({
      dispatchClear: vi.fn<ClearSessionDeps['dispatchClear']>(async () => [
        { scope: 'bookmark' as const, ok: true, noop: true },
      ]),
      worklistStorage: {
        get: async () => stored,
        set: async (value) => {
          stored = value
        },
      },
    })
    const c = makeClearSession(deps)
    await c.enqueueSweep('bookmark', [{ tweetId: 'T', items: ['m0'] }])
    await c.seedLedger({
      decision: 'seed',
      byTweet: new Map([['T', ['m0']]]),
      scopes: ['bookmark'],
      origin: 'sweep',
      unclearableCount: 0,
    })
    c.recordComplete('T', 'm0', 123)
    await fireSettleWindow(clock, settleProbe)
    await Promise.resolve()

    expect(isCleared(decodeWorklist(stored), 'T', 'bookmark')).toBe(false)
  })

  // Mirrors retry-plan.test.ts's 'default real clock' block: proves the
  // `deps.clock ?? realSettleClock` fallback actually schedules via the real
  // `setTimeout`, for the one call site (background.ts) that never injects a clock.
  describe('default real clock', () => {
    it('makeClearSession without an explicit clock settles the window via real timers', async () => {
      vi.useFakeTimers()
      try {
        const dispatchClear = vi.fn<ClearSessionDeps['dispatchClear']>(async () => mountedFlip)
        const settleProbe = probeFn(async () => ({ state: 'complete', exists: true }))
        const deps: ClearSessionDeps = {
          queueError: () => () => {},
          getSettings: async () => CLEAR_ON,
          trace: () => {},
          dispatchClear,
          resolveOriginScope: async () => undefined,
          settleProbe,
        }
        const c = makeClearSession(deps)
        await c.seedLedger({
          decision: 'seed',
          byTweet: new Map([['T', ['m0']]]),
          scopes: ['bookmark'],
          origin: 'hook',
          unclearableCount: 0,
        })
        c.recordComplete('T', 'm0', 123)

        await vi.advanceTimersByTimeAsync(1500) // SETTLE_CONFIRM_MS

        expect(settleProbe).toHaveBeenCalledWith(123)
        expect(dispatchClear).toHaveBeenCalledWith('T', ['bookmark'], false, undefined, NO_PIN)
      } finally {
        vi.useRealTimers()
      }
    })
  })
})

/** Details of every trace line for `stage`, in order. */
const linesFor = (
  trace: ReturnType<typeof vi.fn<ClearSessionDeps['trace']>>,
  stage: string,
): string[] => trace.mock.calls.filter((c) => c[0] === stage).map((c) => c[1]?.detail ?? '')

const traceSpy = () => vi.fn<ClearSessionDeps['trace']>()

// ── Release scope pin (seed time) ──
//
// The permalink release leg owns no list scope of its own, so whatever page scope it
// is handed is the ONLY thing that can authorize an irreversible un-bookmark/un-like
// there. That scope is fixed HERE, when the ledger entry is seeded — reading it back
// off the origin tab once the download settles let an ordinary "now do the other list"
// navigation re-aim the clear at a list the user never pressed Release for.
describe('release scope pin', () => {
  beforeEach(() => {
    fakeBrowser.reset()
  })

  it('pins the origin tab’s list scope at SEED time and survives that tab navigating away', async () => {
    const resolveOriginScope = vi.fn<ClearSessionDeps['resolveOriginScope']>(
      async () => 'bookmark' as const,
    )
    const { deps, dispatchClear, settleProbe, clock } = makeDeps({ resolveOriginScope })
    const c = makeClearSession(deps)
    await c.seedLedger({
      decision: 'seed',
      byTweet: new Map([['T', ['m0']]]),
      scopes: ['bookmark'],
      origin: 'hook',
      unclearableCount: 0,
      originTabId: 4,
    })
    // The user moves that same tab from Bookmarks to Likes while the download runs —
    // the live answer is now 'like'. Nothing may ask again.
    resolveOriginScope.mockResolvedValue('like')

    c.recordComplete('T', 'm0', 123)
    await fireSettleWindow(clock, settleProbe)

    expect(resolveOriginScope).toHaveBeenCalledExactlyOnceWith(4)
    expect(dispatchClear).toHaveBeenCalledWith('T', ['bookmark'], false, 4, {
      source: 'seeded-origin',
      scope: 'bookmark',
    })
  })

  it('lets the sweep’s CONSENTED scope win, without reading the origin tab at all', async () => {
    const { deps, dispatchClear, settleProbe, clock, resolveOriginScope } = makeDeps()
    const c = makeClearSession(deps)
    await c.seedLedger({
      decision: 'seed',
      byTweet: new Map([['T', ['m0']]]),
      scopes: ['bookmark'],
      origin: 'sweep',
      unclearableCount: 0,
      originTabId: 4,
      consentedScope: 'bookmark',
    })
    c.recordComplete('T', 'm0', 123)
    await fireSettleWindow(clock, settleProbe)

    // The list the user literally pressed Release on beats any url derivation, so the
    // tab is never consulted — there is nothing a navigation could corrupt.
    expect(resolveOriginScope).not.toHaveBeenCalled()
    expect(dispatchClear).toHaveBeenCalledWith('T', ['bookmark'], false, 4, {
      source: 'consented',
      scope: 'bookmark',
    })
  })

  it('records the pin on the seed line, so a click-nothing release is explainable', async () => {
    const trace = traceSpy()
    const { deps } = makeDeps({
      trace,
      resolveOriginScope: async () => 'like' as const,
    })
    await makeClearSession(deps).seedLedger({
      decision: 'seed',
      byTweet: new Map([['T', ['m0']]]),
      scopes: ['like'],
      origin: 'hook',
      unclearableCount: 0,
      originTabId: 4,
    })
    expect(linesFor(trace, 'clear-seeded')).toEqual([
      'origin=hook scopes=like expected=1 release=seeded-origin:like',
    ])
  })

  it('fails CLOSED when the origin page owns no list scope', async () => {
    const trace = traceSpy()
    const { deps, dispatchClear, settleProbe, clock } = makeDeps({ trace })
    const c = makeClearSession(deps)
    await c.seedLedger({
      decision: 'seed',
      byTweet: new Map([['T', ['m0']]]),
      scopes: ['bookmark'],
      origin: 'hook',
      unclearableCount: 0,
      originTabId: 4, // a profile/timeline tab: resolveOriginScope answers undefined
    })
    c.recordComplete('T', 'm0', 123)
    await fireSettleWindow(clock, settleProbe)

    expect(linesFor(trace, 'clear-seeded')).toEqual([
      'origin=hook scopes=bookmark expected=1 release=none',
    ])
    expect(dispatchClear).toHaveBeenCalledWith('T', ['bookmark'], false, 4, NO_PIN)
  })
})

// ── Release diagnostics ──
//
// Every case here is a Release that STOPS after a `clear-settle truly=true` line. In
// production those all looked identical in the exported diagnostics log — a verified
// settle followed by silence — so "Release did nothing" could not be told apart from
// "Release was deliberately skipped". These pin the stage + reason that separates them.
describe('Release diagnostics', () => {
  beforeEach(() => {
    fakeBrowser.reset()
  })

  it('names clear-off when the toggle flips off between seed and settle', async () => {
    const trace = traceSpy()
    const { deps, dispatchClear, settleProbe, clock } = makeDeps({
      trace,
      getSettings: async () => settings({ clearOnSave: false, autoUnbookmarkOnSave: true }),
    })
    await downloadAndSettle(makeClearSession(deps), clock, settleProbe)

    expect(dispatchClear).not.toHaveBeenCalled()
    expect(linesFor(trace, 'clear-not-attempted')).toEqual(['reason=clear-off'])
  })

  it('names no-claimable-scopes, the latch states and that the entry was pruned', async () => {
    // Clear-on-save is ON, but "Un-bookmark on save" is OFF while the ledger entry is
    // scoped `bookmark` — so nothing is claimable and the Release silently ends. This is
    // the case that looks MOST like a broken un-bookmark, and `enabled=` is what shows
    // it isn't: the entry's scope simply isn't among the enabled ones.
    const trace = traceSpy()
    const { deps, dispatchClear, settleProbe, clock } = makeDeps({
      trace,
      getSettings: async () => settings({ clearOnSave: true, autoUnbookmarkOnSave: false }),
    })
    await downloadAndSettle(makeClearSession(deps), clock, settleProbe)

    expect(dispatchClear).not.toHaveBeenCalled()
    expect(linesFor(trace, 'clear-not-attempted')).toEqual([
      'reason=no-claimable-scopes pruned=true clear=bookmark:none enabled=like+notInterested',
    ])
  })

  it('reports the reset that threw away an in-flight release', async () => {
    const trace = traceSpy()
    const { deps } = makeDeps({ trace })
    const c = makeClearSession(deps)
    await c.seedLedger({
      decision: 'seed',
      byTweet: new Map([['T', ['m0']]]),
      scopes: ['bookmark'],
      origin: 'hook',
      unclearableCount: 0,
    })
    c.recordComplete('T', 'm0', 123) // arms a settle window, never fired
    await c.reset()

    // One armed settle and one ledger entry discarded — without this line the export
    // just stops here, which is also what a dead service worker looks like.
    expect(linesFor(trace, 'clear-reset')).toEqual(['generation=1 cancelledSettles=1 ledgerSize=1'])
  })

  it('returns the ids the worklist skipped, not just how many', async () => {
    let stored: JsonValue = null
    const { deps } = makeDeps({
      worklistStorage: {
        get: async () => stored,
        set: async (value) => {
          stored = value
        },
      },
    })
    const c = makeClearSession(deps)
    const posts = [
      { tweetId: 'A', items: ['m0'] },
      { tweetId: 'B', items: ['m1'] },
    ]
    const first = await c.enqueueSweep('bookmark', posts)
    expect(first.skippedIds).toEqual([])
    expect(first.queuedPosts).toHaveLength(2)

    // 'A' releases; 'B' does not. Both queues are serial, so this lands before the
    // re-run below reads the worklist.
    c.setSweepState('A', ['bookmark'], 'cleared')

    const second = await c.enqueueSweep('bookmark', posts)
    // The id is the whole point: cross-referenced against the mounted, still-bookmarked
    // posts, an id here proves an earlier Release latched 'cleared' without sticking.
    expect(second.skippedIds).toEqual(['A'])
    expect(second.skipped).toBe(1)
    expect(second.queuedPosts).toHaveLength(1)
  })

  it('keeps each list independent — a bookmark release never skips the likes sweep', async () => {
    let stored: JsonValue = null
    const { deps } = makeDeps({
      worklistStorage: {
        get: async () => stored,
        set: async (value) => {
          stored = value
        },
      },
    })
    const c = makeClearSession(deps)
    await c.enqueueSweep('bookmark', [{ tweetId: 'A', items: ['m0'] }])
    c.setSweepState('A', ['bookmark'], 'cleared')

    expect((await c.enqueueSweep('like', [{ tweetId: 'A', items: ['m0'] }])).skippedIds).toEqual([])
  })
})
