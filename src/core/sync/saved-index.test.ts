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

  it('known answers synchronously from memory, in input order, deduped', () => {
    const idx = makeSavedIndex()
    idx.seed(['B', 'A'])
    expect(idx.known(['A', 'X', 'B', 'A'])).toEqual(['A', 'B'])
  })

  it('refresh returns only the ids that BECAME saved by this call', async () => {
    const idx = makeSavedIndex()
    idx.seed(['K'])
    const qc = vi.fn<QueryConvex>(async () => ['N'])

    const fresh = await idx.refresh(['K', 'N', 'M'], qc)

    expect(fresh).toEqual(['N']) // K was already known; M is a genuine miss
    expect(qc).toHaveBeenCalledWith(['N', 'M'])
    expect(idx.known(['N'])).toEqual(['N']) // cached for the next sweep
  })

  it('coalesces concurrent refreshes — one in-flight query serves both callers', async () => {
    const idx = makeSavedIndex()
    let release: ((hits: string[]) => void) | undefined
    const qc = vi.fn<QueryConvex>(
      () =>
        new Promise((r) => {
          release = r
        }),
    )

    const p1 = idx.refresh(['T1', 'T2'], qc)
    const p2 = idx.refresh(['T1', 'T2'], qc)
    expect(qc).toHaveBeenCalledTimes(1)

    release!(['T1'])
    expect(await p1).toEqual(['T1'])
    expect(await p2).toEqual(['T1']) // joined the same flight, same fresh delta
  })

  it('a caller joining an in-flight id still queries its own NEW ids', async () => {
    const idx = makeSavedIndex()
    const calls: string[][] = []
    const releases: Array<(hits: string[]) => void> = []
    const qc = vi.fn<QueryConvex>((ids) => {
      calls.push([...ids])
      return new Promise((r) => {
        releases.push(r)
      })
    })

    const p1 = idx.refresh(['T1'], qc)
    const p2 = idx.refresh(['T1', 'T2'], qc)
    expect(calls).toEqual([['T1'], ['T2']])

    releases[0]!(['T1'])
    releases[1]!(['T2'])
    expect(await p1).toEqual(['T1'])
    expect(await p2).toEqual(['T1', 'T2'])
  })

  it('refresh never rejects on a backstop failure and leaves the ids re-queryable', async () => {
    const idx = makeSavedIndex()
    const qc = vi.fn<QueryConvex>(async () => {
      throw new Error('offline')
    })

    expect(await idx.refresh(['T1'], qc)).toEqual([])
    // No miss was stamped — we never learned the answer — so a later refresh retries.
    expect(await idx.refresh(['T1'], qc)).toEqual([])
    expect(qc).toHaveBeenCalledTimes(2)
  })

  it('a markSaved landing during an in-flight query is not overwritten by a late miss', async () => {
    const idx = makeSavedIndex()
    let release: ((hits: string[]) => void) | undefined
    const qc = vi.fn<QueryConvex>(
      () =>
        new Promise((r) => {
          release = r
        }),
    )

    const p = idx.refresh(['T1'], qc)
    idx.markSaved('T1') // local completion wins while the backstop is in flight
    release!([]) // stale backstop answer: "not saved"
    expect(await p).toEqual(['T1']) // it DID become saved during the call
    expect(idx.known(['T1'])).toEqual(['T1'])
  })

  it('resolve joins an in-flight refresh instead of double-querying, and still blocks', async () => {
    const idx = makeSavedIndex()
    let release: ((hits: string[]) => void) | undefined
    const qc = vi.fn<QueryConvex>(
      () =>
        new Promise((r) => {
          release = r
        }),
    )

    const refreshing = idx.refresh(['T1'], qc)
    const resolving = idx.resolve(['T1'], qc)
    expect(qc).toHaveBeenCalledTimes(1)

    release!(['T1'])
    await refreshing
    expect(await resolving).toEqual(['T1'])
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
