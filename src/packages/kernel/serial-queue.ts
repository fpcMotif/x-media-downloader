/**
 * Serializes async tasks onto a single promise chain — the envelope behind every
 * read-modify-write in the background service worker.
 *
 * MV3 event handlers interleave: two `downloads.onChanged` events (or a message
 * handler racing a drain) can each read `storage.local`, mutate, and write back,
 * silently losing one update. Running each task through `push`/`run` guarantees a
 * task starts only after the previous one settles, so a read always sees the
 * prior write.
 *
 * The subtle part — the reason this is a tested module and not three inline lines
 * copy-pasted per chain — is that a rejecting task must NOT poison the chain: a
 * naive `tail = tail.then(task)` would skip every subsequent task once one throws.
 * Here a failed task is observed (via `onError`) and the chain resolves so the
 * next task still runs. A throwing `onError` is itself contained.
 *
 * Storage-agnostic by design: backoff/drain logic lives in the task, not here —
 * the queue only orders them.
 */
export interface SerialQueue {
  /** Enqueue a fire-and-forget task; failures are routed to `onError`. */
  readonly push: <T>(task: () => Promise<T>) => void
  /**
   * Enqueue a task and get its outcome back: the returned promise resolves with
   * the task's value or rejects with its error. The caller MUST handle it — use
   * `push` when the value is unused.
   */
  readonly run: <T>(task: () => Promise<T>) => Promise<T>
}

export function makeSerialQueue(onError?: (error: Error) => void): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve()
  // A task's promise can reject with any value at all (JS lets `throw`/`reject`
  // carry anything) — normalizing to an `Error` HERE keeps `onError`'s own contract
  // honest instead of pushing `unknown` further downstream. For an already-`Error`
  // rejection (every real task in this codebase) it's the exact same reference, so
  // `.message`-reading observers see byte-identical output either way.
  const observe = (error: Error | string): void => {
    const err = error instanceof Error ? error : new Error(error)
    try {
      onError?.(err)
    } catch {
      /* an observer must never poison the chain */
    }
  }
  return {
    // `.then`'s rejection handler receives whatever the task rejected with —
    // narrow it inline, right at this boundary (`String` is idempotent on an
    // already-`string` value), before it ever reaches `observe`.
    push(task) {
      tail = tail
        .then(task)
        .then(undefined, (reason) => observe(reason instanceof Error ? reason : String(reason)))
    },
    run(task) {
      const result = tail.then(task)
      tail = result.then(undefined, (reason) =>
        observe(reason instanceof Error ? reason : String(reason)),
      )
      return result
    },
  }
}
