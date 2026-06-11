import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

// Mirror of `src/core/sync/events.ts` (SyncMediaMeta / SyncEvent). Metadata
// only by construction — there are no fields for captures, headers, or bytes.
const kind = v.union(v.literal('queued'), v.literal('completed'), v.literal('failed'))

const media = v.object({
  tweetId: v.string(),
  handle: v.string(),
  type: v.string(),
  url: v.string(),
  ext: v.string(),
  index: v.number(),
})

export default defineSchema({
  // Append-only ledger of extension state transitions (ADR-0009). `eventId`
  // is the client's deterministic idempotency key: at-least-once delivery
  // from the extension outbox becomes exactly-once recording here.
  sync_events: defineTable({
    eventId: v.string(),
    kind,
    requestId: v.string(),
    deviceId: v.string(),
    at: v.number(),
    media: v.optional(media),
  })
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
})
