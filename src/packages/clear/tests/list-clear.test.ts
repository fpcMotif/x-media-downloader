import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeListClear, type ListClearDeps } from '../list-clear'

const VIEWPORT = 800
const clamp = (v: number, maxY: number): number => Math.max(0, Math.min(maxY, v))

/**
 * A fake window-scroll + virtualized list. `layout` maps a postId to the absolute Y
 * where its article sits; a post is "mounted" when its Y falls in the current
 * viewport. `clearVisibleForPage` clears (deletes from `layout`) every mounted post
 * and returns the count — exactly what the real per-pass click sweep does.
 */
function harness(opts: { layout?: Record<string, number>; maxY?: number; path?: string }) {
  const layout: Record<string, number> = { ...opts.layout }
  const maxY = opts.maxY ?? 4000
  const scroll = { y: 0 }
  const scrollCalls = { to: [] as number[], by: [] as number[] }
  let path = opts.path ?? '/someone/likes'

  const mounted = (): string[] =>
    Object.entries(layout)
      .filter(([, y]) => y >= scroll.y && y < scroll.y + VIEWPORT)
      .map(([id]) => id)

  const clearVisibleForPage = vi.fn<ListClearDeps['clearVisibleForPage']>(async () => {
    const ids = mounted()
    for (const id of ids) delete layout[id]
    return ids.length
  })
  const report = vi.fn<ListClearDeps['report']>()

  const deps: ListClearDeps = {
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
    clearVisibleForPage,
    report,
  }
  return {
    deps,
    scroll,
    scrollCalls,
    clearVisibleForPage,
    report,
    setPath: (p: string) => {
      path = p
    },
  }
}

const stagesOf = (report: ReturnType<typeof harness>['report']): string[] =>
  report.mock.calls.map((c) => c[0])

describe('makeListClear', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('scrolls the whole list top-to-bottom, clears every post, and restores scroll position', async () => {
    // Three posts spread down the list; the user is parked mid-list when it starts.
    const h = harness({ layout: { a: 0, b: 1500, c: 3000 }, maxY: 3200 })
    h.scroll.y = 2000
    const resP = makeListClear(h.deps).run()
    await vi.runAllTimersAsync()
    const res = await resP

    expect(res.cleared).toBe(3)
    expect(res.reason).toBeUndefined()
    expect(h.scrollCalls.to[0]).toBe(0) // jumped to the top first
    expect(h.scroll.y).toBe(2000) // restored to where the user was
    expect(stagesOf(h.report)).toContain('clear-list-start')
    expect(stagesOf(h.report)).toContain('clear-list-end')
    // Per-pass progress: every reported pass cleared something (empty passes stay
    // silent), and the pass counts account for every cleared post.
    const passes = h.report.mock.calls.filter(([stage]) => stage === 'clear-list-pass')
    expect(passes.length).toBeGreaterThan(0)
    const perPass = passes.map(([, detail]) =>
      Number(/^cleared (\d+) this pass$/.exec(detail)?.[1]),
    )
    expect(perPass.every((n) => n >= 1)).toBe(true)
    expect(perPass.reduce((a, b) => a + b, 0)).toBe(3)
  })

  it('returns not-list-page and never scrolls when off a Likes/Bookmarks list', async () => {
    const h = harness({ layout: { a: 0 }, path: '/home' })
    const res = await makeListClear(h.deps).run()

    expect(res).toEqual({ cleared: 0, reason: 'not-list-page' })
    expect(h.clearVisibleForPage).not.toHaveBeenCalled()
    expect(h.scrollCalls.to).toHaveLength(0)
    expect(h.scrollCalls.by).toHaveLength(0)
  })

  it('stops at the bottom after a run of stalls instead of running to the step cap', async () => {
    const h = harness({ layout: {}, maxY: 0 }) // empty list, can't scroll
    const resP = makeListClear(h.deps).run()
    await vi.runAllTimersAsync()
    const res = await resP

    expect(res.cleared).toBe(0)
    expect(h.scrollCalls.by.length).toBeGreaterThanOrEqual(3) // needed the stall run
    expect(h.scrollCalls.by.length).toBeLessThan(20) // nowhere near the 400-step cap
  })

  it('honors the step cap when clears never stop (pathological never-empty list)', async () => {
    const h = harness({ maxY: 1_000_000 })
    h.clearVisibleForPage.mockImplementation(async () => 1) // always one more to clear
    const resP = makeListClear(h.deps).run()
    await vi.runAllTimersAsync()
    const res = await resP

    expect(h.clearVisibleForPage).toHaveBeenCalledTimes(400) // MAX_STEPS backstop
    expect(res.cleared).toBe(400)
  })

  it('aborts the sweep when the user navigates off the list mid-run', async () => {
    const h = harness({ layout: { a: 0, b: 1500, c: 3000 }, maxY: 3200 })
    // The first clear pass simulates the user leaving the Likes list.
    h.clearVisibleForPage.mockImplementationOnce(async () => {
      h.setPath('/home')
      return 1
    })
    const resP = makeListClear(h.deps).run()
    await vi.runAllTimersAsync()
    const res = await resP

    expect(res).toEqual({ cleared: 1, reason: 'scope-changed' }) // only the first pass ran
    expect(h.clearVisibleForPage).toHaveBeenCalledTimes(1)
    expect(h.scroll.y).toBe(0) // scroll position restored
    expect(h.report).toHaveBeenCalledWith(
      'clear-list-abort',
      'reason=off-list start=like now=none cleared=1',
    )
  })

  it('aborts with scope-changed when the page switches to the OTHER list mid-run', async () => {
    const h = harness({ layout: { a: 0, b: 1500, c: 3000 }, maxY: 3200 })
    // Likes → Bookmarks: still a list page, so `pageScope` stays Some and the old
    // is-there-any-scope bail waved this through for the rest of the 400-step run —
    // un-liking posts while the user looked at Bookmarks. Only a start-vs-live
    // comparison catches it.
    h.clearVisibleForPage.mockImplementationOnce(async () => {
      h.setPath('/i/bookmarks')
      return 1
    })
    const resP = makeListClear(h.deps).run()
    await vi.runAllTimersAsync()
    const res = await resP

    expect(res).toEqual({ cleared: 1, reason: 'scope-changed' })
    expect(h.clearVisibleForPage).toHaveBeenCalledTimes(1) // never a second pass
    expect(h.scroll.y).toBe(0) // scroll position restored
    expect(h.report).toHaveBeenCalledWith(
      'clear-list-abort',
      'reason=scope-switched start=like now=bookmark cleared=1',
    )
    // The abort still closes the run — a `clear-list-start` without its end would
    // read as a run that never terminated in the diagnostics export.
    expect(stagesOf(h.report)).toContain('clear-list-end')
  })
})
