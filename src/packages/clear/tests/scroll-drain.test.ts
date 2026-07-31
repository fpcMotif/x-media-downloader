import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeScrollDrain, type ScrollDrainDeps } from '../scroll-drain'
import type { ClearScopeResult } from '../result'
import type { ClearScope } from '@/packages/schema'

const VIEWPORT = 800
const DEBOUNCE_MS = 1200

const clamp = (v: number, maxY: number): number => Math.max(0, Math.min(maxY, v))

/**
 * A fake window-scroll + virtualized feed. `layout` maps a tweetId to the absolute
 * Y where its article sits; `liveMountedIds` reports the ids whose Y falls in the
 * current viewport — so scrolling "mounts" and "unmounts" posts exactly as X's
 * virtualization does. `maxY` clamps the scroll, which is how a pass reaches the
 * bottom and stalls.
 */
function harness(opts: {
  layout?: Record<string, number>
  maxY?: number
  path?: string
  clear?: (
    id: string,
    scopes: ReadonlyArray<ClearScope>,
  ) => Promise<ReadonlyArray<ClearScopeResult>>
}) {
  const layout = opts.layout ?? {}
  const maxY = opts.maxY ?? 4000
  const scroll = { y: 0 }
  const scrollCalls = { to: [] as number[], by: [] as number[] }
  let path = opts.path ?? '/someone/likes'

  const clearMounted = vi.fn<ScrollDrainDeps['clearMounted']>(
    opts.clear ??
      (async (_id: string, scopes: ReadonlyArray<ClearScope>) =>
        scopes.map((scope) => ({ scope, ok: true }))),
  )
  const report = vi.fn<ScrollDrainDeps['report']>()

  const deps: ScrollDrainDeps = {
    scroll: {
      position: () => scroll.y,
      to: (y) => {
        scrollCalls.to.push(y)
        scroll.y = clamp(y, maxY)
      },
      by: (dy) => {
        scrollCalls.by.push(dy)
        scroll.y = clamp(scroll.y + dy, maxY)
      },
      viewport: () => VIEWPORT,
    },
    clock: {
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      after: (ms, fn) => {
        const h = setTimeout(fn, ms)
        return () => clearTimeout(h)
      },
    },
    path: () => path,
    liveMountedIds: () =>
      Object.entries(layout)
        .filter(([, y]) => y >= scroll.y && y < scroll.y + VIEWPORT)
        .map(([id]) => id),
    clearMounted,
    report,
  }

  return {
    deps,
    scroll,
    scrollCalls,
    clearMounted,
    report,
    setPath: (p: string) => {
      path = p
    },
  }
}

type Harness = ReturnType<typeof harness>

const clearedIds = (h: Harness): string[] => h.clearMounted.mock.calls.map((c) => c[0])
const stagesOf = (h: Harness): string[] => h.report.mock.calls.map((c) => c[0])
const startCount = (h: Harness): number => stagesOf(h).filter((s) => s === 'drain-start').length

// A pass can reject OUTSIDE the per-post try/catch — the scroll-restore in the
// `finally` is the one un-guarded effect left, and a throwing scroll port is exactly
// what a torn-down/navigated tab produces. Without the scheduler's own catch the
// rejection would surface as an unhandled promise on the X page and the drain would
// wedge with `draining` stuck true, silently dropping every remaining post.
// `deps.scroll.to(0)` (the jump to the top) must still succeed, so only the restore
// call throws.
const throwingRestore = (
  h: Harness,
  thrown: unknown = new Error('scroll port detached'),
): ScrollDrainDeps => ({
  ...h.deps,
  scroll: {
    ...h.deps.scroll,
    to: (y) => {
      if (y !== 0) throw thrown
      h.deps.scroll.to(y)
    },
  },
})

