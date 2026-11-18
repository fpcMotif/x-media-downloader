import { describe, expect, it, vi } from 'vitest'
import { makeClickGuard, RECENT_RELEASE_MEMO_MS } from '../click-guard'

describe('makeClickGuard', () => {
  it('two callers at once share one click and receive the same verdict', async () => {
    const guard = makeClickGuard({ now: () => 1000 })
    const gate = Promise.withResolvers<boolean>()
    const click = vi.fn<() => Promise<boolean>>(() => gate.promise)

    const first = guard.run('1', 'bookmark', click)
    const second = guard.run('1', 'bookmark', click)
    expect(click).toHaveBeenCalledTimes(1)

    gate.resolve(true)
    expect(await Promise.all([first, second])).toEqual([true, true])
  })

  it('remembers a released verdict for memoMs without clicking again', async () => {
    let t = 1000
    const guard = makeClickGuard({ now: () => t })
    const click = vi.fn<() => Promise<boolean>>(async () => true)

    expect(await guard.run('1', 'bookmark', click)).toBe(true)
    t += RECENT_RELEASE_MEMO_MS - 1
    expect(await guard.run('1', 'bookmark', click)).toBe(true)
    expect(click).toHaveBeenCalledTimes(1)
  })

  it('runs click again once memoMs has elapsed', async () => {
    let t = 1000
    const guard = makeClickGuard({ now: () => t })
    const click = vi.fn<() => Promise<boolean>>(async () => true)

    expect(await guard.run('1', 'bookmark', click)).toBe(true)
    t += RECENT_RELEASE_MEMO_MS
    expect(await guard.run('1', 'bookmark', click)).toBe(true)
    expect(click).toHaveBeenCalledTimes(2)
  })

  it('does not remember a failed verdict', async () => {
    const guard = makeClickGuard({ now: () => 1000 })
    const click = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)

    expect(await guard.run('1', 'bookmark', click)).toBe(false)
    expect(await guard.run('1', 'bookmark', click)).toBe(true)
    expect(click).toHaveBeenCalledTimes(2)
  })

  it('keeps scopes and posts independent while a click is in flight', async () => {
    const guard = makeClickGuard({ now: () => 1000 })
    const bookmark1 = Promise.withResolvers<boolean>()
    const clickBookmark1 = vi.fn<() => Promise<boolean>>(() => bookmark1.promise)
    const clickLike1 = vi.fn<() => Promise<boolean>>(async () => true)
    const clickBookmark2 = vi.fn<() => Promise<boolean>>(async () => true)

    const p1 = guard.run('1', 'bookmark', clickBookmark1)
    expect(await guard.run('1', 'like', clickLike1)).toBe(true)
    expect(await guard.run('2', 'bookmark', clickBookmark2)).toBe(true)
    expect(clickBookmark1).toHaveBeenCalledTimes(1)
    expect(clickLike1).toHaveBeenCalledTimes(1)
    expect(clickBookmark2).toHaveBeenCalledTimes(1)

    bookmark1.resolve(true)
    expect(await p1).toBe(true)
  })
})
