import { describe, it, expect } from 'vitest'
import { Effect } from 'effect'
import type { DownloadStrategy, SaveRequest } from './strategy'
import { DownloadError } from '../errors'
import { makeDownloadQueueCore } from './queue'

const mk = (id: string): SaveRequest => ({
  id,
  url: `https://pbs.twimg.com/media/${id}.jpg?name=orig`,
  filename: `${id}.jpg`,
})

describe('DownloadQueue core', () => {
  it('saves every request and reports completed/total', async () => {
    const saved: string[] = []
    const strategy: DownloadStrategy = {
      save: (req) =>
        Effect.sync(() => {
          saved.push(req.filename)
          return { kind: 'browser', id: 1 }
        }),
    }
    const queue = makeDownloadQueueCore({ strategy, concurrency: 3 })
    const res = await Effect.runPromise(queue.enqueue([mk('a'), mk('b')]))
    expect(res.completed).toBe(2)
    expect(res.failed).toBe(0)
    expect(res.total).toBe(2)
    expect(saved.toSorted()).toEqual(['a.jpg', 'b.jpg'])
    expect(res.outcomes.map((o) => o.ok)).toEqual([true, true])
    expect(res.outcomes[0]).toMatchObject({ id: 'a', ok: true, handle: { kind: 'browser', id: 1 } })
  })

  it('reports a per-request outcome for a failure (ok:false, no handle)', async () => {
    const strategy: DownloadStrategy = {
      save: (req) =>
        req.id === 'b'
          ? Effect.fail(new DownloadError({ id: req.id, reason: 'nope' }))
          : Effect.succeed({ kind: 'browser', id: 1 }),
    }
    const queue = makeDownloadQueueCore({ strategy, concurrency: 2, retries: 0 })
    const res = await Effect.runPromise(queue.enqueue([mk('a'), mk('b')]))
    expect(res.completed).toBe(1)
    expect(res.failed).toBe(1)
    const b = res.outcomes.find((o) => o.id === 'b')!
    expect(b.ok).toBe(false)
    expect(b.handle).toBeUndefined()
  })

  it('never exceeds the configured concurrency', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const strategy: DownloadStrategy = {
      save: () =>
        Effect.gen(function* () {
          inFlight++
          maxInFlight = Math.max(maxInFlight, inFlight)
          yield* Effect.sleep('10 millis')
          inFlight--
          return { kind: 'browser', id: 1 }
        }),
    }
    const queue = makeDownloadQueueCore({ strategy, concurrency: 2 })
    const requests = ['a', 'b', 'c', 'd', 'e'].map(mk)
    await Effect.runPromise(queue.enqueue(requests))
    expect(maxInFlight).toBeLessThanOrEqual(2)
  })

  it('retries a transient failure and ultimately succeeds', async () => {
    let attempts = 0
    const strategy: DownloadStrategy = {
      save: () =>
        Effect.suspend(() => {
          attempts++
          return attempts < 3
            ? Effect.fail(new DownloadError({ id: 'x', reason: 'transient' }))
            : Effect.succeed({ kind: 'browser', id: 1 } as const)
        }),
    }
    const queue = makeDownloadQueueCore({ strategy, concurrency: 1, retries: 3, retryBaseMs: 5 })
    const res = await Effect.runPromise(queue.enqueue([mk('a')]))
    expect(res.completed).toBe(1)
    expect(attempts).toBe(3)
  })

  // REGRESSION (was a characterization of the zero-backoff busy-spin): the queue
  // now spaces save-start retries with exponential backoff (base·2ⁿ) bounded to
  // `retries`, so a flapping twimg CDN gets backing-off retries instead of being
  // hammered back-to-back. (Transfer-level backoff still lives in interrupt-retry.)
  it('spaces a flapping CDN’s retries with exponential backoff', async () => {
    const ts: number[] = []
    let attempts = 0
    const strategy: DownloadStrategy = {
      save: (req) =>
        Effect.suspend(() => {
          ts.push(Date.now())
          attempts++
          // The CDN flaps: every attempt before the 4th 403s, then it recovers.
          return attempts < 4
            ? Effect.fail(new DownloadError({ id: req.id, reason: 'twimg 403 (flapping CDN)' }))
            : Effect.succeed({ kind: 'browser', id: 1 } as const)
        }),
    }
    const queue = makeDownloadQueueCore({ strategy, concurrency: 1, retries: 3, retryBaseMs: 30 })
    const res = await Effect.runPromise(queue.enqueue([mk('flap')]))

    expect(res.completed).toBe(1)
    // recurs(3) => up to 3 retries after the first try = 4 attempts total.
    expect(attempts).toBe(4)
    // Real spacing now exists (was ~0 before): attempts land at t0, ~+30, ~+60,
    // ~+120, and each successive backoff grows (exponential, factor 2).
    const gaps = ts.slice(1).map((t, i) => t - ts[i]!)
    expect(gaps[0]!).toBeGreaterThanOrEqual(20)
    expect(gaps[2]!).toBeGreaterThan(gaps[0]!)
  })

  it('exhausts recurs(retries) attempts on a CDN that never recovers, then fails closed', async () => {
    let attempts = 0
    const strategy: DownloadStrategy = {
      save: (req) =>
        Effect.suspend(() => {
          attempts++
          return Effect.fail(
            new DownloadError({ id: req.id, reason: 'twimg 403 (never recovers)' }),
          )
        }),
    }
    const queue = makeDownloadQueueCore({ strategy, concurrency: 1, retries: 3, retryBaseMs: 5 })
    const res = await Effect.runPromise(queue.enqueue([mk('dead')]))

    expect(res.completed).toBe(0)
    expect(res.failed).toBe(1)
    // 1 initial try + recurs(3) retries (now spaced by exponential backoff).
    expect(attempts).toBe(4)
  })
})
