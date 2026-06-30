import { Schema } from 'effect'
import { MediaType, type MediaItem } from '../schema'

/**
 * Append-only state transitions mirrored to the cloud control plane
 * (ADR-0009). Media metadata only by construction: the schema has no fields for
 * captures, auth headers, or bytes, and decode drops unknown keys.
 *
 * Scope note: this is the *media* mirror. Tweet TEXT rides a separate, own-opt-in
 * mirror that extends the Convex scope — see ADR-0018.
 */
export const SyncEventKind = Schema.Literals(['queued', 'completed', 'failed'])
export type SyncEventKind = typeof SyncEventKind.Type

/** URL-cache payload: the provenance the cloud ledger keeps per Media Item. */
export const SyncMediaMeta = Schema.Struct({
  tweetId: Schema.String,
  handle: Schema.String,
  type: MediaType,
  url: Schema.String,
  ext: Schema.String,
  index: Schema.Number,
})
export type SyncMediaMeta = typeof SyncMediaMeta.Type

export const SyncEvent = Schema.Struct({
  eventId: Schema.String,
  kind: SyncEventKind,
  requestId: Schema.String,
  deviceId: Schema.String,
  at: Schema.Number,
  media: Schema.optional(SyncMediaMeta),
})
export type SyncEvent = typeof SyncEvent.Type

/** Deterministic idempotency key — a re-sent batch can never double-record. */
export const syncEventId = (deviceId: string, requestId: string, kind: SyncEventKind): string =>
  `${deviceId}/${requestId}/${kind}`

/** The metadata-only provenance payload for a Media Item. Single source for both
 *  the queued Sync Event and the local Download Record, so they reconcile by
 *  construction (and so does Convex `media_state`). */
export function syncMediaFromItem(item: MediaItem): SyncMediaMeta {
  return {
    tweetId: item.tweetId,
    handle: item.handle,
    type: item.type,
    url: item.url,
    ext: item.ext,
    index: item.index,
  }
}

/** A Media Item entered the Download Queue; carries the URL-cache payload. */
export function queuedEvent(item: MediaItem, deviceId: string, at: number): SyncEvent {
  return {
    eventId: syncEventId(deviceId, item.id, 'queued'),
    kind: 'queued',
    requestId: item.id,
    deviceId,
    at,
    media: syncMediaFromItem(item),
  }
}

/** A request reached a terminal state; the queued event already cached its media. */
export function outcomeEvent(
  requestId: string,
  kind: 'completed' | 'failed',
  deviceId: string,
  at: number,
): SyncEvent {
  return { eventId: syncEventId(deviceId, requestId, kind), kind, requestId, deviceId, at }
}
