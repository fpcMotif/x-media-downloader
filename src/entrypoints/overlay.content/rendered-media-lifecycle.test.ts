import { describe, expect, it, vi } from 'vitest'
import { makeRenderedMediaLifecycle, type RecoveryReply } from './rendered-media-lifecycle'

const deferred = <A>() => {
  let resolve!: (value: A) => void
  const promise = new Promise<A>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const clock = () => {
  let frame: (() => void) | null = null
  const timers = new Map<number, () => void>()
  return {
    requestAnimationFrame: (task: () => void) => {
      frame = task
    },
    after: (ms: number, task: () => void) => {
      timers.set(ms, task)
      return () => timers.delete(ms)
    },
    runFrame: () => {
      const task = frame
      frame = null
      task?.()
    },
    runTimer: (ms: number) => timers.get(ms)?.(),
    timerCount: () => timers.size,
  }
}

describe('RenderedMediaLifecycle', () => {
  it('coalesces scroll scans and replaces settle timers', () => {
    const c = clock()
    let detects = 0
    const lifecycle = makeRenderedMediaLifecycle({
      clock: c,
      detect: () => ++detects > 0,
      clear: () => {},
      recoveryCandidates: () => [],
      markRecoveryAttempt: () => false,
      unmarkRecoveryAttempt: () => {},
      recover: async (): Promise<RecoveryReply> => ({ status: 'failed' }),
      reconcileRecovered: () => false,
      onContextInvalidated: () => {},
      rerender: () => {},
    })

    lifecycle.settle()
    lifecycle.settle()
    lifecycle.onScroll()
    expect(c.timerCount()).toBe(2)
    c.runFrame()
    expect(detects).toBe(1)
    c.runTimer(700)
    c.runFrame()
    c.runTimer(2000)
    c.runFrame()
    expect(detects).toBe(3)
  })

  it('fences a recovery reply after teardown', async () => {
    const c = clock()
    const reply = deferred<RecoveryReply>()
    let reconciled = 0
    let renders = 0
    const lifecycle = makeRenderedMediaLifecycle({
      clock: c,
      detect: () => false,
      clear: () => {},
      recoveryCandidates: () => ['tweet'],
      markRecoveryAttempt: () => true,
      unmarkRecoveryAttempt: () => {},
      recover: () => reply.promise,
      reconcileRecovered: () => {
        reconciled++
        return true
      },
      onContextInvalidated: () => {},
      rerender: () => {
        renders++
      },
    })

    lifecycle.rescan()
    lifecycle.stop()
    reply.resolve({ status: 'ok', body: 'recovered' })
    await reply.promise
    await Promise.resolve()

    expect(reconciled).toBe(0)
    expect(renders).toBe(0)
    expect(c.timerCount()).toBe(0)
  })

  it('fences a recovery reply from the previous route', async () => {
    const c = clock()
    const reply = deferred<RecoveryReply>()
    let reconciled = 0
    const lifecycle = makeRenderedMediaLifecycle({
      clock: c,
      detect: () => false,
      clear: () => {},
      recoveryCandidates: () => ['tweet'],
      markRecoveryAttempt: () => true,
      unmarkRecoveryAttempt: () => {},
      recover: () => reply.promise,
      reconcileRecovered: () => {
        reconciled++
        return true
      },
      onContextInvalidated: () => {},
      rerender: () => {},
    })

    lifecycle.rescan()
    lifecycle.onLocationChange()
    reply.resolve({ status: 'ok', body: 'recovered' })
    await reply.promise
    await Promise.resolve()

    expect(reconciled).toBe(0)
  })

  it('clears the prior route before scheduling its first scan', () => {
    const c = clock()
    const order: string[] = []
    const lifecycle = makeRenderedMediaLifecycle({
      clock: c,
      detect: () => {
        order.push('detect')
        return false
      },
      clear: () => {
        order.push('clear')
      },
      recoveryCandidates: () => [],
      markRecoveryAttempt: () => false,
      unmarkRecoveryAttempt: () => {},
      recover: async (): Promise<RecoveryReply> => ({ status: 'failed' }),
      reconcileRecovered: () => false,
      onContextInvalidated: () => {},
      rerender: () => {},
    })

    lifecycle.onLocationChange()
    expect(order).toEqual(['clear'])

    c.runFrame()
    expect(order).toEqual(['clear', 'detect'])
  })

  it('does not release a new recovery claim when an earlier attempt fails', async () => {
    const c = clock()
    const first = deferred<RecoveryReply>()
    const second = deferred<RecoveryReply>()
    const attempts = new Set<string>()
    const recover = vi
      .fn<(tweetId: string) => Promise<RecoveryReply>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const lifecycle = makeRenderedMediaLifecycle({
      clock: c,
      detect: () => false,
      clear: () => attempts.clear(),
      recoveryCandidates: () => ['tweet'],
      markRecoveryAttempt: (tweetId) => {
        if (attempts.has(tweetId)) return false
        attempts.add(tweetId)
        return true
      },
      unmarkRecoveryAttempt: (tweetId) => attempts.delete(tweetId),
      recover,
      reconcileRecovered: () => false,
      onContextInvalidated: () => {},
      rerender: () => {},
    })

    lifecycle.rescan()
    lifecycle.rescan()
    first.resolve({ status: 'failed' })
    await first.promise
    await Promise.resolve()
    lifecycle.onScroll()
    c.runFrame()

    expect(recover).toHaveBeenCalledTimes(2)
    second.resolve({ status: 'failed' })
  })

  it('ignores a stale context-invalidated reply', async () => {
    const c = clock()
    const reply = deferred<RecoveryReply>()
    const onContextInvalidated = vi.fn<() => void>()
    const lifecycle = makeRenderedMediaLifecycle({
      clock: c,
      detect: () => false,
      clear: () => {},
      recoveryCandidates: () => ['tweet'],
      markRecoveryAttempt: () => true,
      unmarkRecoveryAttempt: () => {},
      recover: () => reply.promise,
      reconcileRecovered: () => false,
      onContextInvalidated,
      rerender: () => {},
    })

    lifecycle.rescan()
    lifecycle.onLocationChange()
    reply.resolve({ status: 'context-invalidated' })
    await reply.promise
    await Promise.resolve()

    expect(onContextInvalidated).not.toHaveBeenCalled()
  })
})
