import { describe, it, expect, vi } from 'vitest'
import { makeSerialQueue } from './serial-queue'

const deferred = <T = void>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// Flush the micro/macrotask queues so the promise chain settles.
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('makeSerialQueue', () => {
  it('runs pushed tasks in FIFO order', async () => {
    const log: number[] = []
    const q = makeSerialQueue()
    q.push(async () => void log.push(1))
    q.push(async () => void log.push(2))
    q.push(async () => void log.push(3))
    await tick()
    expect(log).toEqual([1, 2, 3])
  })

  it('serializes tasks: a task starts only after the previous one settles', async () => {
    const log: string[] = []
    const a = deferred()
    const q = makeSerialQueue()
    q.push(async () => {
      log.push('A:start')
      await a.promise
      log.push('A:end')
    })
    q.push(async () => void log.push('B:start'))
    await tick()
    // B must not start while A is still pending.
    expect(log).toEqual(['A:start'])
    a.resolve()
    await tick()
    expect(log).toEqual(['A:start', 'A:end', 'B:start'])
  })

  it('routes a rejected pushed task to onError', async () => {
    const onError = vi.fn<(error: unknown) => void>()
    const q = makeSerialQueue(onError)
    const err = new Error('boom')
    q.push(async () => {
      throw err
    })
    await tick()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(err)
  })

  it('without onError, a rejected task is swallowed and the chain is not poisoned', async () => {
    const log: number[] = []
    const q = makeSerialQueue()
    q.push(async () => {
      throw new Error('silent')
    })
    q.push(async () => void log.push(1))
    await tick()
    expect(log).toEqual([1])
  })

  it('a throwing onError cannot poison the chain', async () => {
    const log: number[] = []
    const q = makeSerialQueue(() => {
      throw new Error('observer blew up')
    })
    q.push(async () => {
      throw new Error('boom')
    })
    q.push(async () => void log.push(1))
    await tick()
    expect(log).toEqual([1])
  })

  it('run resolves with the task value', async () => {
    const q = makeSerialQueue()
    await expect(q.run(async () => 42)).resolves.toBe(42)
  })

  it('run rejects to the caller, still observes via onError, and the chain survives', async () => {
    const onError = vi.fn<(error: unknown) => void>()
    const log: number[] = []
    const q = makeSerialQueue(onError)
    const err = new Error('nope')
    await expect(q.run(async () => Promise.reject(err))).rejects.toBe(err)
    q.push(async () => void log.push(1))
    await tick()
    expect(onError).toHaveBeenCalledWith(err)
    expect(log).toEqual([1])
  })

  it('preserves ordering across run and push', async () => {
    const log: string[] = []
    const a = deferred()
    const q = makeSerialQueue()
    q.push(async () => {
      log.push('p1:start')
      await a.promise
      log.push('p1:end')
    })
    const r = q.run(async () => {
      log.push('r2')
      return 'ok'
    })
    await tick()
    // r2 waits behind the still-pending p1.
    expect(log).toEqual(['p1:start'])
    a.resolve()
    await expect(r).resolves.toBe('ok')
    expect(log).toEqual(['p1:start', 'p1:end', 'r2'])
  })

  it('run: dropping the returned promise of a rejecting task still observes and survives', async () => {
    const onError = vi.fn<(error: unknown) => void>()
    const log: number[] = []
    const q = makeSerialQueue(onError)
    const err = new Error('dropped')
    // Fire-and-forget misuse of run: ignore the returned (rejecting) promise.
    void q.run(async () => Promise.reject(err))
    q.push(async () => void log.push(1))
    await tick()
    expect(onError).toHaveBeenCalledWith(err)
    expect(log).toEqual([1])
  })

  it('enqueues re-entrant tasks at the current tail (FIFO by enqueue time)', async () => {
    const log: string[] = []
    const q = makeSerialQueue()
    q.push(async () => {
      log.push('outer:start')
      q.push(async () => void log.push('inner'))
      log.push('outer:end')
    })
    q.push(async () => void log.push('after'))
    await tick()
    expect(log).toEqual(['outer:start', 'outer:end', 'after', 'inner'])
  })

  it('routes a synchronous throw inside a pushed task to onError and survives', async () => {
    const onError = vi.fn<(error: unknown) => void>()
    const log: number[] = []
    const q = makeSerialQueue(onError)
    const err = new Error('sync-throw')
    q.push(() => {
      throw err
    })
    q.push(async () => void log.push(1))
    await tick()
    expect(onError).toHaveBeenCalledWith(err)
    expect(log).toEqual([1])
  })

  it('run: a synchronous throw rejects to the caller', async () => {
    const q = makeSerialQueue()
    const err = new Error('run-sync-throw')
    await expect(
      q.run(() => {
        throw err
      }),
    ).rejects.toBe(err)
  })
})
