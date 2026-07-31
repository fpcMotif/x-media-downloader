import { describe, expect, it, vi } from 'vitest'
import { makeReleaseRecheck, RELEASE_RECHECK_DELAY_MS, type ReleaseRecheckDeps } from '../recheck'

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
  }
}

type Reading = ReturnType<ReleaseRecheckDeps['probe']>

const reading = (over: Partial<Reading> = {}): Reading => ({
  state: 'cleared',
  articles: 12,
  path: '/i/bookmarks',
  ...over,
})

function harness(opts: { probe?: ReleaseRecheckDeps['probe']; delayMs?: number } = {}) {
  const { clock, delays, pending, runAll } = makeClock()
  const probe = vi.fn<ReleaseRecheckDeps['probe']>(opts.probe ?? (() => reading()))
  const report = vi.fn<ReleaseRecheckDeps['report']>()
  const recheck = makeReleaseRecheck({
    clock,
    probe,
    report,
    ...(opts.delayMs === undefined ? {} : { delayMs: opts.delayMs }),
  })
  return { recheck, probe, report, delays, pending, runAll }
}

/** The `page=` token of the single line a fired probe emitted. */
function pageTokenFor(pathname: string): string {
  const h = harness({ probe: () => reading({ path: pathname }) })
  h.recheck.arm('1', 'bookmark')
  h.runAll()
  return /page=(\S+)/.exec(String(h.report.mock.calls[0]?.[1]))?.[1] ?? ''
}

describe('makeReleaseRecheck', () => {
  it('state=member is the definitive "the release did NOT stick" line', () => {
    // A server revert of DeleteBookmark or a virtualizer-fabricated flip both land here:
    // the post is a scope member again seconds after we reported it cleared.
    const h = harness({ probe: () => reading({ state: 'member', articles: 18 }) })
    h.recheck.arm('1901', 'bookmark')
    h.runAll()
    expect(h.report).toHaveBeenCalledTimes(1)
    expect(h.report).toHaveBeenCalledWith(
      'clear-recheck',
      `scope=bookmark delay=${RELEASE_RECHECK_DELAY_MS}ms state=member articles=18 page=bookmark`,
      '1901',
    )
  })

  it('state=cleared is the happy path (mutation survived the round-trip)', () => {
    const h = harness({
      probe: () => reading({ state: 'cleared', articles: 9, path: '/jack/likes' }),
    })
    h.recheck.arm('42', 'like')
    h.runAll()
    expect(h.report).toHaveBeenCalledWith(
      'clear-recheck',
      `scope=like delay=${RELEASE_RECHECK_DELAY_MS}ms state=cleared articles=9 page=like`,
      '42',
    )
  })

  it('state=absent carries articles + page because it is AMBIGUOUS, not a failure', () => {
    // Nothing mounted at all (articles=0) is the tell that the row's disappearance says
    // nothing about the release — the reader must not score this as a failed Release.
    const h = harness({ probe: () => reading({ state: 'absent', articles: 0, path: '/home' }) })
    h.recheck.arm('7', 'like')
    h.runAll()
    expect(h.report).toHaveBeenCalledWith(
      'clear-recheck',
      `scope=like delay=${RELEASE_RECHECK_DELAY_MS}ms state=absent articles=0 page=home`,
      '7',
    )
  })

  it('passes the armed scope to the probe, so state= describes the scope the line names', () => {
    // isMember/alreadyCleared are per-scope. A scope-blind probe would answer about
    // whichever control the page happens to show, and a post released from BOTH lists
    // would get two lines carrying one scope's verdict under the other scope's name.
    const h = harness()
    h.recheck.arm('1901', 'bookmark')
    h.recheck.arm('1901', 'like')
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

  it('schedules on RELEASE_RECHECK_DELAY_MS when delayMs is omitted', () => {
    const h = harness()
    h.recheck.arm('1', 'bookmark')
    expect(h.delays()).toEqual([RELEASE_RECHECK_DELAY_MS])
    h.runAll()
    expect(h.report.mock.calls[0]?.[1]).toContain(`delay=${RELEASE_RECHECK_DELAY_MS}ms`)
  })

  it('honours an explicit delayMs, on the timer AND on the line', () => {
    const h = harness({ delayMs: 1500 })
    h.recheck.arm('1', 'bookmark')
    expect(h.delays()).toEqual([1500])
    h.runAll()
    expect(h.report.mock.calls[0]?.[1]).toContain('delay=1500ms')
  })

  it('arming the same (tweetId, scope) twice while pending probes and reports ONCE', () => {
    const h = harness()
    h.recheck.arm('1', 'bookmark')
    h.recheck.arm('1', 'bookmark')
    expect(h.pending()).toBe(1)
    h.runAll()
    expect(h.probe).toHaveBeenCalledTimes(1)
    expect(h.report).toHaveBeenCalledTimes(1)
  })

  it('keeps the FIRST timer on a duplicate arm (never pushes the probe out)', () => {
    const h = harness({ delayMs: 900 })
    h.recheck.arm('1', 'bookmark')
    h.recheck.arm('1', 'bookmark')
    expect(h.delays()).toEqual([900])
  })

  it('treats the same tweet in a different scope as its own question', () => {
    const h = harness()
    h.recheck.arm('1', 'bookmark')
    h.recheck.arm('1', 'like')
    h.runAll()
    expect(h.report.mock.calls.map((c) => c[1])).toEqual([
      `scope=bookmark delay=${RELEASE_RECHECK_DELAY_MS}ms state=cleared articles=12 page=bookmark`,
      `scope=like delay=${RELEASE_RECHECK_DELAY_MS}ms state=cleared articles=12 page=bookmark`,
    ])
  })

  it('re-arming AFTER the probe fired reports again (a later release is a new question)', () => {
    const h = harness()
    h.recheck.arm('1', 'bookmark')
    h.runAll()
    h.recheck.arm('1', 'bookmark')
    h.runAll()
    expect(h.report).toHaveBeenCalledTimes(2)
  })

  it('cancelAll drops a pending probe: no probe, no report', () => {
    const h = harness()
    h.recheck.arm('1', 'bookmark')
    h.recheck.arm('2', 'like')
    h.recheck.cancelAll()
    expect(h.pending()).toBe(0)
    h.runAll()
    expect(h.probe).not.toHaveBeenCalled()
    expect(h.report).not.toHaveBeenCalled()
  })

  it('cancelAll clears the pending set, so the same key can be re-armed', () => {
    const h = harness()
    h.recheck.arm('1', 'bookmark')
    h.recheck.cancelAll()
    h.recheck.arm('1', 'bookmark')
    expect(h.pending()).toBe(1)
    h.runAll()
    expect(h.report).toHaveBeenCalledTimes(1)
  })

  it('a throwing probe does not escape arm/the timer; it reports state=probe-error', () => {
    const h = harness({
      probe: () => {
        throw new Error('findArticle blew up')
      },
    })
    h.recheck.arm('1', 'bookmark')
    expect(() => h.runAll()).not.toThrow()
    expect(h.report).toHaveBeenCalledWith(
      'clear-recheck',
      `scope=bookmark delay=${RELEASE_RECHECK_DELAY_MS}ms state=probe-error articles=0 page=unknown`,
      '1',
    )
  })

  it('never probes or reports before the delay elapses', () => {
    const h = harness()
    h.recheck.arm('1', 'bookmark')
    expect(h.probe).not.toHaveBeenCalled()
    expect(h.report).not.toHaveBeenCalled()
  })
})
