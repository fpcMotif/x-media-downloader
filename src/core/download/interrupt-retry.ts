import { Schema } from 'effect'
import { MediaItem, type MediaItem as MediaItemType } from '../schema/media'
import type { BrowserTransferMode } from './transfer-mode'

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

/** Exponential backoff for interrupted retries: 2s, 4s, 8s. */
export function interruptBackoffMs(attempt: number): number {
  return BACKOFF_BASE_MS * 2 ** attempt
}

export interface PendingInterruptRetry {
  readonly id: string
  readonly url: string
  readonly filename: string
  readonly mode: BrowserTransferMode
  readonly attempt: number
  readonly nextRetryAt: number
  /** Media provenance for URL re-resolution before retry (optional for legacy queue rows). */
  readonly item?: MediaItem
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasOnlyKeys = (
  value: unknown,
  required: ReadonlyArray<string>,
  allowed: ReadonlyArray<string>,
): value is Record<string, unknown> =>
  isRecord(value) &&
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => allowed.includes(key))

const isNonemptyText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

const isFiniteTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

const isAttempt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const mediaItemKeys = [
  'id',
  'platform',
  'postId',
  'author',
  'type',
  'url',
  'previewUrl',
  'ext',
  'index',
  'width',
  'height',
  'bitrate',
] as const
const requiredMediaItemKeys = [
  'id',
  'platform',
  'postId',
  'author',
  'type',
  'url',
  'ext',
  'index',
] as const

function decodeMediaItem(value: unknown): MediaItemType | undefined {
  if (!hasOnlyKeys(value, requiredMediaItemKeys, mediaItemKeys)) return undefined
  try {
    return Schema.decodeUnknownSync(MediaItem)(value)
  } catch {
    return undefined
  }
}

export type DecodeInterruptRetryQueueResult =
  | {
      readonly ok: true
      readonly retries: ReadonlyArray<PendingInterruptRetry>
    }
  | {
      readonly ok: false
      readonly retries: ReadonlyArray<PendingInterruptRetry>
      readonly reason: string
    }

function decodePendingInterruptRetry(value: unknown): PendingInterruptRetry | undefined {
  const required = ['id', 'url', 'filename', 'attempt', 'nextRetryAt']
  const allowed = [...required, 'mode', 'item']
  if (!hasOnlyKeys(value, required, allowed)) return undefined
  if (
    !isNonemptyText(value.id) ||
    !isNonemptyText(value.url) ||
    !isNonemptyText(value.filename) ||
    !isAttempt(value.attempt) ||
    !isFiniteTime(value.nextRetryAt)
  )
    return undefined
  if (Object.hasOwn(value, 'mode') && value.mode !== 'direct' && value.mode !== 'fetched')
    return undefined
  const item = Object.hasOwn(value, 'item') ? decodeMediaItem(value.item) : undefined
  if (Object.hasOwn(value, 'item') && item === undefined) return undefined
  return {
    id: value.id,
    url: value.url,
    filename: value.filename,
    mode: value.mode === 'fetched' ? 'fetched' : 'direct',
    attempt: value.attempt,
    nextRetryAt: value.nextRetryAt,
    ...(item === undefined ? {} : { item }),
  }
}

/**
 * Strict storage boundary for `session:interruptRetries`. Missing `mode` is the
 * one supported legacy shape and decodes as Direct. Any other corruption yields
 * an empty queue plus a reason so the background can trace and reset it.
 */
export function decodeInterruptRetryQueue(raw: unknown): DecodeInterruptRetryQueueResult {
  if (!Array.isArray(raw)) return { ok: false, retries: [], reason: 'expected retry array' }
  const ids = new Set<string>()
  const retries: PendingInterruptRetry[] = []
  for (const [index, value] of raw.entries()) {
    const retry = decodePendingInterruptRetry(value)
    if (retry === undefined)
      return {
        ok: false,
        retries: [],
        reason: `invalid retry at index ${index}`,
      }
    if (ids.has(retry.id))
      return {
        ok: false,
        retries: [],
        reason: `duplicate retry id: ${retry.id}`,
      }
    ids.add(retry.id)
    retries.push(retry)
  }
  return { ok: true, retries }
}

/** Normalize a queue row written before transfer mode was persisted. */
export function normalizePendingInterruptRetry(
  row: Omit<PendingInterruptRetry, 'mode'> & { readonly mode?: unknown },
): PendingInterruptRetry {
  return { ...row, mode: row.mode === 'fetched' ? 'fetched' : 'direct' }
}

/** Decide whether to schedule an interrupted download retry. */
export function planInterruptRetry(opts: {
  readonly reason: string | undefined
  readonly attempt: number
  readonly maxRetries?: number
}):
  | {
      readonly schedule: true
      readonly delayMs: number
      readonly nextAttempt: number
    }
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
