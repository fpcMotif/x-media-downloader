import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

// Mirror of `src/core/sync/events.ts` (SyncMediaMeta / SyncEvent). Metadata
// only by construction — there are no fields for captures, headers, or bytes.
// Exported as the single source of truth for the wire shape so sync.ts reuses
// them rather than re-declaring (and silently drifting from) these validators.
export const kind = v.union(v.literal('queued'), v.literal('completed'), v.literal('failed'))

export const media = v.object({
  tweetId: v.string(),
  handle: v.string(),
  type: v.string(),
  url: v.string(),
  ext: v.string(),
  index: v.number(),
})

// The `sync_events` row field shape (sans Convex system fields). The table
// below is defined from these fields; sync.ts imports them for its arg and
// return validators.
export const syncEventFields = {
  eventId: v.string(),
  kind,
  requestId: v.string(),
  deviceId: v.string(),
  at: v.number(),
  media: v.optional(media),
}

export default defineSchema({
  // Append-only ledger of extension state transitions (ADR-0009). `eventId`
  // is the client's deterministic idempotency key: at-least-once delivery
  // from the extension outbox becomes exactly-once recording here.
  sync_events: defineTable(syncEventFields)
    .index('by_event_id', ['eventId'])
    .index('by_at', ['at']),

  // Latest state per request — the URL/state cache view that Phase 2 export
  // jobs will read (see docs/plans/2026-06-11-…/handoff-phase-2-3.md).
  media_state: defineTable({
    requestId: v.string(),
    deviceId: v.string(),
    lastKind: kind,
    at: v.number(),
    media: v.optional(media),
  })
    .index('by_device_request', ['deviceId', 'requestId'])
    .index('by_at', ['at']),

  // Cloud byte-upload ledger mirror (ADR-0013). Control plane ONLY — bytes never
  // transit Convex; they go extension → provider (Drive/Dropbox) directly. This
  // mirrors the extension's durable local ledger so upload status is visible
  // cross-device. `jobId` (`${deviceId}/${requestId}/${provider}`) is the
  // idempotency key; last-write-wins by `at`.
  upload_jobs: defineTable({
    jobId: v.string(),
    deviceId: v.string(),
    requestId: v.string(),
    provider: v.union(v.literal('gdrive'), v.literal('dropbox')),
    status: v.union(
      v.literal('pending'),
      v.literal('uploading'),
      v.literal('succeeded'),
      v.literal('failed'),
      v.literal('dead'),
      v.literal('skipped'),
    ),
    attempts: v.number(),
    at: v.number(),
    remotePath: v.optional(v.string()),
    bytes: v.optional(v.number()),
    error: v.optional(v.string()),
  })
    .index('by_job', ['jobId'])
    .index('by_at', ['at']),
})
