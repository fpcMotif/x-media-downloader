import { Schema } from 'effect'
import type { TweetRecord } from '@/packages/capture/record'

/** Beyond this many queued capture events the oldest are dropped (prolonged offline). */
export const DEFAULT_CAP = 2000
/** Keep one capture mirror mutation small and bounded. */
export const DEFAULT_BATCH = 64

const CaptureLinkSchema = Schema.Struct({
  expandedUrl: Schema.String,
  title: Schema.optional(Schema.String),
  domain: Schema.optional(Schema.String),
})

/**
 * One tweet's mirror-eligible fields, the client-side control-plane payload for the
 * opt-in Convex capture mirror (spec §9). Carries expanded `text` + `links` only
 * (no `rawText`, §15.3); `sourceRank`/`at` ride along so the §6.4 merge rule applies
 * identically cloud-side. `eventId = captureEventId(deviceId, tweetId)` makes the
 * at-least-once enqueue exactly-once.
 */
export const SyncCaptureEvent = Schema.Struct({
  eventId: Schema.String,
  tweetId: Schema.String,
  conversationId: Schema.String,
  inReplyToTweetId: Schema.optional(Schema.String),
  handle: Schema.String,
  text: Schema.String,
  createdAt: Schema.optional(Schema.Number),
  links: Schema.optional(Schema.Array(CaptureLinkSchema)),
  sourceRank: Schema.Number,
  at: Schema.Number,
})
export type SyncCaptureEvent = typeof SyncCaptureEvent.Type

const LedgerSchema = Schema.Array(SyncCaptureEvent)
export type CaptureLedger = ReadonlyArray<SyncCaptureEvent>

const optionalEntry = <K extends string, V>(key: K, v: V | undefined): Record<K, V> | object =>
  v !== undefined ? ({ [key]: v } as Record<K, V>) : {}

/** Deterministic idempotency key `${deviceId}/${tweetId}` — makes at-least-once exactly-once. */
export function captureEventId(deviceId: string, tweetId: string): string {
  return `${deviceId}/${tweetId}`
}

/** Project a {@link TweetRecord} into its mirror event; `deviceId`/`at` injected. */
export function captureEventFromRecord(
  record: TweetRecord,
  deviceId: string,
  at: number,
): SyncCaptureEvent {
  return {
    eventId: captureEventId(deviceId, record.tweetId),
    tweetId: record.tweetId,
    conversationId: record.conversationId,
    ...optionalEntry('inReplyToTweetId', record.inReplyToTweetId),
    handle: record.author.handle,
    text: record.text,
    ...optionalEntry('createdAt', record.createdAt),
    ...optionalEntry(
      'links',
      record.links.length > 0
        ? record.links.map((l) => ({
            expandedUrl: l.expandedUrl,
            ...optionalEntry('title', l.title),
            ...optionalEntry('domain', l.domain),
          }))
        : undefined,
    ),
    sourceRank: record.sourceRank,
    at,
  }
}

/** Append or replace the queued event for the same `tweetId` (newer wins), then cap. */
export function enqueue(
  ledger: CaptureLedger,
  event: SyncCaptureEvent,
  cap: number = DEFAULT_CAP,
): CaptureLedger {
  const without = ledger.filter((e) => e.tweetId !== event.tweetId)
  return capLedger([...without, event], cap)
}

/** Events drainable at `now` (queued at/before now). */
export function readyJobs(
  ledger: CaptureLedger,
  now: number,
  max: number = DEFAULT_BATCH,
): ReadonlyArray<SyncCaptureEvent> {
  return ledger.filter((e) => e.at <= now).slice(0, max)
}

/** Drop a drained event by `eventId`; same reference when it is absent or not yet due. */
export function claim(
  ledger: CaptureLedger,
  eventId: string,
  now: number,
  _leaseMs?: number,
): CaptureLedger {
  const next = ledger.filter((e) => !(e.eventId === eventId && e.at <= now))
  return next.length === ledger.length ? ledger : next
}

/** Bound the ledger at `cap`, dropping the oldest; same reference when nothing drops. */
export function capLedger(ledger: CaptureLedger, cap: number = DEFAULT_CAP): CaptureLedger {
  return ledger.length > cap ? ledger.slice(ledger.length - cap) : ledger
}

/** Decode a persisted ledger; fall back to empty on corrupt data (outbox idiom). */
export function decodeLedger(raw: unknown): CaptureLedger {
  try {
    return Schema.decodeUnknownSync(LedgerSchema)(raw ?? [])
  } catch {
    return []
  }
}
