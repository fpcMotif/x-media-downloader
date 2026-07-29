import type { CaptureEpoch } from '../../core/capture/epoch'

export interface CaptureEpochRefreshClock {
  after(ms: number, task: () => void): () => void
}

export interface CaptureEpochRefresh {
  /** Supersede any delayed retry and pull canonical truth. Concurrent pulls coalesce. */
  refresh(): Promise<void>
  stop(): void
}

/** One-flight canonical epoch pull with one bounded-backoff timer. */
export function makeCaptureEpochRefresh(deps: {
  readonly read: () => Promise<CaptureEpoch | undefined>
  readonly beforeRefresh: () => void
  readonly accept: (epoch: CaptureEpoch) => void
  readonly clock: CaptureEpochRefreshClock
  readonly retryBaseMs: number
  readonly retryMaxMs: number
}): CaptureEpochRefresh {
  validateDelay('base', deps.retryBaseMs)
  validateDelay('maximum', deps.retryMaxMs)
  if (deps.retryBaseMs > deps.retryMaxMs)
    throw new TypeError('Capture epoch retry base exceeds maximum')

  let stopped = false
  let version = 0
  let pendingAttempt = false
  let failures = 0
  let running: Promise<void> | undefined
  let cancelRetry: (() => void) | undefined

  const retryDelay = (): number =>
    Math.min(deps.retryBaseMs * 2 ** Math.min(Math.max(failures - 1, 0), 8), deps.retryMaxMs)

  const attempt = async (): Promise<void> => {
    if (stopped || !pendingAttempt) return
    pendingAttempt = false
    const attemptVersion = version
    let epoch: CaptureEpoch | undefined
    try {
      epoch = await deps.read()
    } catch {
      epoch = undefined
    }
    if (stopped) return
    if (attemptVersion !== version) return attempt()
    if (epoch !== undefined) {
      failures = 0
      deps.accept(epoch)
      return
    }
    failures++
    const retryVersion = version
    cancelRetry = deps.clock.after(retryDelay(), () => {
      cancelRetry = undefined
      if (stopped || retryVersion !== version) return
      pendingAttempt = true
      void drive()
    })
  }

  const drive = (): Promise<void> => {
    if (stopped) return Promise.resolve()
    if (running !== undefined) return running
    running = attempt().finally(() => {
      running = undefined
      // A refresh can arrive after the attempt returns but before `finally`.
      if (!stopped && pendingAttempt) void drive()
    })
    return running
  }

  return {
    refresh: () => {
      if (stopped) return Promise.resolve()
      version++
      failures = 0
      cancelRetry?.()
      cancelRetry = undefined
      pendingAttempt = true
      deps.beforeRefresh()
      return drive()
    },
    stop: () => {
      stopped = true
      version++
      pendingAttempt = false
      cancelRetry?.()
      cancelRetry = undefined
    },
  }
}

const validateDelay = (name: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError(`Invalid capture epoch retry ${name}: ${value}`)
}
