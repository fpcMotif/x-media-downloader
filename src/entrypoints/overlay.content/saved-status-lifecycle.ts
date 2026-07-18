/** Owns the whole saved-status lifecycle for the overlay: the MutationObserver,
 *  the debounce timer, and the in-flight sweep. Replaces the old block-local
 *  observer + bare timer, which could not be disconnected on teardown and could
 *  overlap a second full article scan while the prior request was in flight.
 *
 *  State rules (pinned by saved-status-lifecycle.test.ts):
 *  - `sync()` observes only while `isActive()` is true; every active `sync()`
 *    also schedules a sweep (settings load/toggle and route entry paint once
 *    without waiting for a DOM mutation).
 *  - Inactive `sync()` disconnects, cancels the timer, and clears `rerun`.
 *  - `schedule()` returns while inactive/disposed; during a running sweep it
 *    only marks one rerun. Sweeps never overlap.
 *  - `dispose()` permanently disconnects and cancels; an in-flight promise may
 *    finish but must not paint or rearm work. */

export interface SavedStatusLifecycle {
  readonly sync: () => void
  readonly schedule: () => void
  readonly dispose: () => void
}

export interface SavedStatusObserver {
  observe(target: Node, options: MutationObserverInit): void
  disconnect(): void
}

export interface SavedStatusLifecycleDeps {
  readonly isActive: () => boolean
  readonly root: Node
  readonly delayMs: number
  readonly makeObserver: (notify: () => void) => SavedStatusObserver
  readonly clock: { after(ms: number, run: () => void): () => void }
  readonly sweep: () => Promise<void>
}

export function makeSavedStatusLifecycle(deps: SavedStatusLifecycleDeps): SavedStatusLifecycle {
  let observer: SavedStatusObserver | null = null
  let cancelTimer: (() => void) | null = null
  let running = false
  let rerun = false
  let disposed = false

  const cancelPending = (): void => {
    cancelTimer?.()
    cancelTimer = null
  }

  const stop = (): void => {
    observer?.disconnect()
    observer = null
    cancelPending()
    rerun = false
  }

  const schedule = (): void => {
    if (disposed || !deps.isActive()) return
    if (running) {
      rerun = true
      return
    }
    cancelPending()
    cancelTimer = deps.clock.after(deps.delayMs, () => {
      cancelTimer = null
      void run().catch(() => {})
    })
  }

  const run = async (): Promise<void> => {
    if (disposed || !deps.isActive()) return
    if (running) {
      rerun = true
      return
    }
    running = true
    try {
      await deps.sweep()
    } finally {
      running = false
      if (!disposed && deps.isActive() && rerun) {
        rerun = false
        schedule()
      } else {
        rerun = false
      }
    }
  }

  const sync = (): void => {
    if (disposed) return
    if (!deps.isActive()) {
      stop()
      return
    }
    if (observer === null) {
      observer = deps.makeObserver(schedule)
      observer.observe(deps.root, { childList: true, subtree: true })
    }
    schedule()
  }

  const dispose = (): void => {
    disposed = true
    stop()
  }

  return { sync, schedule, dispose }
}
