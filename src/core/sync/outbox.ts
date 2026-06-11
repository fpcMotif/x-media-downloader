import { Schema } from 'effect'
import { SyncEvent } from './events'

/** Beyond this many undrained events the oldest are dropped (prolonged offline). */
export const DEFAULT_CAP = 2000
/** ≤64 events per drain ⇒ ≤128 Convex doc writes — far under platform limits. */
export const DEFAULT_BATCH = 64
const BACKOFF_BASE_MS = 5_000
const BACKOFF_CAP_MS = 300_000

const OutboxStateSchema = Schema.Struct({
  pending: Schema.Array(SyncEvent),
  consecutiveFailures: Schema.Number,
  nextAttemptAt: Schema.Number,
})
export type OutboxState = typeof OutboxStateSchema.Type

export const emptyOutbox: OutboxState = { pending: [], consecutiveFailures: 0, nextAttemptAt: 0 }

/**
 * Pure reducer over the local outbox (ADR-0008 precedent: injected timestamps,
 * no Effect, no I/O). The background SW persists the state to `storage.local`
 * and drains it FIFO; idempotent eventIds make at-least-once delivery safe.
 */
export function decodeOutbox(raw: unknown): OutboxState {
  try {
    return Schema.decodeUnknownSync(OutboxStateSchema)(raw)
  } catch {
    return emptyOutbox
  }
}

/** Append preserving order; duplicates (by eventId) are dropped, oldest overflow trimmed. */
export function append(
  state: OutboxState,
  events: ReadonlyArray<SyncEvent>,
  cap: number = DEFAULT_CAP,
): OutboxState {
  const seen = new Set(state.pending.map((e) => e.eventId))
  const next = [...state.pending]
  for (const e of events) {
    if (seen.has(e.eventId)) continue
    seen.add(e.eventId)
    next.push(e)
  }
  return { ...state, pending: next.length > cap ? next.slice(next.length - cap) : next }
}

export function takeBatch(
  state: OutboxState,
  max: number = DEFAULT_BATCH,
): ReadonlyArray<SyncEvent> {
  return state.pending.slice(0, max)
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
  const delay = Math.min(BACKOFF_BASE_MS * 2 ** state.consecutiveFailures, BACKOFF_CAP_MS)
  return {
    ...state,
    consecutiveFailures: state.consecutiveFailures + 1,
    nextAttemptAt: now + delay,
  }
}

export function isReady(state: OutboxState, now: number): boolean {
  return now >= state.nextAttemptAt
}
