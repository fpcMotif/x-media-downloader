import { Option } from 'effect'

export interface TrailingFlush {
  readonly request: () => void
  readonly cancel: () => void
}

export const makeTrailingFlush = (flush: () => void, delayMs: number): TrailingFlush => {
  let timer: Option.Option<ReturnType<typeof setTimeout>> = Option.none()
  return {
    request: () => {
      if (Option.isSome(timer)) return
      timer = Option.some(
        setTimeout(() => {
          timer = Option.none()
          flush()
        }, delayMs),
      )
    },
    cancel: () => {
      if (Option.isSome(timer)) {
        clearTimeout(timer.value)
        timer = Option.none()
      }
    },
  }
}
