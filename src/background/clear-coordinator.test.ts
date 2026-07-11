import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeBrowser } from 'wxt/testing'
import { Schema } from 'effect'
import {
  makeClearCoordinator,
  type ClearCoordinatorDeps,
  type SettleClock,
} from './clear-coordinator'
import { Settings as SettingsSchema, type Settings } from '../core/schema'

// ── Settle Port seam ──
//
// The pure verdict (`decideSettle`) is exhaustively covered in
// core/clear/settle.test.ts; here we prove the one invariant that makes the port
// worth its keep: the irreversible Clear (sendClearToTabs) fires ONLY when the
// Settle Port confirms the byte landed, and NEVER when it can't. The fake probe is
// the second adapter that earns the seam.

const baseSettings = Schema.decodeUnknownSync(SettingsSchema)({})
const settings = (over: Partial<Settings>): Settings => ({ ...baseSettings, ...over })

// Clear-on-save, un-bookmark enabled — so a Truly Complete tweet is eligible to clear.
const CLEAR_ON: Settings = settings({ clearOnSave: true, autoUnbookmarkOnSave: true })

const mountedFlip = { mounted: true, results: [{ scope: 'bookmark' as const, ok: true }] }

const probeFn = (impl: ClearCoordinatorDeps['settleProbe']) =>
  vi.fn<ClearCoordinatorDeps['settleProbe']>(impl)

/** Hand-rolled fake clock (the retry-plan.ts idiom) — NOT vi.useFakeTimers().
 *  Records every (fn, ms) schedule call; the test fires callbacks explicitly and
 *  waits (via vi.waitFor's real-timer polling) for the resulting async settle
 *  chain to drain, rather than fast-forwarding a fake clock. */
const makeFakeClock = (): SettleClock & {
  readonly calls: { fn: () => void; ms: number }[]
} => {
  const calls: { fn: () => void; ms: number }[] = []
  const schedule: SettleClock['schedule'] = (fn, ms) => {
    calls.push({ fn, ms })
  }
  return { schedule, calls }
}

const makeDeps = (over: Partial<ClearCoordinatorDeps> = {}) => {
  const sendClearToTabs = vi.fn<ClearCoordinatorDeps['sendClearToTabs']>(async () => mountedFlip)
  const settleProbe = over.settleProbe ?? probeFn(async () => ({ state: 'complete', exists: true }))
  const clock = makeFakeClock()
  const deps: ClearCoordinatorDeps = {
    queueError: () => () => {},
    getSettings: async () => CLEAR_ON,
    trace: () => {},
    sendClearToTabs,
    clock,
    ...over,
    settleProbe,
  }
  return { deps, sendClearToTabs, settleProbe, clock }
}

/** Fire every settle-window callback the fake clock captured, then wait for every
 *  probe to have run — vi.waitFor's real-timer polling forces the queued settle
 *  chain (probe → reduce → maybe-clear) to fully drain before the caller asserts. */
const fireSettleWindow = async (
  clock: ReturnType<typeof makeFakeClock>,
  settleProbe: ClearCoordinatorDeps['settleProbe'],
): Promise<void> => {
  const n = clock.calls.length
  clock.calls.forEach(({ fn }) => fn())
  await vi.waitFor(() => expect(settleProbe).toHaveBeenCalledTimes(n))
}

/** Seed a tweet's media as one batch, then record each complete with its OWN
 *  download id — so the Settle Port can land some ids and late-interrupt others. */
const seedAndComplete = (
  c: ReturnType<typeof makeClearCoordinator>,
  media: ReadonlyArray<{ id: string; downloadId: number }>,
): void => {
  c.seedClearLedger(new Map([['T', media.map((m) => m.id)]]), ['bookmark'], 'hook')
  for (const m of media) c.recordClearComplete('T', m.id, m.downloadId)
}

