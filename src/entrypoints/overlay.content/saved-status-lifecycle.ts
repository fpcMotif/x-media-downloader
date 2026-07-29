import { clearSavedStatusMarks, sweepSavedStatus } from './saved-status-marks'

export interface SavedStatusClock {
  after(ms: number, task: () => void): () => void
}

export interface SavedStatusLifecycle {
  apply(enabled: boolean): void
  onLocationChange(): void
  stop(): void
  isActive(): boolean
}

/** Owns the Saved-status observer, debounce, request epoch, and injected chips. */
export const makeSavedStatusLifecycle = (deps: {
  readonly document: Document
  readonly debounceMs: number
  readonly clock: SavedStatusClock
  readonly inScope: () => boolean
  readonly requestSavedStatus: (tweetIds: string[]) => Promise<string[]>
}): SavedStatusLifecycle => {
  let enabled = false
  let epoch = 0
  let observer: MutationObserver | null = null
  let cancel: (() => void) | null = null

  const active = (): boolean => enabled && deps.inScope()
  const clearScheduled = (): void => {
    cancel?.()
    cancel = null
  }
  const disconnect = (): void => {
    observer?.disconnect()
    observer = null
  }
  const schedule = (): void => {
    if (!active()) {
      clearScheduled()
      return
    }
    clearScheduled()
    const requestEpoch = epoch
    cancel = deps.clock.after(deps.debounceMs, () => {
      cancel = null
      if (!active() || requestEpoch !== epoch) return
      void sweepSavedStatus({
        document: deps.document,
        inScope: () => active() && requestEpoch === epoch,
        requestSavedStatus: deps.requestSavedStatus,
      })
    })
  }
  const clear = (): void => {
    epoch++
    clearScheduled()
    disconnect()
    clearSavedStatusMarks(deps.document)
  }

  return {
    apply: (next) => {
      if (!next) {
        enabled = false
        clear()
        return
      }
      enabled = true
      if (observer === null) {
        observer = new MutationObserver(schedule)
        observer.observe(deps.document.body, { childList: true, subtree: true })
      }
      schedule()
    },
    onLocationChange: () => {
      epoch++
      clearSavedStatusMarks(deps.document)
      schedule()
    },
    stop: () => {
      enabled = false
      clear()
    },
    isActive: active,
  }
}
