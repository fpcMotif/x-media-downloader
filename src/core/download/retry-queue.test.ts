import { describe, it, expect, vi } from 'vitest'
import type { PendingInterruptRetry } from './interrupt-retry'
import {
  makeRetryQueue,
  type ApplyRetryPlanArgs,
  type RetryClock,
  type RetryQueueDeps,
  type RetryQueueStore,
} from './retry-queue'

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

/** In-memory durable mirror. `set` is a spy so a test can assert how many times the
 *  queue re-mirrored; `current` reads back the last-written rows. */
const makeStore = (): RetryQueueStore & {
  readonly set: ReturnType<typeof vi.fn<(rows: ReadonlyArray<PendingInterruptRetry>) => void>>
  readonly current: () => ReadonlyArray<PendingInterruptRetry>
} => {
  let rows: ReadonlyArray<PendingInterruptRetry> = []
  const set = vi.fn<(next: ReadonlyArray<PendingInterruptRetry>) => void>((next) => {
    rows = next
  })
  return { get: async () => rows, set, current: () => rows }
}

const baseArgs: ApplyRetryPlanArgs = {
  id: 'm0',
  downloadId: 7,
  url: 'https://cdn/x.jpg',
  filename: 'x.jpg',
  reason: 'NETWORK_FAILED',
  now: 1_000,
}

const makeDeps = (
  over: Partial<Omit<RetryQueueDeps, 'clock' | 'store'>> = {},
): {
  deps: RetryQueueDeps
  clock: ReturnType<typeof makeFakeClock>
  store: ReturnType<typeof makeStore>
} => {
  const clock = makeFakeClock()
  const store = makeStore()
  const deps: RetryQueueDeps = {
    store,
    clock,
    recordRetry: vi.fn<RetryQueueDeps['recordRetry']>(),
    trace: vi.fn<RetryQueueDeps['trace']>(),
    persistSnapshot: vi.fn<RetryQueueDeps['persistSnapshot']>(async () => {}),
    failBrowserDownload: vi.fn<RetryQueueDeps['failBrowserDownload']>(async () => {}),
    fire: vi.fn<RetryQueueDeps['fire']>(),
    ...over,
  }
  return { deps, clock, store }
}

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

