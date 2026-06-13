import { Schema } from 'effect'
import type { MediaItem } from '../schema'
import { SyncMediaMeta } from '../sync/events'

/**
 * Durable local download record (the local-first twin of a Convex `media_state`
 * row): same `requestId` key and the same `SyncMediaMeta` provenance payload
 * (incl. `url`, the original link), so the local store and the opt-in Convex
 * mirror cannot drift.
 */
export const DownloadStatus = Schema.Literals(['queued', 'completed', 'failed'])
export type DownloadStatus = typeof DownloadStatus.Type

export const DownloadRecord = Schema.Struct({
  requestId: Schema.String,
  filename: Schema.String,
  status: DownloadStatus,
  media: SyncMediaMeta,
  bytesReceived: Schema.optional(Schema.Number),
  bytesTotal: Schema.optional(Schema.Number),
  queuedAt: Schema.Number,
  finishedAt: Schema.optional(Schema.Number),
})
export type DownloadRecord = typeof DownloadRecord.Type

/** A Save Request entered the queue; carries the original link + provenance. */
export function recordFromMediaItem(item: MediaItem, filename: string, at: number): DownloadRecord {
  return {
    requestId: item.id,
    filename,
    status: 'queued',
    media: {
      tweetId: item.tweetId,
      handle: item.handle,
      type: item.type,
      url: item.url,
      ext: item.ext,
      index: item.index,
    },
    queuedAt: at,
  }
}

/** A request reached a terminal state; updates status/finishedAt without mutating the input. */
export function applyOutcome(
  record: DownloadRecord,
  kind: 'completed' | 'failed',
  at: number,
  bytes?: { received: number; total: number },
): DownloadRecord {
  return {
    ...record,
    status: kind,
    finishedAt: at,
    ...(bytes !== undefined ? { bytesReceived: bytes.received, bytesTotal: bytes.total } : {}),
  }
}
