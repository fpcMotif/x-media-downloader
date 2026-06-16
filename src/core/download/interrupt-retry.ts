/** Max interrupted-download retries after the initial browser transfer (3 → 4 total tries). */
export const INTERRUPT_RETRY_MAX = 3

const BACKOFF_BASE_MS = 2000

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

const NON_RETRYABLE_REASONS = new Set([
  'USER_CANCELED',
  'USER_SHUTDOWN',
  'SERVER_FORBIDDEN',
  'SERVER_BAD_CONTENT',
  'SERVER_UNAUTHORIZED',
  'SERVER_CERT_PROBLEM',
  'SERVER_CROSS_ORIGIN_REDIRECT',
  'FILE_BLOCKED',
  'FILE_TOO_LARGE',
  'FILE_VIRUS_INFECTED',
  'FILE_NO_SPACE',
  'FILE_ACCESS_DENIED',
  'FILE_NAME_TOO_LONG',
  'FILE_HASH_MISMATCH',
  'FILE_SAME_AS_SOURCE',
  'FILE_FAILED',
  'FILE_SECURITY_CHECK_FAILED',
])

/** Whether a Chrome `InterruptReason` warrants an automatic re-download. */
export function isRetryableInterruptReason(reason: string | undefined): boolean {
  if (reason === undefined) return true
  if (NON_RETRYABLE_REASONS.has(reason)) return false
  return RETRYABLE_REASONS.has(reason)
}

/** Exponential backoff for interrupted retries: 2s, 4s, 8s. */
export function interruptBackoffMs(attempt: number): number {
  return BACKOFF_BASE_MS * 2 ** attempt
}

export interface PendingInterruptRetry {
  readonly id: string
  readonly url: string
  readonly filename: string
  readonly attempt: number
  readonly nextRetryAt: number
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