describe('makeRetryQueue', () => {
  describe('schedule — schedule path', () => {
    it('schedules a retry for a retryable reason under the attempt cap', async () => {
      const { deps, clock, store } = makeDeps()
      const queue = makeRetryQueue(deps)

      const scheduled = await queue.schedule(baseArgs)

      expect(scheduled).toBe(true)
      expect(queue.has('m0')).toBe(true)
      expect(store.current()).toEqual([
        {
          id: 'm0',
          url: 'https://cdn/x.jpg',
          filename: 'x.jpg',
          attempt: 1,
          nextRetryAt: 1_000 + 2000, // interruptBackoffMs(0) = 2000
        },
      ])
      expect(deps.recordRetry).toHaveBeenCalledWith('m0')
      expect(store.set).toHaveBeenCalledTimes(1)
      expect(clock.calls).toHaveLength(1)
      expect(clock.calls[0]!.ms).toBe(2000)
      expect(deps.failBrowserDownload).not.toHaveBeenCalled()
      expect(deps.persistSnapshot).toHaveBeenCalledWith(1_000)
    })

    it('includes the item when provided', async () => {
      const { deps, store } = makeDeps()
      const queue = makeRetryQueue(deps)

      await queue.schedule({ ...baseArgs, item })
      expect(store.current()[0]?.item).toEqual(item)
    })

    it('traces "unknown" when reason is undefined (undefined is treated as retryable)', async () => {
      const { deps } = makeDeps()
      const queue = makeRetryQueue(deps)

      const scheduled = await queue.schedule({ ...baseArgs, reason: undefined })

      expect(scheduled).toBe(true)
      expect(deps.trace).toHaveBeenCalledWith(
        'interrupt-retry-scheduled',
        expect.objectContaining({ detail: expect.stringContaining('unknown in') }),
      )
    })

    it('firing the armed timer invokes the re-entry hook (fire)', async () => {
      const { deps, clock } = makeDeps()
      const queue = makeRetryQueue(deps)
      await queue.schedule(baseArgs)
      clock.calls[0]!.fn()
      expect(deps.fire).toHaveBeenCalledWith('m0')
    })

    it('traces the reason as-is when no traceLabel override is given', async () => {
      const { deps } = makeDeps()
      const queue = makeRetryQueue(deps)

      await queue.schedule(baseArgs)

      expect(deps.trace).toHaveBeenCalledWith(
        'interrupt-retry-scheduled',
        expect.objectContaining({ detail: expect.stringContaining('NETWORK_FAILED in') }),
      )
    })

    it('traceLabel overrides reason in the trace detail', async () => {
      const { deps } = makeDeps()
      const queue = makeRetryQueue(deps)

      await queue.schedule({ ...baseArgs, traceLabel: 'start-failed' })

      expect(deps.trace).toHaveBeenCalledWith(
        'interrupt-retry-scheduled',
        expect.objectContaining({ detail: expect.stringContaining('start-failed in') }),
      )
    })

    it('invokes onScheduled synchronously before persistSnapshot, only on the schedule path', async () => {
      const order: string[] = []
      const { deps } = makeDeps({
        persistSnapshot: async () => {
          order.push('persistSnapshot')
        },
      })
      const queue = makeRetryQueue(deps)
      const onScheduled = vi.fn<() => void>(() => order.push('onScheduled'))

      await queue.schedule({ ...baseArgs, onScheduled })

      expect(onScheduled).toHaveBeenCalledTimes(1)
      expect(order).toEqual(['onScheduled', 'persistSnapshot'])
    })

    it('does not invoke onScheduled on the exhausted path', async () => {
      const { deps } = makeDeps()
      const queue = makeRetryQueue(deps)
      // Three successful schedules raise the counter to the cap (attempts 1, 2, 3).
      await queue.schedule({ ...baseArgs, now: 1_000 })
      await queue.schedule({ ...baseArgs, now: 2_000 })
      await queue.schedule({ ...baseArgs, now: 3_000 })
      const onScheduled = vi.fn<() => void>()

      await queue.schedule({ ...baseArgs, now: 4_000, onScheduled })

      expect(onScheduled).not.toHaveBeenCalled()
    })
  })

  describe('schedule — exhausted path', () => {
    it('fails the download once the attempt counter reaches INTERRUPT_RETRY_MAX', async () => {
      const { deps, clock } = makeDeps()
      const queue = makeRetryQueue(deps)
      // Raise the counter to the cap through the public interface.
      await queue.schedule({ ...baseArgs, now: 1_000 })
      await queue.schedule({ ...baseArgs, now: 2_000 })
      await queue.schedule({ ...baseArgs, now: 3_000 })
      expect(clock.calls).toHaveLength(3)

      const scheduled = await queue.schedule({ ...baseArgs, downloadId: 7, now: 4_000 })

      expect(scheduled).toBe(false)
      expect(deps.failBrowserDownload).toHaveBeenCalledWith('m0', 7, 4_000)
      expect(clock.calls).toHaveLength(3) // no new timer armed
    })

    it('fails the download for a non-retryable reason', async () => {
      const { deps, clock } = makeDeps()
      const queue = makeRetryQueue(deps)

      const scheduled = await queue.schedule({ ...baseArgs, reason: 'USER_CANCELED' })

      expect(scheduled).toBe(false)
      expect(deps.failBrowserDownload).toHaveBeenCalledWith('m0', 7, 1_000)
      expect(clock.calls).toHaveLength(0)
    })
  })

  describe('drop / re-schedule', () => {
    it('drop invokes the fake clock cancel handle; a subsequent schedule re-arms cleanly', async () => {
      const { deps, clock } = makeDeps()
      const queue = makeRetryQueue(deps)

      await queue.schedule(baseArgs)
      const firstCancel = clock.calls[0]!.cancel
      queue.drop('m0')
      expect(firstCancel).toHaveBeenCalledTimes(1)

      await queue.schedule({ ...baseArgs, now: 2_000 })
      expect(clock.calls).toHaveLength(2)
      const secondCancel = clock.calls[1]!.cancel

      // No stale handle leak: dropping again invokes only the MOST RECENT handle.
      queue.drop('m0')
      expect(secondCancel).toHaveBeenCalledTimes(1)
      expect(firstCancel).toHaveBeenCalledTimes(1) // unchanged
    })

    it('schedule itself cancels any existing timer before re-arming (no double-fire)', async () => {
      const { deps, clock } = makeDeps()
      const queue = makeRetryQueue(deps)

      await queue.schedule(baseArgs)
      const firstCancel = clock.calls[0]!.cancel

      await queue.schedule({ ...baseArgs, now: 2_000 })
      expect(firstCancel).toHaveBeenCalledTimes(1)
      expect(clock.calls).toHaveLength(2)
    })

    it('drop on an id with no pending timer is a safe no-op', () => {
      const { deps } = makeDeps()
      const queue = makeRetryQueue(deps)
      expect(() => queue.drop('nope')).not.toThrow()
    })

    it('drop keeps the attempt counter — a re-schedule resumes from the preserved attempt', async () => {
      const { deps, clock } = makeDeps()
      const queue = makeRetryQueue(deps)

      await queue.schedule(baseArgs) // attempt 0 → 1, delay 2000
      expect(clock.calls[0]!.ms).toBe(2000)
      queue.drop('m0') // KEEPS attempt = 1
      await queue.schedule({ ...baseArgs, now: 2_000 }) // attempt 1 → 2, delay 4000

      expect(clock.calls).toHaveLength(2)
      expect(clock.calls[1]!.ms).toBe(4000)
    })

    it('forget resets the attempt counter — a re-schedule starts from attempt 0', async () => {
      const { deps, clock } = makeDeps()
      const queue = makeRetryQueue(deps)

      await queue.schedule(baseArgs) // attempt 0 → 1, delay 2000
      const firstCancel = clock.calls[0]!.cancel
      queue.forget('m0')
      expect(firstCancel).toHaveBeenCalledTimes(1)
      await queue.schedule({ ...baseArgs, now: 2_000 }) // attempt 0 → 1 again, delay 2000

      expect(clock.calls[1]!.ms).toBe(2000)
    })
  })

  describe('has / ownedIds', () => {
    it('reflect schedule, drop, and forget', async () => {
      const { deps } = makeDeps()
      const queue = makeRetryQueue(deps)

      expect(queue.has('m0')).toBe(false)
      expect(queue.ownedIds().size).toBe(0)

      await queue.schedule(baseArgs)
      expect(queue.has('m0')).toBe(true)
      expect([...queue.ownedIds()]).toEqual(['m0'])

      queue.drop('m0')
      expect(queue.has('m0')).toBe(false)
      expect(queue.ownedIds().size).toBe(0)

      await queue.schedule(baseArgs)
      queue.forget('m0')
      expect(queue.has('m0')).toBe(false)
      expect(queue.ownedIds().size).toBe(0)
    })
  })

  describe('drift-guard', () => {
    it('the PendingInterruptRetry row has exactly the declared fields', async () => {
      const { deps, store } = makeDeps()
      const queue = makeRetryQueue(deps)

      await queue.schedule({ ...baseArgs, item })
      const row = store.current()[0]!
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

  describe('rehydrate', () => {
    it('restores rows, arms their timers with Math.max(0, nextRetryAt - now), and returns the rows', async () => {
      const { deps, clock, store } = makeDeps()
      const rows: PendingInterruptRetry[] = [
        { id: 'a', url: 'https://cdn/a.jpg', filename: 'a.jpg', attempt: 1, nextRetryAt: 5_000 },
        { id: 'b', url: 'https://cdn/b.jpg', filename: 'b.jpg', attempt: 2, nextRetryAt: 4_000 },
      ]
      store.set(rows)
      const queue = makeRetryQueue(deps)

      const returned = await queue.rehydrate(3_000)

      expect(returned).toEqual(rows)
      expect(queue.has('a')).toBe(true)
      expect(queue.has('b')).toBe(true)
      expect(clock.calls[0]!.ms).toBe(2_000) // a: 5000 - 3000
      expect(clock.calls[1]!.ms).toBe(1_000) // b: 4000 - 3000
    })

    it('clamps a past-due nextRetryAt to a 0ms delay', async () => {
      const { deps, clock, store } = makeDeps()
      store.set([
        { id: 'm1', url: 'https://cdn/y.jpg', filename: 'y.jpg', attempt: 1, nextRetryAt: 1_000 },
      ])
      const queue = makeRetryQueue(deps)

      await queue.rehydrate(3_000)

      expect(clock.calls[0]!.ms).toBe(0)
    })

    it('firing a rehydrated timer calls fire(id)', async () => {
      const { deps, clock, store } = makeDeps()
      store.set([
        { id: 'm1', url: 'https://cdn/y.jpg', filename: 'y.jpg', attempt: 1, nextRetryAt: 5_000 },
      ])
      const queue = makeRetryQueue(deps)

      await queue.rehydrate(3_000)
      clock.calls[0]!.fn()
      expect(deps.fire).toHaveBeenCalledWith('m1')
    })

    it('a rehydrated row resumes its attempt counter — a schedule advances from it', async () => {
      const { deps, clock, store } = makeDeps()
      store.set([
        { id: 'm1', url: 'https://cdn/y.jpg', filename: 'y.jpg', attempt: 1, nextRetryAt: 5_000 },
      ])
      const queue = makeRetryQueue(deps)
      await queue.rehydrate(3_000) // restores attempt = 1, arms 2000ms timer (calls[0])

      await queue.schedule({
        id: 'm1',
        downloadId: 7,
        url: 'https://cdn/y.jpg',
        filename: 'y.jpg',
        reason: 'NETWORK_FAILED',
        now: 6_000,
      })

      // attempt 1 → 2 ⇒ interruptBackoffMs(1) = 4000, proving the counter survived rehydrate.
      expect(clock.calls[1]!.ms).toBe(4000)
    })

    it('re-arms (cancelling the prior timer) when the same id is rehydrated twice', async () => {
      const { deps, clock, store } = makeDeps()
      store.set([
        { id: 'm1', url: 'https://cdn/y.jpg', filename: 'y.jpg', attempt: 1, nextRetryAt: 5_000 },
      ])
      const queue = makeRetryQueue(deps)

      await queue.rehydrate(3_000)
      const firstCancel = clock.calls[0]!.cancel
      await queue.rehydrate(3_500)

      expect(firstCancel).toHaveBeenCalledTimes(1)
      expect(clock.calls).toHaveLength(2)
    })
  })

  describe('cancelAll', () => {
    it('cancels every armed timer, empties the store, and forgets every id', async () => {
      const { deps, clock, store } = makeDeps()
      const queue = makeRetryQueue(deps)
      await queue.schedule(baseArgs)
      await queue.schedule({ ...baseArgs, id: 'm1' })
      const cancels = clock.calls.map((c) => c.cancel)

      queue.cancelAll()

      for (const c of cancels) expect(c).toHaveBeenCalledTimes(1)
      expect(store.current()).toEqual([])
      expect(queue.has('m0')).toBe(false)
      expect(queue.has('m1')).toBe(false)
      expect(queue.ownedIds().size).toBe(0)
    })
  })

  describe('default real clock', () => {
    it('makeRetryQueue without an explicit clock schedules via real timers', async () => {
      vi.useFakeTimers()
      try {
        const fire = vi.fn<RetryQueueDeps['fire']>()
        const store = makeStore()
        const deps: Omit<RetryQueueDeps, 'clock'> = {
          store,
          recordRetry: vi.fn<RetryQueueDeps['recordRetry']>(),
          trace: vi.fn<RetryQueueDeps['trace']>(),
          persistSnapshot: vi.fn<RetryQueueDeps['persistSnapshot']>(async () => {}),
          failBrowserDownload: vi.fn<RetryQueueDeps['failBrowserDownload']>(async () => {}),
          fire,
        }
        const queue = makeRetryQueue(deps)
        await queue.schedule(baseArgs)
        await vi.advanceTimersByTimeAsync(2000)
        expect(fire).toHaveBeenCalledWith('m0')
      } finally {
        vi.useRealTimers()
      }
    })

    it('drop() against the real clock clears the underlying timeout (fire never runs)', async () => {
      vi.useFakeTimers()
      try {
        const fire = vi.fn<RetryQueueDeps['fire']>()
        const store = makeStore()
        const deps: Omit<RetryQueueDeps, 'clock'> = {
          store,
          recordRetry: vi.fn<RetryQueueDeps['recordRetry']>(),
          trace: vi.fn<RetryQueueDeps['trace']>(),
          persistSnapshot: vi.fn<RetryQueueDeps['persistSnapshot']>(async () => {}),
          failBrowserDownload: vi.fn<RetryQueueDeps['failBrowserDownload']>(async () => {}),
          fire,
        }
        const queue = makeRetryQueue(deps)
        await queue.schedule(baseArgs)
        queue.drop('m0')
        await vi.advanceTimersByTimeAsync(5000)
        expect(fire).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
