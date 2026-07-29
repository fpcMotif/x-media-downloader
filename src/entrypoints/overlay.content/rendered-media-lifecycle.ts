export interface RenderedMediaClock {
  requestAnimationFrame(task: () => void): void
  after(ms: number, task: () => void): () => void
}

export type RecoveryReply =
  | { readonly status: 'ok'; readonly body: string | undefined }
  | { readonly status: 'failed' }
  | { readonly status: 'context-invalidated' }

export interface RenderedMediaLifecycle {
  settle(): void
  onScroll(): void
  rescan(): void
  onLocationChange(): void
  stop(): void
}

/** Owns rendered-media detection, bounded recovery, and all deferred work. */
export const makeRenderedMediaLifecycle = (deps: {
  readonly clock: RenderedMediaClock
  readonly detect: () => boolean
  readonly clear: () => void
  readonly recoveryCandidates: () => readonly string[]
  readonly markRecoveryAttempt: (tweetId: string) => boolean
  readonly unmarkRecoveryAttempt: (tweetId: string) => void
  readonly recover: (tweetId: string) => Promise<RecoveryReply>
  readonly reconcileRecovered: (body: string) => boolean
  readonly onContextInvalidated: () => void
  readonly rerender: () => void
}): RenderedMediaLifecycle => {
  let stopped = false
  let epoch = 0
  let scanQueued = false
  let cancelSettles: Array<() => void> = []

  const active = (requestEpoch: number): boolean => !stopped && requestEpoch === epoch
  const clearSettles = (): void => {
    for (const cancel of cancelSettles) cancel()
    cancelSettles = []
  }
  const recoverMissing = (): void => {
    for (const tweetId of deps.recoveryCandidates()) {
      if (!deps.markRecoveryAttempt(tweetId)) continue
      const requestEpoch = epoch
      void deps.recover(tweetId).then((reply) => {
        // A rescan clears the attempt set and may start a new request for this
        // tweet. A prior reply must not release or invalidate that new claim.
        if (!active(requestEpoch)) return undefined
        if (reply.status === 'context-invalidated') {
          deps.onContextInvalidated()
          return undefined
        }
        if (reply.status === 'failed') {
          deps.unmarkRecoveryAttempt(tweetId)
          return undefined
        }
        if (reply.body !== undefined && deps.reconcileRecovered(reply.body)) deps.rerender()
        return undefined
      })
    }
  }
  const scan = (): void => {
    if (stopped) return
    if (deps.detect()) deps.rerender()
    recoverMissing()
  }
  const queueScan = (): void => {
    if (stopped || scanQueued) return
    scanQueued = true
    deps.clock.requestAnimationFrame(() => {
      scanQueued = false
      scan()
    })
  }
  const settle = (): void => {
    if (stopped) return
    clearSettles()
    queueScan()
    cancelSettles = [deps.clock.after(700, queueScan), deps.clock.after(2000, queueScan)]
  }

  return {
    settle,
    onScroll: queueScan,
    rescan: () => {
      if (stopped) return
      epoch++
      deps.clear()
      scan()
    },
    onLocationChange: () => {
      if (stopped) return
      epoch++
      deps.clear()
      settle()
    },
    stop: () => {
      if (stopped) return
      stopped = true
      epoch++
      clearSettles()
    },
  }
}
