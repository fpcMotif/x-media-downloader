import type { ClearScope } from '@/packages/schema'

export const RECENT_RELEASE_MEMO_MS = 15_000

export interface ClickGuard {
  /** Shares an in-flight `click` per `(scope, tweetId)` and returns `true` without clicking while a recent `true` verdict is still within `memoMs`. */
  readonly run: (
    tweetId: string,
    scope: ClearScope,
    click: () => Promise<boolean>,
  ) => Promise<boolean>
}

export const makeClickGuard = (opts: {
  /** Returns the current epoch timestamp in milliseconds. */
  readonly now: () => number
  /** Window (ms) after a `true` verdict during which repeat calls return `true` without clicking.
   *  @defaultValue 15_000 */
  readonly memoMs?: number | undefined
}): ClickGuard => {
  const memoMs = opts.memoMs ?? RECENT_RELEASE_MEMO_MS
  const inFlight = new Map<string, Promise<boolean>>()
  const releasedAt = new Map<string, number>()

  const forgetExpired = (now: number): void => {
    for (const [key, at] of releasedAt) {
      if (now - at >= memoMs) releasedAt.delete(key)
    }
  }

  const execute = async (key: string, click: () => Promise<boolean>): Promise<boolean> => {
    try {
      const released = await click()
      if (released) releasedAt.set(key, opts.now())
      return released
    } finally {
      inFlight.delete(key)
    }
  }

  const run = (
    tweetId: string,
    scope: ClearScope,
    click: () => Promise<boolean>,
  ): Promise<boolean> => {
    const key = `${scope}:${tweetId}`
    const running = inFlight.get(key)
    if (running !== undefined) return running
    forgetExpired(opts.now())
    if (releasedAt.has(key)) return Promise.resolve(true)
    const attempt = execute(key, click)
    inFlight.set(key, attempt)
    return attempt
  }

  return { run }
}
