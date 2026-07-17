import { describe, it, expect } from 'vitest'
import { makeSavedStatusLifecycle } from './saved-status-lifecycle'

interface FakeObserver {
  readonly notify: () => void
  observed: number
  disconnected: number
}

const makeHarness = (initialActive: boolean) => {
  let active = initialActive
  const timers: { run: () => void; cancelled: boolean; fired: boolean }[] = []
  const observers: { notify: () => void; observed: number; disconnected: number }[] = []
  const deferred: { resolve: () => void; reject: (e: unknown) => void }[] = []
  let sweeps = 0

  const lifecycle = makeSavedStatusLifecycle({
    isActive: () => active,
    root: {} as Node,
    delayMs: 500,
    makeObserver: (notify) => {
      const o: FakeObserver = { notify, observed: 0, disconnected: 0 }
      observers.push(o)
      return {
        observe: () => {
          o.observed += 1
        },
        disconnect: () => {
          o.disconnected += 1
        },
      }
    },
    clock: {
      after: (_ms, run) => {
        const t = {
          run: () => {
            t.fired = true
            run()
          },
          cancelled: false,
          fired: false,
        }
        timers.push(t)
        return () => {
          t.cancelled = true
        }
      },
    },
    sweep: () => {
      sweeps += 1
      return new Promise<void>((resolve, reject) => deferred.push({ resolve, reject }))
    },
  })

  return {
    lifecycle,
    timers,
    observers,
    deferred,
    setActive: (v: boolean) => {
      active = v
    },
    sweeps: () => sweeps,
  }
}

const flushTimer = (timers: { run: () => void; cancelled: boolean; fired: boolean }[]): void => {
  const t = timers.findLast((x) => !x.cancelled && !x.fired)
  t?.run()
}

const pendingTimers = (timers: { cancelled: boolean; fired: boolean }[]): number =>
  timers.filter((t) => !t.cancelled && !t.fired).length

describe('makeSavedStatusLifecycle', () => {
  it('inactive sync creates no observer and no timer', () => {
    const h = makeHarness(false)
    h.lifecycle.sync()
    expect(h.observers).toHaveLength(0)
    expect(h.timers).toHaveLength(0)
  })

  it('active sync creates exactly one observer and schedules a first paint', () => {
    const h = makeHarness(true)
    h.lifecycle.sync()
    h.lifecycle.sync() // idempotent: still one observer
    expect(h.observers).toHaveLength(1)
    expect(h.observers[0]?.observed).toBe(1)
    expect(pendingTimers(h.timers)).toBe(1)
  })

  it('active → inactive transition disconnects and cancels', () => {
    const h = makeHarness(true)
    h.lifecycle.sync()
    h.setActive(false)
    h.lifecycle.sync()
    expect(h.observers[0]?.disconnected).toBe(1)
    expect(pendingTimers(h.timers)).toBe(0)
    // Coming back active builds a fresh observer
    h.setActive(true)
    h.lifecycle.sync()
    expect(h.observers).toHaveLength(2)
  })

  it('observer notify schedules a debounced sweep; re-notify replaces the pending timer', async () => {
    const h = makeHarness(true)
    h.lifecycle.sync()
    flushTimer(h.timers) // consume the initial paint's timer
    expect(h.sweeps()).toBe(1)
    h.deferred[0]?.resolve()
    await Promise.resolve()
    await Promise.resolve()
    h.observers[0]?.notify()
    h.observers[0]?.notify()
    expect(pendingTimers(h.timers)).toBe(1)
  })

  it('a mutation during a running sweep causes one later rerun, never overlap', async () => {
    const h = makeHarness(true)
    h.lifecycle.sync()
    flushTimer(h.timers)
    expect(h.sweeps()).toBe(1)
    // Mutations while the first sweep's request is in flight: mark rerun only.
    h.observers[0]?.notify()
    h.observers[0]?.notify()
    expect(h.sweeps()).toBe(1)
    h.deferred[0]?.resolve()
    await Promise.resolve()
    await Promise.resolve()
    // One rerun was debounced, not started immediately.
    expect(h.sweeps()).toBe(1)
    flushTimer(h.timers)
    expect(h.sweeps()).toBe(2)
    h.deferred[1]?.resolve()
    await Promise.resolve()
    await Promise.resolve()
    // No further rerun was requested: nothing else queued.
    expect(pendingTimers(h.timers)).toBe(0)
  })

  it('inactivity during a running sweep drops the requested rerun', async () => {
    const h = makeHarness(true)
    h.lifecycle.sync()
    flushTimer(h.timers)
    h.observers[0]?.notify()
    h.setActive(false)
    h.lifecycle.sync() // disconnect + cancel + clear rerun
    h.deferred[0]?.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(h.sweeps()).toBe(1)
    expect(pendingTimers(h.timers)).toBe(0)
  })

  it('dispose blocks pending timers and in-flight rearming', async () => {
    const h = makeHarness(true)
    h.lifecycle.sync()
    flushTimer(h.timers)
    h.observers[0]?.notify()
    h.lifecycle.dispose()
    expect(h.observers[0]?.disconnected).toBe(1)
    h.deferred[0]?.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(h.sweeps()).toBe(1)
    h.lifecycle.sync()
    h.lifecycle.schedule()
    expect(h.observers).toHaveLength(1)
    expect(pendingTimers(h.timers)).toBe(0)
  })

  it('a rejecting sweep still settles running state and allows later work', async () => {
    const h = makeHarness(true)
    h.lifecycle.sync()
    flushTimer(h.timers)
    expect(h.sweeps()).toBe(1)
    h.deferred[0]?.reject(new Error('network'))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    h.observers[0]?.notify()
    flushTimer(h.timers)
    expect(h.sweeps()).toBe(2)
    h.deferred[1]?.resolve()
    await Promise.resolve()
  })

  it('a disposed lifecycle never sweeps again', async () => {
    const h = makeHarness(true)
    h.lifecycle.sync()
    h.lifecycle.dispose()
    flushTimer(h.timers)
    await Promise.resolve()
    expect(h.sweeps()).toBe(0)
  })
})
