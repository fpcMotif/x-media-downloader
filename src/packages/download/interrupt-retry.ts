import { type BackoffPolicy, expBackoffMs } from '@/packages/kernel/backoff'
import type { MediaItem } from '@/packages/schema'

/** Max interrupted-download retries after the initial browser transfer (3 → 4 total tries). */
export const INTERRUPT_RETRY_MAX = 3

const BACKOFF_BASE_MS = 2000

// The cap is the delay at the LAST retry INTERRUPT_RETRY_MAX allows, so under the
// default policy it never binds and the ladder is exactly 2s/4s/8s — the range the
// old JSDoc claimed as a contract while the function applied no cap at all. It binds
// only for a `maxRetries` override, the one way a caller reaches an attempt this
// policy never sized a delay for. Deriving it from the max keeps the two in step:
// raise INTERRUPT_RETRY_MAX and the ceiling follows instead of silently clamping.
const INTERRUPT_BACKOFF = {
  baseMs: BACKOFF_BASE_MS,
  capMs: BACKOFF_BASE_MS * 2 ** (INTERRUPT_RETRY_MAX - 1),
} satisfies BackoffPolicy

const RETRYABLE_REASONS = new Set([
  'NETWORK_FAILED',
  'NETWORK_TIMEOUT',
  'NETWORK_DISCONNECTED',
  'NETWORK_SERVER_DOWN',
  'NETWORK_INVALID_REQUEST',
  'SERVER_FAILED',
  'SERVER_NO_RANGE',
  'SERVER_UNREACHABLE',
  'SERVER_CONTENT_LENGTH_MISMATCH',
  'FILE_TRANSIENT_ERROR',
  'FILE_TOO_SHORT',
  'CRASH',
])

// Known non-retryable Chrome InterruptReasons (documentation only — these all
// fall through to `false` by not being in RETRYABLE_REASONS, so they are not a
// live Set): USER_CANCELED, USER_SHUTDOWN, SERVER_FORBIDDEN, SERVER_BAD_CONTENT,
// SERVER_UNAUTHORIZED, SERVER_CERT_PROBLEM, SERVER_CROSS_ORIGIN_REDIRECT,
// FILE_BLOCKED, FILE_TOO_LARGE, FILE_VIRUS_INFECTED, FILE_NO_SPACE,
// FILE_ACCESS_DENIED, FILE_NAME_TOO_LONG, FILE_HASH_MISMATCH, FILE_SAME_AS_SOURCE,
// FILE_FAILED, FILE_SECURITY_CHECK_FAILED.

/** Whether a Chrome `InterruptReason` warrants an automatic re-download. */
export function isRetryableInterruptReason(reason: string | undefined): boolean {
  if (reason === undefined) return true
  return RETRYABLE_REASONS.has(reason)
}

/**
 * Delay before the next interrupted-download retry.
 *
 * @param attempt - Retries already spent, 0-based: 0 is the first retry and waits
 * 2s. Under {@link INTERRUPT_RETRY_MAX} the whole reachable ladder is 2s, 4s, 8s;
 * past it the delay holds at 8s, reachable only through `planInterruptRetry`'s
 * `maxRetries` override. Contrast the 1-based `backoffMs` in `@/packages/cloud`.
 */
export function interruptBackoffMs(attempt: number): number {
  return expBackoffMs(attempt, INTERRUPT_BACKOFF)
}

export interface PendingInterruptRetry {
  readonly id: string
  readonly url: string
  readonly filename: string
  readonly attempt: number
  readonly nextRetryAt: number
  /** Media provenance for URL re-resolution before retry (optional for legacy queue rows). */
  readonly item?: MediaItem
}

/** Decide whether to schedule an interrupted download retry. */
export function planInterruptRetry(opts: {
  readonly reason: string | undefined
  readonly attempt: number
  readonly maxRetries?: number
}):
  | { readonly schedule: true; readonly delayMs: number; readonly nextAttempt: number }
  | { readonly schedule: false } {
  const maxRetries = opts.maxRetries ?? INTERRUPT_RETRY_MAX
  if (opts.attempt >= maxRetries) return { schedule: false }
  if (!isRetryableInterruptReason(opts.reason)) return { schedule: false }
  return {
    schedule: true,
    delayMs: interruptBackoffMs(opts.attempt),
    nextAttempt: opts.attempt + 1,
  }
}
