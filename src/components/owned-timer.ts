import { useEffect, useState } from 'preact/hooks'

export interface OwnedTimer {
  readonly arm: (fn: () => void, delayMs: number) => void
  readonly cancel: () => void
}

/** Returns a single-slot timer: `arm` cancels any pending callback before
 *  scheduling the new one, so only the latest arm can fire. */
export const makeOwnedTimer = (): OwnedTimer => {
  let handle: ReturnType<typeof setTimeout> | undefined
  return {
    arm: (fn, delayMs) => {
      clearTimeout(handle)
      handle = setTimeout(fn, delayMs)
    },
    cancel: () => clearTimeout(handle),
  }
}

/** Owns one {@link OwnedTimer} for the component's lifetime and cancels its
 *  pending callback on unmount. */
export function useOwnedTimer(): OwnedTimer {
  const [timer] = useState(makeOwnedTimer)
  useEffect(() => timer.cancel, [timer])
  return timer
}
