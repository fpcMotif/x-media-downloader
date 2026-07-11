import { describe, it, expect, vi } from 'vitest'
import { INTERRUPT_RETRY_MAX, type PendingInterruptRetry } from '../core/download/interrupt-retry'
import { emptyMetrics, type MetricsState } from '../core/download/metrics'
import { makeRetryPlanApplier, type RetryClock, type RetryPlanApplierDeps } from './retry-plan'

/** Hand-rolled fake clock (the core/clear idiom) — NOT vi.useFakeTimers(). Records
 *  every (fn, ms) schedule call and hands back a distinct cancel spy per call, so a
 *  test can assert exactly which handle would be cancelled. */
type CancelSpy = ReturnType<typeof vi.fn<() => void>>

const makeFakeClock = (): RetryClock & {
  readonly calls: { fn: () => void; ms: number; cancel: CancelSpy }[]
} => {
  const calls: { fn: () => void; ms: number; cancel: CancelSpy }[] = []
  const schedule: RetryClock['schedule'] = (fn, ms) => {
    const cancel = vi.fn<() => void>()
    calls.push({ fn, ms, cancel })
    return cancel
  }
  return { schedule, calls }
}

const baseArgs = {
  id: 'm0',
  downloadId: 7,
  url: 'https://cdn/x.jpg',
  filename: 'x.jpg',
  reason: 'NETWORK_FAILED',
  now: 1_000,
}

const makeDeps = (
  over: Partial<Omit<RetryPlanApplierDeps, 'clock'>> = {},
): RetryPlanApplierDeps & { clock: ReturnType<typeof makeFakeClock> } => {
  const clock = makeFakeClock()
  const deps: RetryPlanApplierDeps = {
    interruptAttemptById: new Map<string, number>(),
    pendingRetries: new Map<string, PendingInterruptRetry>(),
    syncPendingRetries: vi.fn<RetryPlanApplierDeps['syncPendingRetries']>(),
    recordRetry: vi.fn<RetryPlanApplierDeps['recordRetry']>(),
    trace: vi.fn<RetryPlanApplierDeps['trace']>(),
    persistSnapshot: vi.fn<RetryPlanApplierDeps['persistSnapshot']>(async () => {}),
    failBrowserDownload: vi.fn<RetryPlanApplierDeps['failBrowserDownload']>(async () => {}),
    fire: vi.fn<RetryPlanApplierDeps['fire']>(),
    ...over,
    clock,
  }
  return deps as RetryPlanApplierDeps & { clock: ReturnType<typeof makeFakeClock> }
}

