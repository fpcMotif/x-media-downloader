import { describe, expect, it, vi } from 'vitest'
import {
  makeReleaseRecheck,
  RELEASE_RECHECK_ATTEMPTS,
  RELEASE_RECHECK_INTERVAL_MS,
  type ReleaseRecheckDeps,
} from '../recheck'

/** A hand-rolled `after`-only clock: records each scheduled delay, fires on demand, and
 *  honours cancel — fake time, the scroll-drain/tweet-clear precedent. */
function makeClock() {
  let seq = 0
  const timers = new Map<number, { ms: number; fn: () => void }>()
  const clock: ReleaseRecheckDeps['clock'] = {
    after: (ms, fn) => {
      const id = ++seq
      timers.set(id, { ms, fn })
      return () => {
        timers.delete(id)
      }
    },
  }
  return {
    clock,
    delays: () => [...timers.values()].map((t) => t.ms),
    pending: () => timers.size,
    /** Fire every armed timer once, in arm order (mirrors a setTimeout flush). Snapshot
     *  first, so a timer armed by a firing callback waits for the NEXT flush rather than
     *  running inside this one. */
    runAll: () => {
      const armed = [...timers.values()]
      timers.clear()
      for (const timer of armed) timer.fn()
    },
    /** Flush every round of a re-arming chain to completion (member found, or the
     *  attempt budget exhausted) — bounded so a bug that never disarms fails the
     *  test instead of hanging it. */
    drain: (maxRounds = 20) => {
      for (let i = 0; i < maxRounds && timers.size > 0; i++) {
        const armed = [...timers.values()]
        timers.clear()
        for (const timer of armed) timer.fn()
      }
    },
  }
}

type Reading = ReturnType<ReleaseRecheckDeps['probe']>

const reading = (over: Partial<Reading> = {}): Reading => ({
  state: 'cleared',
  articles: 12,
  path: '/i/bookmarks',
  ...over,
})

function harness(
  opts: {
    probe?: ReleaseRecheckDeps['probe']
    intervalMs?: number
    attempts?: number
    freshTimelineHasMember?: ReleaseRecheckDeps['freshTimelineHasMember']
  } = {},
) {
  const { clock, delays, pending, runAll, drain } = makeClock()
  const probe = vi.fn<ReleaseRecheckDeps['probe']>(opts.probe ?? (() => reading()))
  const report = vi.fn<ReleaseRecheckDeps['report']>()
  const freshTimelineHasMember = vi.fn<ReleaseRecheckDeps['freshTimelineHasMember']>(
    opts.freshTimelineHasMember ?? (() => 'unknown'),
  )
  const recheck = makeReleaseRecheck({
    clock,
    probe,
    freshTimelineHasMember,
    report,
    ...(opts.intervalMs === undefined ? {} : { intervalMs: opts.intervalMs }),
    ...(opts.attempts === undefined ? {} : { attempts: opts.attempts }),
  })
  return { recheck, probe, report, freshTimelineHasMember, delays, pending, runAll, drain }
}

/** The `page=` token of the ordinary `clear-recheck` line the first probe emitted. */
function pageTokenFor(pathname: string): string {
  const h = harness({ probe: () => reading({ path: pathname }) })
  h.recheck.arm('1', 'bookmark', 'settle')
  h.runAll()
  return /page=(\S+)/.exec(String(h.report.mock.calls[0]?.[1]))?.[1] ?? ''
}