/** Seed one tweet, record its only media complete, then settle. */
const downloadAndSettle = async (
  c: ReturnType<typeof makeClearCoordinator>,
  clock: ReturnType<typeof makeFakeClock>,
  settleProbe: ClearCoordinatorDeps['settleProbe'],
): Promise<void> => {
  seedAndComplete(c, [{ id: 'm0', downloadId: 123 }])
  await fireSettleWindow(clock, settleProbe)
}

describe('Settle Port gate (irreversible Clear)', () => {
  beforeEach(() => {
    fakeBrowser.reset()
  })

  it('fires the Clear once the probe confirms the byte landed', async () => {
    const { deps, sendClearToTabs, settleProbe, clock } = makeDeps()
    await downloadAndSettle(makeClearCoordinator(deps), clock, settleProbe)
    expect(sendClearToTabs).toHaveBeenCalledTimes(1)
    // allLists defaults false → page-scoped clear (current page's list only).
    expect(sendClearToTabs).toHaveBeenCalledWith('T', ['bookmark'], false)
  })

  it('passes allLists=true when "Clear from every list" is on', async () => {
    const { deps, sendClearToTabs, settleProbe, clock } = makeDeps({
      getSettings: async () =>
        settings({ clearOnSave: true, autoUnbookmarkOnSave: true, clearAllListsOnSave: true }),
    })
    await downloadAndSettle(makeClearCoordinator(deps), clock, settleProbe)
    expect(sendClearToTabs).toHaveBeenCalledWith('T', ['bookmark'], true)
  })

  it('probes the exact download id recorded for the tweet', async () => {
    const { deps, settleProbe, clock } = makeDeps()
    await downloadAndSettle(makeClearCoordinator(deps), clock, settleProbe)
    expect(settleProbe).toHaveBeenCalledWith(123)
  })

  // The negatives assert the settle path DID run (settleProbe called) AND the gate
  // withheld the Clear — so a future wiring regression (no probe / no timer) goes
  // red here too, not just a vacuous not.toHaveBeenCalled() on a path that never ran.
  it('NEVER fires the Clear when the probe is missing (search threw / no row)', async () => {
    const { deps, sendClearToTabs, settleProbe, clock } = makeDeps({
      settleProbe: probeFn(async () => undefined),
    })
    await downloadAndSettle(makeClearCoordinator(deps), clock, settleProbe)
    expect(settleProbe).toHaveBeenCalledWith(123)
    expect(sendClearToTabs).not.toHaveBeenCalled()
  })

  it('NEVER fires the Clear when the file vanished after completing (exists:false)', async () => {
    const { deps, sendClearToTabs, settleProbe, clock } = makeDeps({
      settleProbe: probeFn(async () => ({ state: 'complete', exists: false })),
    })
    await downloadAndSettle(makeClearCoordinator(deps), clock, settleProbe)
    expect(settleProbe).toHaveBeenCalledWith(123)
    expect(sendClearToTabs).not.toHaveBeenCalled()
  })

  it('NEVER fires the Clear on a late post-complete interrupt', async () => {
    const { deps, sendClearToTabs, settleProbe, clock } = makeDeps({
      settleProbe: probeFn(async () => ({ state: 'interrupted' })),
    })
    await downloadAndSettle(makeClearCoordinator(deps), clock, settleProbe)
    expect(settleProbe).toHaveBeenCalledWith(123)
    expect(sendClearToTabs).not.toHaveBeenCalled()
  })

  it('clears a multi-media tweet only once EVERY media verifiably lands', async () => {
    const { deps, sendClearToTabs, settleProbe, clock } = makeDeps({
      settleProbe: probeFn(async () => ({ state: 'complete', exists: true })),
    })
    const c = makeClearCoordinator(deps)
    seedAndComplete(c, [
      { id: 'm0', downloadId: 10 },
      { id: 'm1', downloadId: 20 },
    ])
    await fireSettleWindow(clock, settleProbe)
    expect(sendClearToTabs).toHaveBeenCalledTimes(1)
    expect(sendClearToTabs).toHaveBeenCalledWith('T', ['bookmark'], false)
  })

  it('one media late-interrupting VETOES the whole-tweet clear (the load-bearing gate)', async () => {
    // m0 lands, m1 late-interrupts. The tweet is no longer Truly Complete (a failure
    // remains), so the irreversible un-bookmark MUST NOT fire — one un-landed byte
    // vetoes clearing the entire tweet. A gate that cleared on ANY landed probe
    // (instead of requiring every media to settle) would wrongly fire here.
    const settleProbe = probeFn(async (downloadId) =>
      downloadId === 10 ? { state: 'complete', exists: true } : { state: 'interrupted' },
    )
    const { deps, sendClearToTabs, clock } = makeDeps({ settleProbe })
    const c = makeClearCoordinator(deps)
    seedAndComplete(c, [
      { id: 'm0', downloadId: 10 },
      { id: 'm1', downloadId: 20 },
    ])
    await fireSettleWindow(clock, settleProbe)
    expect(settleProbe).toHaveBeenCalledTimes(2)
    expect(sendClearToTabs).not.toHaveBeenCalled()
  })

  it('supports multiple scopes for sweep when clearAllListsOnSave is true', async () => {
    const { deps, sendClearToTabs, settleProbe, clock } = makeDeps({
      getSettings: async () =>
        settings({
          clearOnSave: true,
          autoUnbookmarkOnSave: true,
          autoUnlikeOnSave: true,
          clearAllListsOnSave: true,
        }),
    })
    const c = makeClearCoordinator(deps)
    c.seedClearLedger(new Map([['T', ['m0']]]), ['bookmark', 'like'], 'sweep')
    c.recordClearComplete('T', 'm0', 123)
    await fireSettleWindow(clock, settleProbe)
    expect(sendClearToTabs).toHaveBeenCalledWith('T', ['bookmark', 'like'], true)
  })

  it('keeps single scope for sweep when clearAllListsOnSave is false', async () => {
    const { deps, sendClearToTabs, settleProbe, clock } = makeDeps({
      getSettings: async () =>
        settings({
          clearOnSave: true,
          autoUnbookmarkOnSave: true,
          autoUnlikeOnSave: true,
          clearAllListsOnSave: false,
        }),
    })
    const c = makeClearCoordinator(deps)
    c.seedClearLedger(new Map([['T', ['m0']]]), ['bookmark'], 'sweep')
    c.recordClearComplete('T', 'm0', 123)
    await fireSettleWindow(clock, settleProbe)
    expect(sendClearToTabs).toHaveBeenCalledWith('T', ['bookmark'], false)
  })

  // Mirrors retry-plan.test.ts's 'default real clock' block: proves the
  // `deps.clock ?? realSettleClock` fallback actually schedules via the real
  // `setTimeout`, for the one call site (background.ts) that never injects a clock.
  describe('default real clock', () => {
    it('makeClearCoordinator without an explicit clock settles the window via real timers', async () => {
      vi.useFakeTimers()
      try {
        const sendClearToTabs = vi.fn<ClearCoordinatorDeps['sendClearToTabs']>(
          async () => mountedFlip,
        )
        const settleProbe = probeFn(async () => ({ state: 'complete', exists: true }))
        const deps: ClearCoordinatorDeps = {
          queueError: () => () => {},
          getSettings: async () => CLEAR_ON,
          trace: () => {},
          sendClearToTabs,
          settleProbe,
        }
        const c = makeClearCoordinator(deps)
        c.seedClearLedger(new Map([['T', ['m0']]]), ['bookmark'], 'hook')
        c.recordClearComplete('T', 'm0', 123)

        await vi.advanceTimersByTimeAsync(1500) // SETTLE_CONFIRM_MS

        expect(settleProbe).toHaveBeenCalledWith(123)
        expect(sendClearToTabs).toHaveBeenCalledWith('T', ['bookmark'], false)
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