describe('makeScrollDrain', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('scans from the top, surfaces not-mounted posts, clears them, and restores scroll', async () => {
    // '100' sits at the top; '200' only mounts after a scroll down. The user is parked
    // near the bottom when the drain begins.
    const h = harness({ layout: { '100': 0, '200': 1500 }, maxY: 2400 })
    h.scroll.y = 2000
    const drain = makeScrollDrain(h.deps)

    void drain.run('100', ['like'], false)
    void drain.run('200', ['like'], false)
    await vi.runAllTimersAsync()

    expect(clearedIds(h).toSorted()).toEqual(['100', '200'])
    expect(h.scrollCalls.to[0]).toBe(0) // jumped to the top before stepping down
    expect(h.scroll.y).toBe(2000) // restored to where the user was
    expect(stagesOf(h)).toContain('drain-start')
    expect(stagesOf(h)).toContain('drain-end')
  })

  it('returns the authorized Drain result to the worker', async () => {
    const h = harness({ layout: { '100': 0 }, maxY: 0 })
    const drain = makeScrollDrain(h.deps)

    const result = drain.run('100', ['like'], false)
    await vi.runAllTimersAsync()

    await expect(result).resolves.toEqual([{ scope: 'like', ok: true }])
  })

  it('returns failure when the mounted DOM clear throws', async () => {
    const h = harness({
      layout: { '100': 0 },
      maxY: 0,
      clear: async () => {
        throw new Error('detached')
      },
    })
    const drain = makeScrollDrain(h.deps)

    const result = drain.run('100', ['like'], false)
    await vi.runAllTimersAsync()

    await expect(result).resolves.toEqual([{ scope: 'like', ok: false }])
  })

  it('reports bookmark drain enqueue with tweet, scope, and queue size', async () => {
    const h = harness({ layout: { '100': 0 }, maxY: 0, path: '/i/bookmarks' })
    const drain = makeScrollDrain(h.deps)

    const result = drain.run('100', ['bookmark'], false)

    expect(h.report).toHaveBeenCalledWith(
      'drain-enqueued',
      'tweet=100 scope=bookmark queue=1',
      '100',
    )
    await vi.runAllTimersAsync()
    await expect(result).resolves.toEqual([{ scope: 'bookmark', ok: true }])
  })

  it('reports bookmark off-list aborts with the terminal reason', async () => {
    const h = harness({ layout: { '100': 0 }, maxY: 0, path: '/i/bookmarks' })
    const drain = makeScrollDrain(h.deps)

    const result = drain.run('100', ['bookmark'], false)
    h.setPath('/home')
    await vi.runAllTimersAsync()

    await expect(result).resolves.toEqual([{ scope: 'bookmark', ok: false }])
    expect(h.report).toHaveBeenCalledWith(
      'drain-abort',
      'tweet=100 scope=bookmark reason=off-list pending=1',
      '100',
    )
  })

  it('reports bookmark clearMounted errors with tweet and failure reason', async () => {
    const h = harness({
      layout: { '100': 0 },
      maxY: 0,
      path: '/i/bookmarks',
      clear: async () => {
        throw new Error('detached')
      },
    })
    const drain = makeScrollDrain(h.deps)

    const result = drain.run('100', ['bookmark'], false)
    await vi.runAllTimersAsync()

    await expect(result).resolves.toEqual([{ scope: 'bookmark', ok: false }])
    expect(h.report).toHaveBeenCalledWith(
      'drain-failed',
      'tweet=100 scope=bookmark reason=detached',
      '100',
    )
  })

  it('reports bookmark empty-pass retries and terminal exhaustion reason', async () => {
    const h = harness({ layout: {}, maxY: 0, path: '/i/bookmarks' })
    const drain = makeScrollDrain(h.deps)

    const result = drain.run('100', ['bookmark'], false)
    await vi.runAllTimersAsync()

    expect(
      h.report.mock.calls.filter(([stage]) => stage === 'drain-retry').map(([, detail]) => detail),
    ).toEqual([
      'ordinal=1 budget=4 pending=1',
      'ordinal=2 budget=4 pending=1',
      'ordinal=3 budget=4 pending=1',
      'ordinal=4 budget=4 pending=1',
    ])
    expect(h.report).toHaveBeenCalledWith(
      'drain-failed',
      'tweet=100 scope=bookmark reason=empty-pass-exhausted pending=1',
      '100',
    )
    await expect(result).resolves.toEqual([{ scope: 'bookmark', ok: false }])
  })

  it('returns failed scopes when the authorized Tweet never mounts', async () => {
    const h = harness({ layout: {}, maxY: 0 })
    const drain = makeScrollDrain(h.deps)

    const result = drain.run('404', ['like', 'bookmark'], false)
    await vi.runAllTimersAsync()

    await expect(result).resolves.toEqual([
      { scope: 'like', ok: false },
      { scope: 'bookmark', ok: false },
    ])
  })

  it('fails pending clears without scrolling when the drain fires off a list page', async () => {
    // Seeded on Likes, but the user navigates away before the debounce elapses —
    // the drain must fail the batch outright, never hijack scrolling on /home.
    const h = harness({ layout: { '100': 0 }, maxY: 0 })
    const drain = makeScrollDrain(h.deps)

    const result = drain.run('100', ['like'], false)
    h.setPath('/home')
    await vi.runAllTimersAsync()

    await expect(result).resolves.toEqual([{ scope: 'like', ok: false }])
    expect(startCount(h)).toBe(0) // no pass ever started
    expect(h.scrollCalls.to).toEqual([]) // and no scroll was touched
  })

  it('fails the remaining pending clears when the user leaves the list mid-pass', async () => {
    // '1' mounts and clears; '404' never mounts. Navigating away during the pass
    // means the leftovers must fail now — not re-schedule against the wrong page.
    const h = harness({
      layout: { '1': 0 },
      maxY: 0,
      clear: async (_id, scopes) => {
        h.setPath('/home')
        return scopes.map((scope) => ({ scope, ok: true }))
      },
    })
    const drain = makeScrollDrain(h.deps)

    const cleared = drain.run('1', ['like'], false)
    const gone = drain.run('404', ['like'], false)
    await vi.runAllTimersAsync()

    await expect(cleared).resolves.toEqual([{ scope: 'like', ok: true }])
    await expect(gone).resolves.toEqual([{ scope: 'like', ok: false }])
    expect(startCount(h)).toBe(1) // the pass did not re-schedule itself
  })

  it('backfills scopes the DOM clear left out of its results as failures', async () => {
    // A clearer may report only the scopes it actually attempted; the waiter still
    // gets an answer for every scope it asked about.
    const h = harness({
      layout: { '1': 0 },
      maxY: 0,
      clear: async () => [{ scope: 'like' as const, ok: true }],
    })
    const drain = makeScrollDrain(h.deps)

    const result = drain.run('1', ['like', 'bookmark'], false)
    await vi.runAllTimersAsync()

    await expect(result).resolves.toEqual([
      { scope: 'like', ok: true },
      { scope: 'bookmark', ok: false },
    ])
  })

  it('coalesces a burst of queued clears into a single scroll pass (debounce)', async () => {
    const h = harness({ layout: { '1': 0, '2': 0, '3': 0 }, maxY: 0 })
    const drain = makeScrollDrain(h.deps)

    void drain.run('1', ['like'], false)
    void drain.run('2', ['like'], false)
    void drain.run('3', ['like'], false)
    await vi.runAllTimersAsync()

    expect(startCount(h)).toBe(1) // one pass, not three
    expect(clearedIds(h).toSorted()).toEqual(['1', '2', '3'])
  })

  it('never auto-scrolls off a Likes/Bookmarks list page', async () => {
    const h = harness({ layout: { '1': 0 }, maxY: 2000, path: '/home' })
    const drain = makeScrollDrain(h.deps)

    void drain.run('1', ['like'], false)
    await vi.runAllTimersAsync()

    expect(h.clearMounted).not.toHaveBeenCalled()
    expect(h.scrollCalls.to).toHaveLength(0)
    expect(h.scrollCalls.by).toHaveLength(0)
    expect(stagesOf(h)).not.toContain('drain-start')
  })

  it('stops at the bottom after a run of stalls instead of running to the step cap', async () => {
    // '1' sits below the reachable bottom, so it never mounts; the pass must detect the
    // bottom (repeated no-progress) and end far short of MAX_STEPS (60).
    const h = harness({ layout: { '1': 10_000 }, maxY: 1000 })
    const drain = makeScrollDrain(h.deps)

    void drain.run('1', ['like'], false)
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 5000) // run just the first pass

    expect(startCount(h)).toBe(1)
    expect(h.clearMounted).not.toHaveBeenCalled()
    expect(h.scrollCalls.by.length).toBeGreaterThanOrEqual(3) // needed the stall run
    expect(h.scrollCalls.by.length).toBeLessThan(10) // but nowhere near the 60-step cap
  })

  it('retries empty passes a bounded number of times, then gives up', async () => {
    const h = harness({ layout: {}, maxY: 0 }) // nothing ever mounts
    const drain = makeScrollDrain(h.deps)

    void drain.run('1', ['like'], false)
    await vi.runAllTimersAsync()

    // initial pass + 4 empty-pass retries, then stop
    expect(startCount(h)).toBe(5)
    expect(h.clearMounted).not.toHaveBeenCalled()
  })

  it('a fresh queue restores the full empty-pass budget (no stranded tail)', async () => {
    const h = harness({ layout: {}, maxY: 0 })
    const drain = makeScrollDrain(h.deps)

    void drain.run('1', ['like'], false)
    await vi.runAllTimersAsync()
    expect(startCount(h)).toBe(5) // budget spent

    void drain.run('2', ['like'], false) // fresh work resets the budget
    await vi.runAllTimersAsync()
    expect(startCount(h)).toBe(10) // a full second budget runs, not a single stranded pass
  })

  it('never runs two passes concurrently when a queue lands mid-drain', async () => {
    const h = harness({ layout: {}, maxY: 0 })
    const drain = makeScrollDrain(h.deps)

    void drain.run('1', ['like'], false)
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS) // first pass is now in flight
    void drain.run('2', ['like'], false) // its scheduleDrain must not open a parallel pass
    await vi.runAllTimersAsync()

    // walk the start/end markers: a second 'drain-start' must never precede the prior 'drain-end'
    let active = 0
    let maxActive = 0
    for (const s of stagesOf(h)) {
      if (s === 'drain-start') active += 1
      if (s === 'drain-end') active -= 1
      maxActive = Math.max(maxActive, active)
    }
    expect(maxActive).toBe(1)
  })

  it('unions scopes across passes — a re-queue never shrinks pending work', async () => {
    const seen: Array<{ id: string; scopes: ReadonlyArray<ClearScope> }> = []
    const h = harness({
      layout: { '1': 0 },
      maxY: 0,
      clear: async (id, scopes) => {
        seen.push({ id, scopes })
        return scopes.map((scope) => ({ scope, ok: true }))
      },
    })
    const drain = makeScrollDrain(h.deps)

    void drain.run('1', ['like'], false)
    void drain.run('1', ['bookmark'], false) // same tweet, second scope, before the pass runs
    await vi.runAllTimersAsync()

    expect(seen.map((s) => s.scopes.toSorted())).toEqual([['bookmark', 'like']])
  })

  it('holds a mid-clear re-queue for its own clear instead of failing it in-flight', async () => {
    // A second run() for the same tweet lands while its clearMounted is awaited. The
    // in-flight attempt never covered the new scope, so that waiter must NOT settle
    // against its results (a false failure) — the re-queued entry clears on a later
    // step and answers the second waiter truthfully.
    const gate: Array<() => void> = []
    const h = harness({
      layout: { '1': 0 },
      maxY: 0,
      clear: async (_id, scopes) => {
        if (gate.length === 0) await new Promise<void>((resolve) => gate.push(resolve))
        return scopes.map((scope) => ({ scope, ok: true }))
      },
    })
    const drain = makeScrollDrain(h.deps)

    const first = drain.run('1', ['like'], false)
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 600) // pass started; clear('1') is in flight
    const second = drain.run('1', ['bookmark'], false)
    gate[0]?.()
    await vi.runAllTimersAsync()

    await expect(first).resolves.toEqual([{ scope: 'like', ok: true }])
    await expect(second).resolves.toEqual([{ scope: 'bookmark', ok: true }])
    expect(clearedIds(h)).toEqual(['1', '1']) // the re-queued entry ran its own clear
  })

  it('settles a same-scope mid-clear re-queue in flight, then clears it waiterless', async () => {
    // Here the in-flight attempt DOES cover the re-queued waiter's scope, so both
    // waiters settle against it; the re-queued pending entry still clears on a later
    // step with no waiter left, and its results are dropped.
    const gate: Array<() => void> = []
    const h = harness({
      layout: { '1': 0 },
      maxY: 0,
      clear: async (_id, scopes) => {
        if (gate.length === 0) await new Promise<void>((resolve) => gate.push(resolve))
        return scopes.map((scope) => ({ scope, ok: true }))
      },
    })
    const drain = makeScrollDrain(h.deps)

    const first = drain.run('1', ['like'], false)
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 600) // pass started; clear('1') is in flight
    const second = drain.run('1', ['like'], false)
    gate[0]?.()
    await vi.runAllTimersAsync()

    await expect(first).resolves.toEqual([{ scope: 'like', ok: true }])
    await expect(second).resolves.toEqual([{ scope: 'like', ok: true }])
    expect(clearedIds(h)).toEqual(['1', '1']) // the waiterless re-queued entry still cleared
  })

  it('reports each scope outcome in the cleared trace (ok / noop / fail)', async () => {
    const h = harness({
      layout: { '1': 0 },
      maxY: 0,
      clear: async () => [
        { scope: 'like', ok: true },
        { scope: 'bookmark', ok: true, noop: true },
        { scope: 'notInterested', ok: false },
      ],
    })
    const drain = makeScrollDrain(h.deps)

    void drain.run('1', ['like', 'bookmark', 'notInterested'], false)
    await vi.runAllTimersAsync()

    const cleared = h.report.mock.calls.find((c) => c[0] === 'cleared')
    expect(cleared?.[1]).toBe('like:ok bookmark:noop notInterested:fail')
  })

  it('reschedules with a fresh budget after a pass that cleared some but not all', async () => {
    // 'A' is reachable immediately; 'B' is rendered lazily, only after the first pass.
    const layout: Record<string, number> = { A: 0 }
    const h = harness({ layout, maxY: 0 })
    const drain = makeScrollDrain(h.deps)

    void drain.run('A', ['like'], false)
    void drain.run('B', ['like'], false)
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 3000) // pass 1 clears A; B still pending
    layout.B = 0 // X lazily mounts B after the first pass
    await vi.runAllTimersAsync() // a promptly-rescheduled pass 2 clears B

    expect(clearedIds(h).toSorted()).toEqual(['A', 'B'])
  })

  /** The single `drain-failed` reason token from a pass whose restore threw `thrown`. */
  const reasonFromThrow = async (thrown: unknown): Promise<string> => {
    const h = harness({ layout: { A: 0 }, maxY: 2000 })
    h.scroll.y = 500
    void makeScrollDrain(throwingRestore(h, thrown)).run('A', ['like'], false)
    await vi.runAllTimersAsync()
    return String(h.report.mock.calls.find((c) => c[0] === 'drain-failed')?.[1])
  }

  it('reports drain-failed with pending=0 when the pass rejects after everything cleared', async () => {
    // The user is parked below the top, so the restore is a non-zero `to` — the call the
    // fake port rejects. (A run that starts at 0 restores to 0 and never trips it.)
    const h = harness({ layout: { A: 0 }, maxY: 2000 })
    h.scroll.y = 500
    const drain = makeScrollDrain(throwingRestore(h))

    void drain.run('A', ['like'], false)
    await vi.runAllTimersAsync()

    // 'A' really was cleared before the restore threw, so no post is accused of failing.
    expect(clearedIds(h)).toEqual(['A'])
    const failed = h.report.mock.calls.find((c) => c[0] === 'drain-failed')
    expect(failed?.[1]).toBe('reason=scroll-port-detached pending=0')
    expect(failed?.[2]).toBeUndefined()
  })

  it('fails the still-pending posts when the pass rejects with work outstanding', async () => {
    // 'B' never mounts, so it is still pending when the restore throws.
    const h = harness({ layout: {}, maxY: 2000 })
    h.scroll.y = 500
    const drain = makeScrollDrain(throwingRestore(h))

    void drain.run('B', ['like'], false)
    await vi.runAllTimersAsync()

    const failed = h.report.mock.calls.filter((c) => c[0] === 'drain-failed')
    expect(failed.map((c) => c[2])).toContain('B')
    expect(failed.some((c) => String(c[1]).includes('reason=scroll-port-detached'))).toBe(true)
  })

  // A rejection is not guaranteed to be an Error (a DOM/extension teardown can reject
  // with a bare string), and an Error's message can be empty or whitespace-only. Both
  // must still yield a greppable token — an empty `reason=` would read as a missing
  // field rather than an unhelpful throw.
  it('falls back to a generic reason for a non-Error throw and for a blank message', async () => {
    expect(await reasonFromThrow('detached')).toBe('reason=error pending=0')
    expect(await reasonFromThrow(new Error('   '))).toBe('reason=error pending=0')
  })
})
