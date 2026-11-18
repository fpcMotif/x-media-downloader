export const WORKER_TICKS_WHEN_HIDDEN = true
export const WORKER_TICK_MIN_FRACTION = 0.5

export interface HiddenAwareSleepDeps {
  readonly isHidden: () => boolean
  readonly now: () => number
  readonly timerSleep: (ms: number) => Promise<void>
  readonly workerSleep: (ms: number) => Promise<void>
  readonly enabled?: boolean
}

export const makeHiddenAwareSleep = (
  deps: HiddenAwareSleepDeps,
): ((ms: number) => Promise<void>) => {
  const enabled = deps.enabled ?? WORKER_TICKS_WHEN_HIDDEN
  return async (ms) => {
    if (!enabled || !deps.isHidden()) return deps.timerSleep(ms)
    const startedAt = deps.now()
    try {
      await deps.workerSleep(ms)
    } catch {
      return deps.timerSleep(ms)
    }
    const waited = deps.now() - startedAt
    if (waited < ms * WORKER_TICK_MIN_FRACTION) await deps.timerSleep(ms - waited)
  }
}