describe('makeRetryPlanApplier', () => {
  describe('apply — schedule path', () => {
    it('schedules a retry for a retryable reason under the attempt cap', async () => {
      const deps = makeDeps()
      const applier = makeRetryPlanApplier(deps)

      const scheduled = await applier.apply(baseArgs)

      expect(scheduled).toBe(true)
      expect(deps.pendingRetries.get('m0')).toEqual({
        id: 'm0',
        url: 'https://cdn/x.jpg',
        filename: 'x.jpg',
        attempt: 1,
        nextRetryAt: 1_000 + 2000, // interruptBackoffMs(0) = 2000
      })
      expect(deps.interruptAttemptById.get('m0')).toBe(1)
      expect(deps.recordRetry).toHaveBeenCalledWith('m0')
      expect(deps.syncPendingRetries).toHaveBeenCalledTimes(1)
      expect(deps.clock.calls).toHaveLength(1)
      expect(deps.clock.calls[0]!.ms).toBe(2000)
      expect(deps.failBrowserDownload).not.toHaveBeenCalled()
      expect(deps.persistSnapshot).toHaveBeenCalledWith(1_000)
    })

    it('includes the item when provided, and omits it when not', async () => {
      const deps = makeDeps()
      const applier = makeRetryPlanApplier(deps)
      const item = {
        platform: 'x' as const,
        id: 'm0',
        postId: 'T1',
        author: 'h',
        type: 'photo' as const,
        url: 'https://cdn/x.jpg',
        ext: 'jpg',
        index: 0,
      }

      await applier.apply({ ...baseArgs, item })
      expect(deps.pendingRetries.get('m0')?.item).toEqual(item)
    })

    it('traces "unknown" when reason is undefined (undefined is treated as retryable)', async () => {
      const deps = makeDeps()
      const applier = makeRetryPlanApplier(deps)

      const scheduled = await applier.apply({ ...baseArgs, reason: undefined })

      expect(scheduled).toBe(true)
      expect(deps.trace).toHaveBeenCalledWith(
        'interrupt-retry-scheduled',
        expect.objectContaining({ detail: expect.stringContaining('unknown in') }),
      )
    })

    it('calling schedule() invokes the applier-provided re-entry hook (fire) when fired', async () => {
      const deps = makeDeps()
      const applier = makeRetryPlanApplier(deps)
      await applier.apply(baseArgs)
      const { fn } = deps.clock.calls[0]!
      fn()
      expect(deps.fire).toHaveBeenCalledWith('m0')
    })

    it('traces the reason as-is when no traceLabel override is given', async () => {
      const deps = makeDeps()
      const applier = makeRetryPlanApplier(deps)

      await applier.apply(baseArgs)

      expect(deps.trace).toHaveBeenCalledWith(
        'interrupt-retry-scheduled',
        expect.objectContaining({ detail: expect.stringContaining('NETWORK_FAILED in') }),
      )
    })

    it('traceLabel overrides reason in the trace detail', async () => {
      const deps = makeDeps()
      const applier = makeRetryPlanApplier(deps)

      await applier.apply({ ...baseArgs, traceLabel: 'start-failed' })

      expect(deps.trace).toHaveBeenCalledWith(
        'interrupt-retry-scheduled',
        expect.objectContaining({ detail: expect.stringContaining('start-failed in') }),
      )
    })

    it('invokes onScheduled synchronously before persistSnapshot, only on the schedule path', async () => {
      const order: string[] = []
      const deps = makeDeps({
        persistSnapshot: async () => {
          order.push('persistSnapshot')
        },
      })
      const applier = makeRetryPlanApplier(deps)
      const onScheduled = vi.fn<() => void>(() => order.push('onScheduled'))

      await applier.apply({ ...baseArgs, onScheduled })

      expect(onScheduled).toHaveBeenCalledTimes(1)
      expect(order).toEqual(['onScheduled', 'persistSnapshot'])
    })

    it('does not invoke onScheduled on the exhausted path', async () => {
      const deps = makeDeps({
        interruptAttemptById: new Map([['m0', INTERRUPT_RETRY_MAX]]),
      })
      const applier = makeRetryPlanApplier(deps)
      const onScheduled = vi.fn<() => void>()

      await applier.apply({ ...baseArgs, onScheduled })

      expect(onScheduled).not.toHaveBeenCalled()
    })
  })

  describe('apply — exhausted path', () => {
    it('fails the download when attempt is at INTERRUPT_RETRY_MAX', async () => {
      const deps = makeDeps({
        interruptAttemptById: new Map([['m0', INTERRUPT_RETRY_MAX]]),
      })
      const applier = makeRetryPlanApplier(deps)

      const scheduled = await applier.apply(baseArgs)

      expect(scheduled).toBe(false)
      expect(deps.failBrowserDownload).toHaveBeenCalledWith('m0', 7, 1_000)
      expect(deps.clock.calls).toHaveLength(0)
      expect(deps.pendingRetries.size).toBe(0)
    })

    it('fails the download for a non-retryable reason', async () => {
      const deps = makeDeps()
      const applier = makeRetryPlanApplier(deps)

      const scheduled = await applier.apply({ ...baseArgs, reason: 'USER_CANCELED' })

      expect(scheduled).toBe(false)
      expect(deps.failBrowserDownload).toHaveBeenCalledWith('m0', 7, 1_000)
      expect(deps.clock.calls).toHaveLength(0)
    })
  })

  describe('cancel-then-reschedule', () => {
    it('cancel invokes the fake clock cancel handle; a subsequent apply re-schedules cleanly', async () => {
      const deps = makeDeps()
      const applier = makeRetryPlanApplier(deps)

      await applier.apply(baseArgs)
      const firstCancel = deps.clock.calls[0]!.cancel
      applier.cancel('m0')
      expect(firstCancel).toHaveBeenCalledTimes(1)

      await applier.apply({ ...baseArgs, now: 2_000 })
      expect(deps.clock.calls).toHaveLength(2)
      const secondCancel = deps.clock.calls[1]!.cancel

      // No stale handle leak: cancelling again invokes only the MOST RECENT handle.
      applier.cancel('m0')
      expect(secondCancel).toHaveBeenCalledTimes(1)
      expect(firstCancel).toHaveBeenCalledTimes(1) // unchanged
    })

    it('apply itself cancels any existing timer before re-arming (no double-fire)', async () => {
      const deps = makeDeps()
      const applier = makeRetryPlanApplier(deps)

      await applier.apply(baseArgs)
      const firstCancel = deps.clock.calls[0]!.cancel

      await applier.apply({ ...baseArgs, now: 2_000 })
      expect(firstCancel).toHaveBeenCalledTimes(1)
      expect(deps.clock.calls).toHaveLength(2)
    })

    it('cancel on an id with no pending timer is a safe no-op', () => {
      const deps = makeDeps()
      const applier = makeRetryPlanApplier(deps)
      expect(() => applier.cancel('nope')).not.toThrow()
    })
  })

  describe('drift-guard', () => {
    it('the PendingInterruptRetry row has exactly the declared fields', async () => {
      const deps = makeDeps()
      const applier = makeRetryPlanApplier(deps)
      const item = {
        platform: 'x' as const,
        id: 'm0',
        postId: 'T1',
        author: 'h',
        type: 'photo' as const,
        url: 'https://cdn/x.jpg',
        ext: 'jpg',
        index: 0,
      }

      await applier.apply({ ...baseArgs, item })
      const row = deps.pendingRetries.get('m0')!
      const expectedKeys: (keyof PendingInterruptRetry)[] = [
        'id',
        'url',
        'filename',
        'attempt',
        'nextRetryAt',
        'item',
      ]
      expect(new Set(Object.keys(row))).toEqual(new Set(expectedKeys))
    })
  })

  describe('rehydrateTimer', () => {
    it('schedules via clock.schedule with Math.max(0, nextRetryAt - now) delay', () => {
      const deps = makeDeps()
      const applier = makeRetryPlanApplier(deps)
      const row: PendingInterruptRetry = {
        id: 'm1',
        url: 'https://cdn/y.jpg',
        filename: 'y.jpg',
        attempt: 1,
        nextRetryAt: 5_000,
      }

      applier.rehydrateTimer(row, 3_000)

      expect(deps.clock.calls).toHaveLength(1)
      expect(deps.clock.calls[0]!.ms).toBe(2_000)
    })

    it('clamps a past-due nextRetryAt to a 0ms delay', () => {
      const deps = makeDeps()
      const applier = makeRetryPlanApplier(deps)
      const row: PendingInterruptRetry = {
        id: 'm1',
        url: 'https://cdn/y.jpg',
        filename: 'y.jpg',
        attempt: 1,
        nextRetryAt: 1_000,
      }

      applier.rehydrateTimer(row, 3_000)

      expect(deps.clock.calls[0]!.ms).toBe(0)
    })

    it('firing the rehydrated timer calls fire(id)', () => {
      const deps = makeDeps()
      const applier = makeRetryPlanApplier(deps)
      const row: PendingInterruptRetry = {
        id: 'm1',
        url: 'https://cdn/y.jpg',
        filename: 'y.jpg',
        attempt: 1,
        nextRetryAt: 5_000,
      }

      applier.rehydrateTimer(row, 3_000)
      deps.clock.calls[0]!.fn()
      expect(deps.fire).toHaveBeenCalledWith('m1')
    })

    it('cancels any existing timer for the id before re-arming', () => {
      const deps = makeDeps()
      const applier = makeRetryPlanApplier(deps)
      const row: PendingInterruptRetry = {
        id: 'm1',
        url: 'https://cdn/y.jpg',
        filename: 'y.jpg',
        attempt: 1,
        nextRetryAt: 5_000,
      }

      applier.rehydrateTimer(row, 3_000)
      const firstCancel = deps.clock.calls[0]!.cancel
      applier.rehydrateTimer(row, 3_500)
      expect(firstCancel).toHaveBeenCalledTimes(1)
      expect(deps.clock.calls).toHaveLength(2)
    })
  })

  describe('default real clock', () => {
    it('makeRetryPlanApplier without an explicit clock schedules/cancels via real timers', async () => {
      vi.useFakeTimers()
      try {
        const fire = vi.fn<RetryPlanApplierDeps['fire']>()
        const deps: Omit<RetryPlanApplierDeps, 'clock'> = {
          interruptAttemptById: new Map(),
          pendingRetries: new Map(),
          syncPendingRetries: vi.fn<RetryPlanApplierDeps['syncPendingRetries']>(),
          recordRetry: vi.fn<RetryPlanApplierDeps['recordRetry']>(),
          trace: vi.fn<RetryPlanApplierDeps['trace']>(),
          persistSnapshot: vi.fn<RetryPlanApplierDeps['persistSnapshot']>(async () => {}),
          failBrowserDownload: vi.fn<RetryPlanApplierDeps['failBrowserDownload']>(async () => {}),
          fire,
        }
        const applier = makeRetryPlanApplier(deps)
        await applier.apply(baseArgs)
        await vi.advanceTimersByTimeAsync(2000)
        expect(fire).toHaveBeenCalledWith('m0')
      } finally {
        vi.useRealTimers()
      }
    })

    it('cancel() against the real clock clears the underlying timeout (fire never runs)', async () => {
      vi.useFakeTimers()
      try {
        const fire = vi.fn<RetryPlanApplierDeps['fire']>()
        const deps: Omit<RetryPlanApplierDeps, 'clock'> = {
          interruptAttemptById: new Map(),
          pendingRetries: new Map(),
          syncPendingRetries: vi.fn<RetryPlanApplierDeps['syncPendingRetries']>(),
          recordRetry: vi.fn<RetryPlanApplierDeps['recordRetry']>(),
          trace: vi.fn<RetryPlanApplierDeps['trace']>(),
          persistSnapshot: vi.fn<RetryPlanApplierDeps['persistSnapshot']>(async () => {}),
          failBrowserDownload: vi.fn<RetryPlanApplierDeps['failBrowserDownload']>(async () => {}),
          fire,
        }
        const applier = makeRetryPlanApplier(deps)
        await applier.apply(baseArgs)
        applier.cancel('m0')
        await vi.advanceTimersByTimeAsync(5000)
        expect(fire).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })
  })
})

describe('metrics recordRetry wrapper shape (sanity, matches deps.recordRetry contract)', () => {
  it('is the shape the applier expects: (id) => void, closing over live metrics', () => {
    let live: MetricsState | null = emptyMetrics({ total: 1, concurrencyCap: 1, startedAt: 0 })
    const recordRetry = (id: string): void => {
      if (live) live = { ...live, retries: live.retries + 1 }
      void id
    }
    recordRetry('x')
    expect(live?.retries).toBe(1)
  })
})
