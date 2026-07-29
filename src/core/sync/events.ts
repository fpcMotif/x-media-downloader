import { Schema } from 'effect'
import {
  MediaAuthor,
  MediaExtension,
  MediaIndex,
  MediaPostId,
  MediaType,
  MediaUrl,
  Platform,
  type MediaItem,
} from '../schema/media'
import { MAX_SAVE_REQUEST_ID_LENGTH, mediaRequestId } from '../download/request-identity'
import { MAX_CLOUD_DEVICE_ID_LENGTH } from '../schema/settings'

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

/** URL-cache payload: the provenance the cloud ledger keeps per Media Item.
 *  Mirrors `backend/convex/schema.ts`'s `media` validator field-for-field —
 *  keep the two in sync (multi-platform design). */
export const SyncMediaMeta = Schema.Struct({
  platform: Platform,
  postId: MediaPostId,
  author: MediaAuthor,
  type: MediaType,
  url: MediaUrl,
  ext: MediaExtension,
  index: MediaIndex,
})
export type SyncMediaMeta = typeof SyncMediaMeta.Type

/** Pre-platform durable media shape. Decode-only; new events use `SyncMediaMeta`. */
export const LegacySyncMediaMeta = Schema.Struct({
  tweetId: MediaPostId,
  handle: MediaAuthor,
  type: MediaType,
  url: MediaUrl,
  ext: MediaExtension,
  index: MediaIndex,
})
export type LegacySyncMediaMeta = typeof LegacySyncMediaMeta.Type

/** Normalize one deployed X-only media payload into the current domain. */
export const syncMediaFromLegacy = (media: LegacySyncMediaMeta): SyncMediaMeta => ({
  platform: 'x',
  postId: media.tweetId,
  author: media.handle,
  type: media.type,
  url: media.url,
  ext: media.ext,
  index: media.index,
})

/** Prefix for the current, injective sync-event identity format. */
export const SYNC_EVENT_ID_V1_PREFIX = 'xmd-sync:v1:'

/**
 * Pre-v1 identity. Keep this only to drain records already persisted by older
 * extension versions. New events must use {@link syncEventId}.
 */
export const legacySyncEventId = (
  deviceId: string,
  requestId: string,
  kind: SyncEventKind,
): string => `${deviceId}/${requestId}/${kind}`

const isLegacyField = (value: string): boolean => value.length > 0 && !value.includes('/')

/**
 * Deterministic, injective idempotency key. Length-prefixing keeps arbitrary
 * bounded device and request IDs distinct, including IDs containing `/`.
 */
export const syncEventId = (deviceId: string, requestId: string, kind: SyncEventKind): string =>
  `${SYNC_EVENT_ID_V1_PREFIX}${deviceId.length}:${deviceId}:${requestId.length}:${requestId}:${kind}`

/** The identity version proved by this event's fields, if any. */
export const syncEventIdVersion = (
  eventId: string,
  deviceId: string,
  requestId: string,
  kind: SyncEventKind,
): 'v1' | 'legacy' | undefined => {
  if (eventId === syncEventId(deviceId, requestId, kind)) return 'v1'
  if (
    isLegacyField(deviceId) &&
    isLegacyField(requestId) &&
    eventId === legacySyncEventId(deviceId, requestId, kind)
  )
    return 'legacy'
  return undefined
}

export const MAX_SYNC_EVENT_ID_LENGTH = Math.max(
  syncEventId(
    'd'.repeat(MAX_CLOUD_DEVICE_ID_LENGTH),
    'r'.repeat(MAX_SAVE_REQUEST_ID_LENGTH),
    'completed',
  ).length,
  legacySyncEventId(
    'd'.repeat(MAX_CLOUD_DEVICE_ID_LENGTH),
    'r'.repeat(MAX_SAVE_REQUEST_ID_LENGTH),
    'completed',
  ).length,
)

export const SyncEventId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_SYNC_EVENT_ID_LENGTH),
)
export const SyncRequestId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_SAVE_REQUEST_ID_LENGTH),
)
export const SyncDeviceId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_CLOUD_DEVICE_ID_LENGTH),
)
export const SyncEventAt = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
)

const syncEventFields = {
  eventId: SyncEventId,
  requestId: SyncRequestId,
  deviceId: SyncDeviceId,
  at: SyncEventAt,
} as const

export const SyncEvent = Schema.Union([
  Schema.Struct({
    ...syncEventFields,
    kind: Schema.Literal('queued'),
    media: SyncMediaMeta,
  }),
  Schema.Struct({
    ...syncEventFields,
    kind: Schema.Literals(['completed', 'failed']),
  }),
])
export type SyncEvent = typeof SyncEvent.Type
export type QueuedSyncEvent = Extract<SyncEvent, { readonly kind: 'queued' }>
export type OutcomeSyncEvent = Extract<SyncEvent, { readonly kind: 'completed' | 'failed' }>

/** The metadata-only provenance payload for a Media Item. Single source for both
 *  the queued Sync Event and the local Download Record, so they reconcile by
 *  construction (and so does Convex `media_state`). */
export function syncMediaFromItem(item: MediaItem): SyncMediaMeta {
  return {
    platform: item.platform,
    postId: item.postId,
    author: item.author,
    type: item.type,
    url: item.url,
    ext: item.ext,
    index: item.index,
  }
}

/** A Media Item entered the Download Queue; carries the URL-cache payload. */
export function queuedEvent(
  item: MediaItem,
  deviceId: string,
  at: number,
  requestId = mediaRequestId(item),
): QueuedSyncEvent {
  return {
    eventId: syncEventId(deviceId, requestId, 'queued'),
    kind: 'queued',
    requestId,
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
): OutcomeSyncEvent {
  return { eventId: syncEventId(deviceId, requestId, kind), kind, requestId, deviceId, at }
}
