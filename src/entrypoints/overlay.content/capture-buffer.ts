import { Schema } from 'effect'
import { TweetRecord, type TweetRecord as TweetRecordType } from '../../core/capture/record-schema'
import {
  MAX_CAPTURE_BATCH,
  MAX_CAPTURE_MESSAGE_BYTES,
  MAX_CAPTURE_PENDING,
  MAX_CAPTURE_RECORD_BYTES,
} from '../../core/capture/contract'
import { CaptureEpoch, MAX_CAPTURE_EPOCH_LENGTH } from '../../core/capture/epoch'
import { decodeCaptureTweetsResult, type CaptureTweetsResult } from '../../core/schema'
import { measureJsonBytes } from '../../core/wire/json-budget'

export interface CaptureClock {
  after(ms: number, task: () => void): () => void
}

export interface CaptureBuffer {
  /** Accepts the FIFO prefix that fits. Overflow is explicit so the caller can
   * report that later Raw Captures were not retained in this tab. */
  enqueue(records: ReadonlyArray<TweetRecordType>): CaptureEnqueueResult
  /** Stop stamping new work while the canonical post-erase epoch is unknown. */
  invalidateEpoch(): void
  /** Adopt canonical post-erase truth. Existing old-epoch work is never relabeled. */
  advanceEpoch(epoch: CaptureEpoch): void
  flush(): void
  stop(): void
  readonly pending: number
}

export type CaptureEnqueueResult =
  | { readonly tag: 'accepted'; readonly accepted: number }
  | {
      readonly tag: 'dropped'
      readonly accepted: number
      readonly capacityDiscarded: number
      /** Invalid normalized records are discarded before they can poison retries. */
      readonly invalidDiscarded: number
      readonly oversizeDiscarded: number
    }

/** The worker either stores or explicitly discards after the current capture
 * gate. Any malformed reply leaves the batch queued. */
export const decodeCaptureAcceptedAck = (
  reply: unknown,
  expected: number,
): CaptureTweetsResult | undefined => decodeCaptureTweetsResult(reply, expected)

export const isCaptureAcceptedAck = (reply: unknown, expected: number): boolean =>
  decodeCaptureAcceptedAck(reply, expected) !== undefined

/** Keep a batch until the worker returns the exact durable-storage ack. One
 * request is in flight at a time, so an ack removes only its own prefix. */
export function makeCaptureBuffer(deps: {
  readonly epoch: CaptureEpoch
  readonly send: (
    records: ReadonlyArray<TweetRecordType>,
    epoch: CaptureEpoch,
  ) => Promise<CaptureTweetsResult | undefined>
  readonly clock: CaptureClock
  readonly maxBatch: number
  /** Hard per-tab memory bound, independent of the message batch size. */
  readonly maxPending: number
  readonly debounceMs: number
  readonly retryBaseMs: number
  readonly retryMaxMs: number
  /** Test seam; production uses the runtime-wire record budget. */
  readonly maxRecordBytes?: number
  /** Test seam; production uses the runtime-wire message budget. */
  readonly maxMessageBytes?: number
}): CaptureBuffer {
  if (!Schema.is(CaptureEpoch)(deps.epoch)) throw new TypeError('Invalid capture buffer epoch')
  const byteLimits = validateCaptureBufferDeps(deps)
  let pending: PendingCapture[] = []
  let currentEpoch: CaptureEpoch | undefined = deps.epoch
  let inFlight = false
  let stopped = false
  let retries = 0
  let cancel: (() => void) | null = null

  const schedule = (delay: number): void => {
    if (stopped || inFlight || pending.length === 0 || cancel !== null) return
    cancel = deps.clock.after(delay, () => {
      cancel = null
      flush()
    })
  }
  const retryDelay = (): number =>
    Math.min(deps.retryBaseMs * 2 ** Math.min(retries, 8), deps.retryMaxMs)
  const flush = (): void => {
    if (stopped || inFlight || pending.length === 0) return
    cancel?.()
    cancel = null
    const batch = takeBatch(pending, deps.maxBatch, byteLimits.maxMessageBytes)
    const batchEpoch = batch[0]?.epoch
    // Enqueue rejects records that cannot fit an empty CaptureTweets envelope, so
    // this would indicate an internal invariant failure rather than a retryable send.
    if (batch.length === 0 || batchEpoch === undefined) return
    inFlight = true
    void deps
      .send(
        batch.map((item) => item.record),
        batchEpoch,
      )
      .then((receipt) => {
        if (stopped) return undefined
        if (receipt !== undefined) {
          if (receipt.epoch !== batchEpoch || currentEpoch !== batchEpoch) {
            pending = pending.filter((item) => item.epoch !== batchEpoch)
            if (currentEpoch === batchEpoch) {
              currentEpoch = receipt.epoch
              pending = bindUnstamped(pending, receipt.epoch)
            }
          } else {
            const sent = new Set(batch)
            pending = pending.filter((item) => !sent.has(item))
          }
          retries = 0
          schedule(0)
          return undefined
        }
        retries++
        schedule(retryDelay())
        return undefined
      })
      .catch(() => {
        if (stopped) return
        retries++
        schedule(retryDelay())
      })
      .finally(() => {
        inFlight = false
        if (!stopped && pending.length > 0 && cancel === null) schedule(storedDelay())
      })
  }
  const storedDelay = (): number => (retries === 0 ? 0 : retryDelay())

  return {
    enqueue: (records) => {
      if (stopped || records.length === 0) return { tag: 'accepted', accepted: 0 }
      let accepted = 0
      let capacityDiscarded = 0
      let invalidDiscarded = 0
      let oversizeDiscarded = 0
      for (const record of records) {
        const bytes = measureJsonBytes(record, byteLimits.maxRecordBytes)
        if (bytes === undefined) {
          oversizeDiscarded++
          continue
        }
        if (!isValidTweetRecord(record)) {
          invalidDiscarded++
          continue
        }
        if (pending.length >= deps.maxPending) {
          capacityDiscarded++
          continue
        }
        pending.push({ record, bytes, epoch: currentEpoch })
        accepted++
      }
      schedule(pending.length >= deps.maxBatch ? 0 : deps.debounceMs)
      return capacityDiscarded === 0 && invalidDiscarded === 0 && oversizeDiscarded === 0
        ? { tag: 'accepted', accepted }
        : {
            tag: 'dropped',
            accepted,
            capacityDiscarded,
            invalidDiscarded,
            oversizeDiscarded,
          }
    },
    invalidateEpoch: () => {
      currentEpoch = undefined
    },
    advanceEpoch: (epoch) => {
      if (!Schema.is(CaptureEpoch)(epoch)) throw new TypeError('Invalid capture buffer epoch')
      currentEpoch = epoch
      pending = bindUnstamped(pending, epoch)
      schedule(0)
    },
    flush,
    stop: () => {
      stopped = true
      cancel?.()
      cancel = null
    },
    get pending() {
      return pending.length
    },
  }
}

