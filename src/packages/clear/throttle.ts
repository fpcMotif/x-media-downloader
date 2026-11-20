import { expBackoffMs } from '@/packages/kernel/backoff'

export const HTTP_TOO_MANY_REQUESTS = 429
export const RELEASE_THROTTLE_BASE_MS = 60_000
export const RELEASE_THROTTLE_MAX_MS = 900_000

export interface ReleaseThrottle {
  readonly blockedForMs: () => number
  readonly noteRateLimited: () => void
  readonly noteAnswered: () => void
}

export const makeReleaseThrottle = (opts: {
  readonly now: () => number
  readonly baseMs?: number
  readonly maxMs?: number
}): ReleaseThrottle => {
  const policy = {
    baseMs: opts.baseMs ?? RELEASE_THROTTLE_BASE_MS,
    capMs: opts.maxMs ?? RELEASE_THROTTLE_MAX_MS,
  }
  let strikes = 0
  let blockedUntil = 0
  return {
    blockedForMs: () => Math.max(0, blockedUntil - opts.now()),
    noteRateLimited: () => {
      blockedUntil = opts.now() + expBackoffMs(strikes, policy)
      strikes += 1
    },
    noteAnswered: () => {
      strikes = 0
    },
  }
}

export const noteReleaseReply = (throttle: ReleaseThrottle, status: number): void => {
  if (status === HTTP_TOO_MANY_REQUESTS) throttle.noteRateLimited()
  else throttle.noteAnswered()
}