describe('makeReleaseRecheck', () => {
  it('state=member reports the ordinary line AND a distinct clear-reappeared line, then stops', () => {
    // A server revert of DeleteBookmark or a virtualizer-fabricated flip both land here:
    // the post is a scope member again — the watchdog's whole reason to exist.
    const h = harness({
      probe: () => reading({ state: 'member', articles: 18 }),
      freshTimelineHasMember: () => 'present',
    })
    h.recheck.arm('1901', 'bookmark', 'settle')
    h.drain()
    expect(h.probe).toHaveBeenCalledTimes(1) // found it on the FIRST attempt — no further probes
    expect(h.report).toHaveBeenCalledTimes(2)
    expect(h.report).toHaveBeenNthCalledWith(
      1,
      'clear-recheck',
      `scope=bookmark origin=settle attempt=1 elapsedMs=${RELEASE_RECHECK_INTERVAL_MS} state=member articles=18 page=bookmark`,
      '1901',
    )
    expect(h.report).toHaveBeenNthCalledWith(
      2,
      'clear-reappeared',
      `scope=bookmark origin=settle attempt=1 elapsedMs=${RELEASE_RECHECK_INTERVAL_MS} articles=18 page=bookmark freshTimeline=present`,
      '1901',
    )
    expect(h.freshTimelineHasMember).toHaveBeenCalledWith('1901', 'bookmark')
    expect(h.pending()).toBe(0)
  })

  it('freshTimeline rides absent/unknown through exactly as freshTimelineHasMember answers', () => {
    const absent = harness({
      probe: () => reading({ state: 'member' }),
      freshTimelineHasMember: () => 'absent',
    })
    absent.recheck.arm('1', 'bookmark', 'drain')
    absent.drain()
    expect(absent.report.mock.calls[1]?.[1]).toContain('freshTimeline=absent')

    const unknown = harness({ probe: () => reading({ state: 'member' }) })
    unknown.recheck.arm('1', 'bookmark', 'drain')
    unknown.drain()
    expect(unknown.report.mock.calls[1]?.[1]).toContain('freshTimeline=unknown')
  })

  it('freshTimelineHasMember is consulted ONLY on a re-appearance — never on cleared/absent', () => {
    const h = harness({ probe: () => reading({ state: 'cleared' }) })
    h.recheck.arm('1', 'bookmark', 'settle')
    h.drain()
    expect(h.freshTimelineHasMember).not.toHaveBeenCalled()
  })

  it('state=cleared (the happy path) re-arms across the whole attempt budget, then disarms silently', () => {
    const h = harness({
      probe: () => reading({ state: 'cleared', articles: 9, path: '/jack/likes' }),
    })
    h.recheck.arm('42', 'like', 'settle')
    h.drain()
    expect(h.probe).toHaveBeenCalledTimes(RELEASE_RECHECK_ATTEMPTS)
    // Every attempt reports the ordinary line — no clear-reappeared, no extra "gave up" line.
    expect(h.report).toHaveBeenCalledTimes(RELEASE_RECHECK_ATTEMPTS)
    expect(h.report.mock.calls.every((c) => c[0] === 'clear-recheck')).toBe(true)
    expect(h.report.mock.calls[0]?.[1]).toBe(
      `scope=like origin=settle attempt=1 elapsedMs=${RELEASE_RECHECK_INTERVAL_MS} state=cleared articles=9 page=like`,
    )
    expect(h.report.mock.calls[RELEASE_RECHECK_ATTEMPTS - 1]?.[1]).toBe(
      `scope=like origin=settle attempt=${RELEASE_RECHECK_ATTEMPTS} elapsedMs=${RELEASE_RECHECK_ATTEMPTS * RELEASE_RECHECK_INTERVAL_MS} state=cleared articles=9 page=like`,
    )
    expect(h.pending()).toBe(0)
  })

  it('state=absent carries articles + page because it is AMBIGUOUS, not a failure — and still re-arms', () => {
    // Nothing mounted at all (articles=0) is the tell that the row's disappearance says
    // nothing about the release — the reader must not score this as a failed Release.
    const h = harness({ probe: () => reading({ state: 'absent', articles: 0, path: '/home' }) })
    h.recheck.arm('7', 'like', 'settle')
    h.runAll()
    expect(h.report).toHaveBeenCalledWith(
      'clear-recheck',
      `scope=like origin=settle attempt=1 elapsedMs=${RELEASE_RECHECK_INTERVAL_MS} state=absent articles=0 page=home`,
      '7',
    )
    expect(h.pending()).toBe(1) // re-armed for attempt 2
  })

  it('passes the armed scope to the probe, so state= describes the scope the line names', () => {
    // isMember/alreadyCleared are per-scope. A scope-blind probe would answer about
    // whichever control the page happens to show, and a post released from BOTH lists
    // would get two lines carrying one scope's verdict under the other scope's name.
    const h = harness()
    h.recheck.arm('1901', 'bookmark', 'settle')
    h.recheck.arm('1901', 'like', 'settle')
    h.runAll()
    expect(h.probe.mock.calls).toEqual([
      ['1901', 'bookmark'],
      ['1901', 'like'],
    ])
  })

  it('logs a bounded page token, never the raw pathname (no @handle in the durable log)', () => {
    // `/{handle}/likes` and `/{handle}/status/{id}` are post-identifying; this line is
    // persisted and exported, so only the classification may ride on it.
    expect(pageTokenFor('/jack/likes')).toBe('like')
    expect(pageTokenFor('/i/bookmarks')).toBe('bookmark')
    expect(pageTokenFor('/home')).toBe('home')
    expect(pageTokenFor('/jack/status/1901')).toBe('other')
  })

  it('schedules on RELEASE_RECHECK_INTERVAL_MS when intervalMs is omitted', () => {
    const h = harness()
    h.recheck.arm('1', 'bookmark', 'settle')
    expect(h.delays()).toEqual([RELEASE_RECHECK_INTERVAL_MS])
    h.runAll()
    expect(h.report.mock.calls[0]?.[1]).toContain(`elapsedMs=${RELEASE_RECHECK_INTERVAL_MS}`)
  })

  it('honours an explicit intervalMs, on the timer AND on the line, across re-arms', () => {
    const h = harness({ intervalMs: 1500, attempts: 2 })
    h.recheck.arm('1', 'bookmark', 'settle')
    expect(h.delays()).toEqual([1500])
    h.runAll()
    expect(h.report.mock.calls[0]?.[1]).toContain('elapsedMs=1500')
    expect(h.delays()).toEqual([1500]) // re-armed for attempt 2, same interval
    h.runAll()
    expect(h.report.mock.calls[1]?.[1]).toContain('elapsedMs=3000')
  })

  it('honours an explicit smaller attempts budget', () => {
    const h = harness({ attempts: 2 })
    h.recheck.arm('1', 'bookmark', 'settle')
    h.drain()
    expect(h.probe).toHaveBeenCalledTimes(2)
    expect(h.pending()).toBe(0)
  })

  it('arming the same (tweetId, scope) twice while pending probes and reports ONCE per attempt', () => {
    const h = harness()
    h.recheck.arm('1', 'bookmark', 'settle')
    h.recheck.arm('1', 'bookmark', 'drain')
    expect(h.pending()).toBe(1)
    h.runAll()
    expect(h.probe).toHaveBeenCalledTimes(1)
    expect(h.report).toHaveBeenCalledTimes(1)
    // The FIRST arm's origin wins — a duplicate arm never overwrites the in-flight chain.
    expect(h.report.mock.calls[0]?.[1]).toContain('origin=settle')
  })

  it('keeps the FIRST timer on a duplicate arm (never pushes the probe out)', () => {
    const h = harness({ intervalMs: 900 })
    h.recheck.arm('1', 'bookmark', 'settle')
    h.recheck.arm('1', 'bookmark', 'settle')
    expect(h.delays()).toEqual([900])
  })

  it('treats the same tweet in a different scope as its own question', () => {
    const h = harness()
    h.recheck.arm('1', 'bookmark', 'settle')
    h.recheck.arm('1', 'like', 'drain')
    h.runAll()
    expect(h.report.mock.calls.map((c) => c[1])).toEqual([
      `scope=bookmark origin=settle attempt=1 elapsedMs=${RELEASE_RECHECK_INTERVAL_MS} state=cleared articles=12 page=bookmark`,
      `scope=like origin=drain attempt=1 elapsedMs=${RELEASE_RECHECK_INTERVAL_MS} state=cleared articles=12 page=bookmark`,
    ])
  })

  it('re-arming AFTER the chain finished starts a fresh chain (a later release is a new question)', () => {
    const h = harness({ attempts: 1 })
    h.recheck.arm('1', 'bookmark', 'settle')
    h.drain()
    expect(h.pending()).toBe(0)
    h.recheck.arm('1', 'bookmark', 'manual')
    expect(h.pending()).toBe(1)
    h.drain()
    expect(h.report).toHaveBeenCalledTimes(2)
    expect(h.report.mock.calls[1]?.[1]).toContain('origin=manual')
  })

  it('cancelAll drops a pending chain: no probe, no report', () => {
    const h = harness()
    h.recheck.arm('1', 'bookmark', 'settle')
    h.recheck.arm('2', 'like', 'settle')
    h.recheck.cancelAll()
    expect(h.pending()).toBe(0)
    h.runAll()
    expect(h.probe).not.toHaveBeenCalled()
    expect(h.report).not.toHaveBeenCalled()
  })

  it('cancelAll clears the pending set, so the same key can be re-armed', () => {
    const h = harness()
    h.recheck.arm('1', 'bookmark', 'settle')
    h.recheck.cancelAll()
    h.recheck.arm('1', 'bookmark', 'settle')
    expect(h.pending()).toBe(1)
    h.runAll()
    expect(h.report).toHaveBeenCalledTimes(1)
  })

  it('a throwing probe does not escape arm/the timer; it reports state=probe-error and still re-arms', () => {
    const h = harness({
      probe: () => {
        throw new Error('findArticle blew up')
      },
    })
    h.recheck.arm('1', 'bookmark', 'settle')
    expect(() => h.runAll()).not.toThrow()
    expect(h.report).toHaveBeenCalledWith(
      'clear-recheck',
      `scope=bookmark origin=settle attempt=1 elapsedMs=${RELEASE_RECHECK_INTERVAL_MS} state=probe-error articles=0 page=unknown`,
      '1',
    )
    expect(h.pending()).toBe(1) // probe-error is not definitive — the chain keeps going
  })

  it('never probes or reports before the first interval elapses', () => {
    const h = harness()
    h.recheck.arm('1', 'bookmark', 'settle')
    expect(h.probe).not.toHaveBeenCalled()
    expect(h.report).not.toHaveBeenCalled()
  })
})
