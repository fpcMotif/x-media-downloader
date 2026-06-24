import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fakeBrowser } from 'wxt/testing'
import { Schema } from 'effect'
import { hookScopes, makeClearCoordinator, type ClearCoordinatorDeps } from './clear-coordinator'
import { Settings as SettingsSchema, type Settings } from '../core/schema'

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

const makeDeps = (over: Partial<ClearCoordinatorDeps> = {}) => {
  const sendClearToTabs = vi.fn<ClearCoordinatorDeps['sendClearToTabs']>(async () => mountedFlip)
  const settleProbe = over.settleProbe ?? probeFn(async () => ({ state: 'complete', exists: true }))
  const deps: ClearCoordinatorDeps = {
    queueError: () => () => {},
    getSettings: async () => CLEAR_ON,
    trace: () => {},
    sendClearToTabs,
    ...over,
    settleProbe,
  }
  return { deps, sendClearToTabs, settleProbe }
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

/** Seed one tweet, record its only media complete, then run out the settle window. */
const downloadAndSettle = async (c: ReturnType<typeof makeClearCoordinator>): Promise<void> => {
  seedAndComplete(c, [{ id: 'm0', downloadId: 123 }])
  await vi.runAllTimersAsync()
}

describe('Settle Port gate (irreversible Clear)', () => {
  beforeEach(() => {
    fakeBrowser.reset()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires the Clear once the probe confirms the byte landed', async () => {
    const { deps, sendClearToTabs } = makeDeps()
    await downloadAndSettle(makeClearCoordinator(deps))
    expect(sendClearToTabs).toHaveBeenCalledTimes(1)
    // allLists defaults false → page-scoped clear (current page's list only).
    expect(sendClearToTabs).toHaveBeenCalledWith('T', ['bookmark'], false)
  })

  it('passes allLists=true when "Clear from every list" is on', async () => {
    const { deps, sendClearToTabs } = makeDeps({
      getSettings: async () =>
        settings({ clearOnSave: true, autoUnbookmarkOnSave: true, clearAllListsOnSave: true }),
    })
    await downloadAndSettle(makeClearCoordinator(deps))
    expect(sendClearToTabs).toHaveBeenCalledWith('T', ['bookmark'], true)
  })

  it('probes the exact download id recorded for the tweet', async () => {
    const { deps, settleProbe } = makeDeps()
    await downloadAndSettle(makeClearCoordinator(deps))
    expect(settleProbe).toHaveBeenCalledWith(123)
  })

  // The negatives assert the settle path DID run (settleProbe called) AND the gate
  // withheld the Clear — so a future wiring regression (no probe / no timer) goes
  // red here too, not just a vacuous not.toHaveBeenCalled() on a path that never ran.
  it('NEVER fires the Clear when the probe is missing (search threw / no row)', async () => {
    const { deps, sendClearToTabs, settleProbe } = makeDeps({
      settleProbe: probeFn(async () => undefined),
    })
    await downloadAndSettle(makeClearCoordinator(deps))
    expect(settleProbe).toHaveBeenCalledWith(123)
    expect(sendClearToTabs).not.toHaveBeenCalled()
  })

  it('NEVER fires the Clear when the file vanished after completing (exists:false)', async () => {
    const { deps, sendClearToTabs, settleProbe } = makeDeps({
      settleProbe: probeFn(async () => ({ state: 'complete', exists: false })),
    })
    await downloadAndSettle(makeClearCoordinator(deps))
    expect(settleProbe).toHaveBeenCalledWith(123)
    expect(sendClearToTabs).not.toHaveBeenCalled()
  })

  it('NEVER fires the Clear on a late post-complete interrupt', async () => {
    const { deps, sendClearToTabs, settleProbe } = makeDeps({
      settleProbe: probeFn(async () => ({ state: 'interrupted' })),
    })
    await downloadAndSettle(makeClearCoordinator(deps))
    expect(settleProbe).toHaveBeenCalledWith(123)
    expect(sendClearToTabs).not.toHaveBeenCalled()
  })

  it('clears a multi-media tweet only once EVERY media verifiably lands', async () => {
    const { deps, sendClearToTabs } = makeDeps({
      settleProbe: probeFn(async () => ({ state: 'complete', exists: true })),
    })
    const c = makeClearCoordinator(deps)
    seedAndComplete(c, [
      { id: 'm0', downloadId: 10 },
      { id: 'm1', downloadId: 20 },
    ])
    await vi.runAllTimersAsync()
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
    const { deps, sendClearToTabs } = makeDeps({ settleProbe })
    const c = makeClearCoordinator(deps)
    seedAndComplete(c, [
      { id: 'm0', downloadId: 10 },
      { id: 'm1', downloadId: 20 },
    ])
    await vi.runAllTimersAsync()
    expect(settleProbe).toHaveBeenCalledTimes(2)
    expect(sendClearToTabs).not.toHaveBeenCalled()
  })
})
