/** Bounds of one retry ladder. Both milliseconds. */
export interface BackoffPolicy {
  readonly baseMs: number
  readonly capMs: number
}

/**
 * Returns the delay before a retry: `min(capMs, baseMs · 2^attempt)`.
 *
 * The one backoff ladder in the extension. The policies built on it — interrupted
 * downloads, cloud uploads, sync drains — differ only in their bounds and in how
 * each counts an attempt; the arithmetic is not theirs to restate. `capMs` is
 * required, so an unbounded ladder must be written down rather than arrived at by
 * leaving a `Math.min` off.
 *
 * @param attempt - Retries already spent, 0-based: attempt 0 is the first retry
 * and waits exactly `baseMs`. A caller that counts attempts from 1 subtracts at
 * its own call site, so the basis stays visible where the policy lives. Values
 * below 0 clamp to 0 — no delay is ever shorter than `baseMs`.
 */
export function expBackoffMs(attempt: number, policy: BackoffPolicy): number {
  return Math.min(policy.capMs, policy.baseMs * 2 ** Math.max(0, attempt))
}
