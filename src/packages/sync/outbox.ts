import { Schema } from 'effect'
import { SyncEvent } from './events'
import { type BackoffPolicy, expBackoffMs } from '@/packages/kernel/backoff'
import type { JsonValue } from '@/packages/schema'

/** Beyond this many undrained events the oldest are dropped (prolonged offline). */
export const DEFAULT_CAP = 2000
/** ≤64 events per drain ⇒ ≤128 Convex doc writes — far under platform limits. */
export const DEFAULT_BATCH = 64

// Unlike the cloud ledger, nothing bounds consecutiveFailures — a device offline
// for a day keeps failing — so this is the one ladder that actually reaches its cap
// (at 6 failures: 5s·2⁶ = 320s > 300s).
const DRAIN_BACKOFF = { baseMs: 5_000, capMs: 300_000 } satisfies BackoffPolicy

const OutboxStateSchema = Schema.Struct({
  pending: Schema.Array(SyncEvent),
  // Finite-only: a poisoned NaN/Infinity here makes isReady() false forever and
  // wedges drainOutbox, so non-finite values must decode-fail into emptyOutbox.
  consecutiveFailures: Schema.Finite,
  nextAttemptAt: Schema.Finite,
})
export type OutboxState = typeof OutboxStateSchema.Type

export const emptyOutbox: OutboxState = { pending: [], consecutiveFailures: 0, nextAttemptAt: 0 }

/**
 * Pure reducer over the local outbox (ADR-0008 precedent: injected timestamps,
 * no Effect, no I/O). The background SW persists the state to `storage.local`
 * and drains it FIFO; idempotent eventIds make at-least-once delivery safe.
 */
export function decodeOutbox(raw: JsonValue | undefined): OutboxState {
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

/**
 * A drain failed: bump the failure count and set `nextAttemptAt` from it.
 *
 * The ladder is 0-BASED on `consecutiveFailures` — the first failure reads 0 and
 * waits the 5s base — so the delay a call sets is the one for the failure it is
 * recording, not the one after. Contrast the 1-based `backoffMs` in
 * `@/packages/cloud`. `now` is milliseconds on the same clock as `nextAttemptAt`.
 */
export function markFailed(state: OutboxState, now: number): OutboxState {
  const delay = expBackoffMs(state.consecutiveFailures, DRAIN_BACKOFF)
  return {
    ...state,
    consecutiveFailures: state.consecutiveFailures + 1,
    nextAttemptAt: now + delay,
  }
}

export function isReady(state: OutboxState, now: number): boolean {
  return now >= state.nextAttemptAt
}