interface PendingCapture {
  readonly record: TweetRecordType
  /** Immutable once assigned. Undefined means intake happened behind a refresh barrier. */
  readonly epoch: CaptureEpoch | undefined
  /** Exact JSON UTF-8 size measured once at intake. */
  readonly bytes: number
}

const bindUnstamped = (
  pending: ReadonlyArray<PendingCapture>,
  epoch: CaptureEpoch,
): PendingCapture[] => pending.map((item) => (item.epoch === undefined ? { ...item, epoch } : item))

/** A rejected worker schema must be impossible to retry forever from this tab. */
const isValidTweetRecord = (value: unknown): value is TweetRecordType => {
  try {
    return Schema.is(TweetRecord)(value)
  } catch {
    return false
  }
}

const captureEnvelopeBytes = (epoch: CaptureEpoch): number => {
  const bytes = measureJsonBytes(
    { _tag: 'CaptureTweets', epoch, records: [] },
    Number.MAX_SAFE_INTEGER,
  )
  if (bytes === undefined) throw new Error('CaptureTweets envelope must be valid JSON')
  return bytes
}

const MAX_CAPTURE_ENVELOPE_BYTES = captureEnvelopeBytes('x'.repeat(MAX_CAPTURE_EPOCH_LENGTH))

/** Records are premeasured; adding JSON array commas yields the exact wire size. */
const takeBatch = (
  pending: ReadonlyArray<PendingCapture>,
  maxBatch: number,
  maxMessageBytes: number,
): PendingCapture[] => {
  const batch: PendingCapture[] = []
  const epoch = pending[0]?.epoch
  if (epoch === undefined) return batch
  let bytes = captureEnvelopeBytes(epoch)
  for (const item of pending) {
    if (batch.length === maxBatch || item.epoch !== epoch) break
    const next = bytes + (batch.length === 0 ? 0 : 1) + item.bytes
    if (next > maxMessageBytes) break
    batch.push(item)
    bytes = next
  }
  return batch
}

const positiveSafeInteger = (
  name: string,
  value: number,
  maximum = Number.MAX_SAFE_INTEGER,
): void => {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new TypeError(`Invalid capture buffer ${name}: ${value}`)
}

const nonNegativeSafeInteger = (name: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`Invalid capture buffer ${name}: ${value}`)
}

const validateCaptureBufferDeps = (deps: {
  readonly maxBatch: number
  readonly maxPending: number
  readonly debounceMs: number
  readonly retryBaseMs: number
  readonly retryMaxMs: number
  readonly maxRecordBytes?: number
  readonly maxMessageBytes?: number
}): { readonly maxRecordBytes: number; readonly maxMessageBytes: number } => {
  const maxRecordBytes = deps.maxRecordBytes ?? MAX_CAPTURE_RECORD_BYTES
  const maxMessageBytes = deps.maxMessageBytes ?? MAX_CAPTURE_MESSAGE_BYTES
  positiveSafeInteger('maxBatch', deps.maxBatch, MAX_CAPTURE_BATCH)
  positiveSafeInteger('maxPending', deps.maxPending, MAX_CAPTURE_PENDING)
  if (deps.maxBatch > deps.maxPending)
    throw new TypeError('Invalid capture buffer: maxBatch cannot exceed maxPending')
  nonNegativeSafeInteger('debounceMs', deps.debounceMs)
  positiveSafeInteger('retryBaseMs', deps.retryBaseMs)
  positiveSafeInteger('retryMaxMs', deps.retryMaxMs)
  if (deps.retryMaxMs < deps.retryBaseMs)
    throw new TypeError('Invalid capture buffer: retryMaxMs cannot be less than retryBaseMs')
  positiveSafeInteger('maxRecordBytes', maxRecordBytes, MAX_CAPTURE_RECORD_BYTES)
  positiveSafeInteger('maxMessageBytes', maxMessageBytes, MAX_CAPTURE_MESSAGE_BYTES)
  if (maxMessageBytes <= MAX_CAPTURE_ENVELOPE_BYTES)
    throw new TypeError('Invalid capture buffer: maxMessageBytes cannot fit a record')
  return {
    maxRecordBytes: Math.min(maxRecordBytes, maxMessageBytes - MAX_CAPTURE_ENVELOPE_BYTES),
    maxMessageBytes,
  }
}
