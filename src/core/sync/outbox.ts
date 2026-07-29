import { Schema } from 'effect'
import { isJsonWithinByteBudget } from '../wire/json-budget'
import {
  LegacySyncMediaMeta,
  SyncDeviceId,
  SyncEventAt,
  SyncEventId,
  SyncEventKind,
  SyncEvent,
  SyncMediaMeta,
  SyncRequestId,
  syncMediaFromLegacy,
  syncEventId,
  syncEventIdVersion,
} from './events'

/** Beyond this many undrained events the oldest are dropped (prolonged offline). */
export const DEFAULT_CAP = 2000
/** ≤64 events per drain ⇒ ≤128 Convex doc writes — far under platform limits. */
export const DEFAULT_BATCH = 64
/** One event includes at most one bounded media URL plus its metadata. */
export const MAX_SYNC_EVENT_BYTES = 16 * 1024
/** Exact upper bound for a full, capped JSON ledger including array separators. */
export const MAX_SYNC_OUTBOX_BYTES = DEFAULT_CAP * (MAX_SYNC_EVENT_BYTES + 1) + 256
const BACKOFF_BASE_MS = 5_000
const BACKOFF_CAP_MS = 300_000
const BACKOFF_CAP_FAILURE_COUNT = 7

const DurableSyncEvent = Schema.Struct({
  eventId: SyncEventId,
  kind: SyncEventKind,
  requestId: SyncRequestId,
  deviceId: SyncDeviceId,
  at: SyncEventAt,
  media: Schema.optional(SyncMediaMeta),
})

const LegacyDurableSyncEvent = Schema.Struct({
  eventId: SyncEventId,
  kind: SyncEventKind,
  requestId: SyncRequestId,
  deviceId: SyncDeviceId,
  at: SyncEventAt,
  media: Schema.optional(LegacySyncMediaMeta),
})

const OutboxStateSchema = Schema.Struct({
  pending: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(DEFAULT_CAP)),
  consecutiveFailures: SyncEventAt,
  nextAttemptAt: SyncEventAt,
})
export interface OutboxState {
  readonly pending: ReadonlyArray<SyncEvent>
  readonly consecutiveFailures: number
  readonly nextAttemptAt: number
}
export type OutboxDecodeResult =
  | { readonly ok: true; readonly state: OutboxState }
  | { readonly ok: false }

export const emptyOutbox: OutboxState = { pending: [], consecutiveFailures: 0, nextAttemptAt: 0 }

const hasValidMediaUrl = (event: SyncEvent): boolean => {
  if (event.kind !== 'queued') return true
  try {
    return new URL(event.media.url).protocol === 'https:'
  } catch {
    return false
  }
}

const decodeDurableEvent = (
  raw: unknown,
): { readonly event: SyncEvent; readonly mediaVersion: 'current' | 'legacy' } | undefined => {
  try {
    const current = Schema.decodeUnknownSync(DurableSyncEvent, {
      onExcessProperty: 'error',
    })(raw)
    return {
      event: Schema.decodeUnknownSync(SyncEvent, { onExcessProperty: 'error' })(current),
      mediaVersion: 'current',
    }
  } catch {
    try {
      const legacy = Schema.decodeUnknownSync(LegacyDurableSyncEvent, {
        onExcessProperty: 'error',
      })(raw)
      const { media, ...fields } = legacy
      const candidate = {
        ...fields,
        ...(media === undefined
          ? {}
          : {
              media: syncMediaFromLegacy(media),
            }),
      }
      return {
        mediaVersion: 'legacy',
        event: Schema.decodeUnknownSync(SyncEvent, { onExcessProperty: 'error' })(candidate),
      }
    } catch {
      return undefined
    }
  }
}

const decodeEvent = (raw: unknown, allowLegacy: boolean): SyncEvent | undefined => {
  if (!isJsonWithinByteBudget(raw, MAX_SYNC_EVENT_BYTES)) return undefined
  const decoded = decodeDurableEvent(raw)
  if (decoded === undefined || !isJsonWithinByteBudget(decoded.event, MAX_SYNC_EVENT_BYTES))
    return undefined
  const { event } = decoded
  try {
    const version = syncEventIdVersion(event.eventId, event.deviceId, event.requestId, event.kind)
    if (version === undefined || (!allowLegacy && version === 'legacy')) return undefined
    if (decoded.mediaVersion === 'legacy' && version !== 'legacy') return undefined
    if (!hasValidMediaUrl(event)) return undefined
    return event
  } catch {
    return undefined
  }
}

/** Canonical identity of one logical transition, independent of its wire version. */
const logicalEventId = (event: SyncEvent): string =>
  syncEventId(event.deviceId, event.requestId, event.kind)

/**
 * Pure reducer over the local outbox (ADR-0008 precedent: injected timestamps,
 * no Effect, no I/O). The background SW persists the state to `storage.local`
 * and drains it FIFO; idempotent eventIds make at-least-once delivery safe.
 */
