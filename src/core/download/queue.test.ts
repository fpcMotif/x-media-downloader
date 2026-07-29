import { describe, it, expect } from 'vitest'
import { Effect } from 'effect'
import type { DownloadStrategy, SaveRequest } from './strategy'
import { DownloadError } from '../errors'
import { boundedDiagnosticText } from '../diagnostic-text'
import { MAX_FAILURE_REASON_LENGTH } from '../schema/download'
import { makeDownloadQueueCore } from './queue'

const mk = (id: string): SaveRequest => ({
  id,
  url: `https://pbs.twimg.com/media/${id}.jpg?name=orig`,
  filename: `${id}.jpg`,
})

class LedgerWriteFailed extends Error {
  readonly _tag = 'LedgerWriteFailed'

  constructor(message = 'ledger write failed') {
    super(message)
  }
}

describe('DownloadQueue core', () => {
  it('saves every request and reports started/total', async () => {
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
    expect(res.started).toBe(2)
    expect(res.failed).toBe(0)
    expect(res.total).toBe(2)
    expect(saved.toSorted()).toEqual(['a.jpg', 'b.jpg'])
    expect(res.outcomes.map((o) => o.ok)).toEqual([true, true])
    expect(res.outcomes[0]).toMatchObject({
      id: 'a',
      ok: true,
      status: 'started',
      handle: { kind: 'browser', id: 1 },
    })
  })

  it('reports a per-request outcome for a failure (ok:false, no handle, WITH the reason)', async () => {
    const strategy: DownloadStrategy = {
      save: (req) =>
        req.id === 'b'
          ? Effect.fail(new DownloadError({ id: req.id, reason: 'nope' }))
          : Effect.succeed({ kind: 'browser', id: 1 }),
    }
    const queue = makeDownloadQueueCore({ strategy, concurrency: 2, retries: 0 })
    const res = await Effect.runPromise(queue.enqueue([mk('a'), mk('b')]))
    expect(res.started).toBe(1)
    expect(res.failed).toBe(1)
    const b = res.outcomes.find((o) => o.id === 'b')!
    // The DownloadError's own reason must survive into the outcome — previously
    // swallowed entirely by `Effect.orElseSucceed`, making every failure
    // indistinguishable ("why didn't this download?" was unanswerable).
    expect(b).toEqual({ id: 'b', ok: false, status: 'start-failed', error: 'nope' })
  })

  it('bounds strategy and post-start failure reasons for QueueUpdate', async () => {
    const reason = 'x'.repeat(MAX_FAILURE_REASON_LENGTH + 1)
    const queue = makeDownloadQueueCore({
      strategy: {
        save: (request) =>
          request.id === 'strategy'
            ? Effect.fail(new DownloadError({ id: request.id, reason }))
            : Effect.succeed({ kind: 'browser' as const, id: 7 }),
      },
      concurrency: 1,
      retries: 0,
      onStarted: () => Effect.fail(new LedgerWriteFailed(reason)),
    })

    const result = await Effect.runPromise(queue.enqueue([mk('strategy'), mk('post-start')]))
    const expected = boundedDiagnosticText(reason)

    expect(result.outcomes).toEqual([
      { id: 'strategy', ok: false, status: 'start-failed', error: expected },
      {
        id: 'post-start',
        ok: false,
        status: 'untracked-start',
        handle: { kind: 'browser', id: 7 },
        error: expected,
      },
    ])
    expect(expected).toHaveLength(MAX_FAILURE_REASON_LENGTH)
  })

  it('awaits the per-handle commit immediately after save', async () => {
    const events: string[] = []
    const strategy: DownloadStrategy = {
      save: (req) =>
        Effect.sync(() => {
          events.push(`save:${req.id}`)
          return { kind: 'browser' as const, id: req.id === 'a' ? 1 : 2 }
        }),
    }
    const queue = makeDownloadQueueCore({
      strategy,
      concurrency: 1,
      onStarted: (request, handle) =>
        Effect.sleep('5 millis').pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (handle.kind !== 'browser') throw new Error('expected browser handle')
              events.push(`commit:${request.id}:${handle.id}`)
            }),
          ),
        ),
    })

    const res = await Effect.runPromise(queue.enqueue([mk('a'), mk('b')]))

    expect(events).toEqual(['save:a', 'commit:a:1', 'save:b', 'commit:b:2'])
    expect(res.outcomes.map((outcome) => outcome.status)).toEqual(['started', 'started'])
  })

  it('does not retry save when the post-start commit fails', async () => {
    let saves = 0
    let commits = 0
    const strategy: DownloadStrategy = {
      save: () =>
        Effect.sync(() => {
          saves++
          return { kind: 'browser' as const, id: 77 }
        }),
    }
    const queue = makeDownloadQueueCore({
      strategy,
      concurrency: 1,
      retries: 3,
      retryBaseMs: 1,
      onStarted: () =>
        Effect.sync(() => {
          commits++
        }).pipe(Effect.andThen(Effect.fail(new LedgerWriteFailed()))),
    })

    const res = await Effect.runPromise(queue.enqueue([mk('a')]))

    expect(saves).toBe(1)
    expect(commits).toBe(1)
    expect(res).toMatchObject({ started: 0, failed: 1, total: 1 })
    expect(res.outcomes).toEqual([
      {
        id: 'a',
        ok: false,
        status: 'untracked-start',
        handle: { kind: 'browser', id: 77 },
        error: 'ledger write failed',
      },
    ])
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
    expect(res.started).toBe(1)
    expect(attempts).toBe(3)
  })

  it('does not retry an at-most-once aria2 start', async () => {
    let attempts = 0
    const strategy: DownloadStrategy = {
      save: (req) =>
        Effect.sync(() => {
          attempts++
        }).pipe(
          Effect.andThen(Effect.fail(new DownloadError({ id: req.id, reason: 'rpc ambiguous' }))),
        ),
    }
    const queue = makeDownloadQueueCore({
      strategy,
      concurrency: 1,
      retries: 3,
      retryBaseMs: 1,
      retryStart: () => false,
    })
    const result = await Effect.runPromise(queue.enqueue([mk('aria')]))
    expect(attempts).toBe(1)
    expect(result.outcomes).toEqual([
      { id: 'aria', ok: false, status: 'start-failed', error: 'rpc ambiguous' },
    ])
  })

  it('does not retry or misclassify an ambiguous browser handoff', async () => {
    let attempts = 0
    const strategy: DownloadStrategy = {
      save: (req) =>
        Effect.suspend(() => {
          attempts++
          return Effect.fail(
            new DownloadError({
              id: req.id,
              reason: 'browser reply lost',
              retryable: false,
              certainty: 'ambiguous-handoff',
            }),
          )
        }),
    }
    const queue = makeDownloadQueueCore({
      strategy,
      concurrency: 1,
      retries: 3,
      retryBaseMs: 1,
    })

    const result = await Effect.runPromise(queue.enqueue([mk('fetched')]))

    expect(attempts).toBe(1)
    expect(result.outcomes).toEqual([
      {
        id: 'fetched',
        ok: false,
        status: 'ambiguous-start',
        error: 'browser reply lost',
      },
    ])
  })

  it('arms once immediately before an at-most-once aria2 save', async () => {
    const events: string[] = []
    const queue = makeDownloadQueueCore({
      strategy: {
        save: () =>
          Effect.sync(() => {
            events.push('save')
            return { kind: 'aria2' as const, gid: '0000000000000001' }
          }),
      },
      concurrency: 1,
      retryStart: () => false,
      beforeStart: () =>
        Effect.sync(() => {
          events.push('arm')
        }),
    })
    await Effect.runPromise(queue.enqueue([mk('aria')]))
    expect(events).toEqual(['arm', 'save'])
  })

  it('does not save when the durable preflight fails', async () => {
    let saves = 0
    const queue = makeDownloadQueueCore({
      strategy: {
        save: () =>
          Effect.sync(() => {
            saves++
            return { kind: 'browser' as const, id: 1 }
          }),
      },
      concurrency: 1,
      beforeStart: (req) => Effect.fail(new DownloadError({ id: req.id, reason: 'arm failed' })),
    })
    const result = await Effect.runPromise(queue.enqueue([mk('aria')]))
    expect(saves).toBe(0)
    expect(result.outcomes).toEqual([
      { id: 'aria', ok: false, status: 'start-failed', error: 'arm failed' },
    ])
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

    expect(res.started).toBe(1)
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

    expect(res.started).toBe(0)
    expect(res.failed).toBe(1)
    // 1 initial try + recurs(3) retries (now spaced by exponential backoff).
    expect(attempts).toBe(4)
  })
})
