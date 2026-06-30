import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeListClear, type ListClearDeps } from './list-clear'

const VIEWPORT = 800
const clamp = (v: number, maxY: number): number => Math.max(0, Math.min(maxY, v))

/**
 * A fake window-scroll + virtualized list. `layout` maps a postId to the absolute Y
 * where its article sits; a post is "mounted" when its Y falls in the current
 * viewport. `clearVisibleForPage` clears (deletes from `layout`) every mounted post
 * and returns the count — exactly what the real per-pass click sweep does.
 */
function harness(opts: { layout?: Record<string, number>; maxY?: number; path?: string }) {
  const layout: Record<string, number> = { ...(opts.layout ?? {}) }
  const maxY = opts.maxY ?? 4000
  const scroll = { y: 0 }
  const scrollCalls = { to: [] as number[], by: [] as number[] }
  const path = opts.path ?? '/someone/likes'

  const mounted = (): string[] =>
    Object.entries(layout)
      .filter(([, y]) => y >= scroll.y && y < scroll.y + VIEWPORT)
      .map(([id]) => id)

  const clearVisibleForPage = vi.fn(async (): Promise<number> => {
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
  return { deps, scroll, scrollCalls, clearVisibleForPage, report }
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
})
