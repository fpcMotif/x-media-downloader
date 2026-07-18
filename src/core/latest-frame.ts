/** Latest-value-wins frame scheduler: a burst of `push`es inside one frame runs
 *  `run` exactly once, with only the newest value. Used to keep per-event
 *  hit-tests (pointer, etc.) at display cadence without losing the final sample. */

export interface LatestFrameTask<T> {
  readonly push: (value: T) => void
  /** Forget any queued-but-unrun sample (navigation, leave, teardown). */
  readonly clear: () => void
}

export function makeLatestFrameTask<T>(
  requestFrame: (run: () => void) => void,
  run: (value: T) => void,
): LatestFrameTask<T> {
  let queued = false
  let hasLatest = false
  let latest!: T

  return {
    push(value) {
      latest = value
      hasLatest = true
      if (queued) return
      queued = true
      requestFrame(() => {
        queued = false
        if (!hasLatest) return
        const runValue = latest
        hasLatest = false
        run(runValue)
      })
    },
    clear() {
      hasLatest = false
    },
  }
}