export function decodeOutboxResult(raw: unknown): OutboxDecodeResult {
  if (raw === null || raw === undefined) return { ok: true, state: emptyOutbox }
  if (!isJsonWithinByteBudget(raw, MAX_SYNC_OUTBOX_BYTES)) return { ok: false }
  try {
    const state = Schema.decodeUnknownSync(OutboxStateSchema, {
      onExcessProperty: 'error',
    })(raw)
    const seenEventIds = new Set<string>()
    const seenLogicalIds = new Set<string>()
    const pending: SyncEvent[] = []
    for (const rawEvent of state.pending) {
      const event = decodeEvent(rawEvent, true)
      if (event === undefined || seenEventIds.has(event.eventId)) return { ok: false }
      seenEventIds.add(event.eventId)
      const logicalId = logicalEventId(event)
      // A worker update can replay one durable v0 event through the v1 producer.
      // Keep the first representation so an already-sent legacy retry stays safe
      // against a backend that has not yet deployed alias-aware deduplication.
      if (seenLogicalIds.has(logicalId)) continue
      seenLogicalIds.add(logicalId)
      pending.push(event)
    }
    return { ok: true, state: { ...state, pending } }
  } catch {
    return { ok: false }
  }
}

/** Append preserving order; one logical transition survives across identity versions. */
export function append(
  state: OutboxState,
  events: ReadonlyArray<SyncEvent>,
  cap: number = DEFAULT_CAP,
): OutboxState {
  const limit = Number.isFinite(cap)
    ? Math.min(DEFAULT_CAP, Math.max(0, Math.floor(cap)))
    : DEFAULT_CAP
  const seenEventIds = new Set<string>()
  const seenLogicalIds = new Set<string>()
  const next: SyncEvent[] = []
  // Existing decoded records may use the legacy identity. New callers may not
  // create one: only an already-durable v0 record gets compatibility treatment.
  for (const [candidates, allowLegacy] of [
    [state.pending, true],
    [events, false],
  ] as const) {
    for (const candidate of candidates) {
      const event = decodeEvent(candidate, allowLegacy)
      if (event === undefined || seenEventIds.has(event.eventId)) continue
      seenEventIds.add(event.eventId)
      const logicalId = logicalEventId(event)
      if (seenLogicalIds.has(logicalId)) continue
      seenLogicalIds.add(logicalId)
      next.push(event)
    }
  }
  return { ...state, pending: next.length > limit ? next.slice(next.length - limit) : next }
}

export function takeBatch(
  state: OutboxState,
  max: number = DEFAULT_BATCH,
): ReadonlyArray<SyncEvent> {
  const limit = Number.isSafeInteger(max) && max >= 0 ? Math.min(max, DEFAULT_BATCH) : DEFAULT_BATCH
  return state.pending.slice(0, limit)
}

/** A batch was accepted by the server: drop it and reset the backoff. */
export function markDrained(state: OutboxState, sentIds: ReadonlyArray<string>): OutboxState {
  const sent = new Set(sentIds)
  return {
    pending: state.pending.filter((e) => !sent.has(e.eventId)),
    consecutiveFailures: 0,
    nextAttemptAt: 0,
  }
}

/** A drain failed: exponential backoff (5s · 2ⁿ, capped at 5 min). */
export function markFailed(state: OutboxState, now: number): OutboxState {
  if (!Number.isSafeInteger(now) || now < 0)
    throw new RangeError('Sync retry time must be a nonnegative safe integer')
  const delay = Math.min(BACKOFF_BASE_MS * 2 ** state.consecutiveFailures, BACKOFF_CAP_MS)
  return {
    ...state,
    consecutiveFailures: Math.min(Number.MAX_SAFE_INTEGER, state.consecutiveFailures + 1),
    nextAttemptAt: Math.min(Number.MAX_SAFE_INTEGER, now + delay),
  }
}

const retryDelayForFailureCount = (consecutiveFailures: number): number =>
  consecutiveFailures >= BACKOFF_CAP_FAILURE_COUNT
    ? BACKOFF_CAP_MS
    : BACKOFF_BASE_MS * 2 ** Math.max(0, consecutiveFailures - 1)

/**
 * Bounds a persisted absolute retry deadline after wall-clock rollback.
 *
 * The failure count proves the longest legitimate remaining wait. Rebase uses
 * durable state only, so it remains correct across service-worker replacement.
 */
export function rebaseRetryDeadline(state: OutboxState, now: number): OutboxState {
  if (!Number.isSafeInteger(now) || now < 0)
    throw new RangeError('Sync retry time must be a nonnegative safe integer')
  if (state.nextAttemptAt <= now) return state
  const boundedDeadline = Math.min(
    Number.MAX_SAFE_INTEGER,
    now + retryDelayForFailureCount(state.consecutiveFailures),
  )
  return state.nextAttemptAt <= boundedDeadline
    ? state
    : { ...state, nextAttemptAt: boundedDeadline }
}

export function isReady(state: OutboxState, now: number): boolean {
  return now >= state.nextAttemptAt
}
