import { describe, it, expect, vi } from 'vitest'
import { makeSavedIndex, type QueryConvex } from './saved-index'

/** A clock the test drives by hand: `at` advances, `now()` is injected into the index. */
function fakeClock(start = 0) {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

describe('makeSavedIndex', () => {
  it('answers seeded ids from local history without querying Convex for them', async () => {
    const idx = makeSavedIndex()
    idx.seed(['T1', 'T2'])
    const qc = vi.fn<QueryConvex>(async () => [])

    const saved = await idx.resolve(['T1', 'T3'], qc)

    expect(saved).toContain('T1')
    expect(saved).not.toContain('T3')
    // The seeded id is served locally; only the unknown is sent to Convex.
    expect(qc).toHaveBeenCalledTimes(1)
    expect(qc).toHaveBeenCalledWith(['T3'])
  })

  it('lights up an id instantly on markSaved without any Convex call', async () => {
    const idx = makeSavedIndex()
    idx.markSaved('T9')
    const qc = vi.fn<QueryConvex>(async () => [])

    const saved = await idx.resolve(['T9'], qc)

    expect(saved).toEqual(['T9'])
    expect(qc).not.toHaveBeenCalled()
  })

  it('unions a Convex hit into the cache and does not re-query it', async () => {
    const idx = makeSavedIndex()
    const qc = vi.fn<QueryConvex>(async () => ['T4'])

    const first = await idx.resolve(['T4'], qc)
    expect(first).toEqual(['T4'])
    expect(qc).toHaveBeenCalledTimes(1)

    // Now known-saved: the second resolve answers from the Set, no second call.
    const second = await idx.resolve(['T4'], qc)
    expect(second).toEqual(['T4'])
    expect(qc).toHaveBeenCalledTimes(1)
  })

  it('degrades to local-only and never throws when Convex is offline', async () => {
    const idx = makeSavedIndex()
    idx.seed(['T1'])
    const qc = vi.fn<QueryConvex>(async () => {
      throw new Error('offline')
    })

    const saved = await idx.resolve(['T1', 'T2'], qc)

    expect(saved).toEqual(['T1'])
    expect(qc).toHaveBeenCalledWith(['T2'])
  })

  it('does not re-query a miss within the TTL, but does after it elapses', async () => {
    const clock = fakeClock(1_000)
    const missTtlMs = 60_000
    const idx = makeSavedIndex({ now: clock.now, missTtlMs })
    const qc = vi.fn<QueryConvex>(async () => [])

    // First resolve: T5 is unknown, Convex says "not saved" → stamped as a miss.
    expect(await idx.resolve(['T5'], qc)).toEqual([])
    expect(qc).toHaveBeenCalledTimes(1)

    // Within the TTL the miss is trusted; Convex is not asked again.
    clock.advance(missTtlMs - 1)
    expect(await idx.resolve(['T5'], qc)).toEqual([])
    expect(qc).toHaveBeenCalledTimes(1)

    // Past the TTL the miss is stale; Convex is consulted once more.
    clock.advance(2)
    expect(await idx.resolve(['T5'], qc)).toEqual([])
    expect(qc).toHaveBeenCalledTimes(2)
  })

  it('skips the Convex call entirely when every input is already known', async () => {
    const idx = makeSavedIndex()
    idx.seed(['A', 'B'])
    const qc = vi.fn<QueryConvex>(async () => [])

    expect(await idx.resolve(['A', 'B'], qc)).toEqual(['A', 'B'])
    expect(qc).not.toHaveBeenCalled()
  })

  it('preserves input order and dedupes the returned saved ids', async () => {
    const idx = makeSavedIndex()
    idx.seed(['B'])
    const qc = vi.fn<QueryConvex>(async (ids) => (ids.includes('A') ? ['A'] : []))

    const saved = await idx.resolve(['B', 'A', 'B', 'A'], qc)

    expect(saved).toEqual(['B', 'A'])
    // Duplicate unknowns are queried once, not per-occurrence.
    expect(qc).toHaveBeenCalledTimes(1)
    expect(qc).toHaveBeenCalledWith(['A'])
  })

  it('clears a stale miss once Convex later reports the id as saved', async () => {
    const clock = fakeClock(0)
    const missTtlMs = 1_000
    const idx = makeSavedIndex({ now: clock.now, missTtlMs })
    const qc = vi
      .fn<QueryConvex>()
      .mockResolvedValueOnce([]) // first: miss
      .mockResolvedValueOnce(['T6']) // after TTL: now saved

    expect(await idx.resolve(['T6'], qc)).toEqual([])
    clock.advance(missTtlMs + 1)
    expect(await idx.resolve(['T6'], qc)).toEqual(['T6'])
    // Hit is cached: no third call.
    expect(await idx.resolve(['T6'], qc)).toEqual(['T6'])
    expect(qc).toHaveBeenCalledTimes(2)
  })
})
