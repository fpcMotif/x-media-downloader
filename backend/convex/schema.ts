import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

// Mirror of `src/core/sync/events.ts` (SyncMediaMeta / SyncEvent). Metadata
// only by construction — there are no fields for captures, headers, or bytes.
// Exported as the single source of truth for the wire shape so sync.ts reuses
// them rather than re-declaring (and silently drifting from) these validators.
export const kind = v.union(v.literal('queued'), v.literal('completed'), v.literal('failed'))

export const platform = v.union(v.literal('x'), v.literal('instagram'), v.literal('threads'))

// Multi-platform generalization (docs/superpowers/specs/2026-07-04-multi-platform-adapter-design.md):
// `postId`/`author`/`platform` are the new generalized fields the extension's
// SyncMediaMeta now sends on EVERY write (`tweetId`/`handle` are gone from the
// wire payload as of this change). Both old AND new fields stay OPTIONAL here —
// not because new writes omit the new fields, but because existing STORED rows
// (written before this change) still have only `tweetId`/`handle` and a schema
// push validates existing documents too; a required field on either side would
// block the push. `backfillPlatformFields` (in sync.ts) migrates old rows to
// carry the new fields; once verified at 100%, a FOLLOW-UP change drops
// `tweetId`/`handle` entirely and flips `postId`/`author`/`platform` to
// required (the second of the two migration deploys).
export const media = v.object({
  platform: v.optional(platform),
  postId: v.optional(v.string()),
  author: v.optional(v.string()),
  tweetId: v.optional(v.string()),
  handle: v.optional(v.string()),
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

// Tweet Harvest mirror (§9). Validators are the single source of truth: the
// `tweet_captures` table below is defined from `captureRow`, and captures.ts
// imports `captureRow` for its mutation arg validator rather than re-declaring.
export const captureLink = v.object({
  expandedUrl: v.string(),
  title: v.optional(v.string()),
  domain: v.optional(v.string()),
})

export const captureRowFields = {
  captureId: v.string(),
  deviceId: v.string(),
  tweetId: v.string(),
  conversationId: v.string(),
  inReplyToTweetId: v.optional(v.string()),
  handle: v.string(),
  text: v.string(),
  createdAt: v.optional(v.number()),
  links: v.optional(v.array(captureLink)),
  sourceRank: v.number(),
  at: v.number(),
}

export const captureRow = v.object(captureRowFields)

export default defineSchema({
  // Append-only ledger of extension state transitions (ADR-0009). `eventId`
  // is the client's deterministic idempotency key: at-least-once delivery
  // from the extension outbox becomes exactly-once recording here.
  sync_events: defineTable(syncEventFields)
    .index('by_event_id', ['eventId'])
    .index('by_device_request', ['deviceId', 'requestId'])
    .index('by_at', ['at']),

  // Latest state per request — the URL/state cache view that Phase 2 export
  // jobs will read (see docs/plans/2026-06-11-…/handoff-phase-2-3.md).
  media_state: defineTable({
    requestId: v.string(),
    deviceId: v.string(),
    // Optional for backward compatibility: rows written before the saved-status
    // `tweetId` column existed lack it entirely, so a required validator blocks the
    // whole schema push (and with it every other table, incl. tweet_captures). The
    // sync.ts backfill derives it from `media.tweetId`; new rows always set it.
    tweetId: v.optional(v.string()),
    // Generalized twins of `tweetId`/`handle` (multi-platform design, see the
    // `media` comment above). `postId`/`author`/`platform` stay optional while
    // old rows exist; `backfillPlatformFields` fills them, and new rows always
    // set all three. `by_tweet` stays until a follow-up
    // change removes `tweetId` entirely; `by_post`/`by_platform_post` are the
    // NEW indexes future queries should use.
    postId: v.optional(v.string()),
    platform: v.optional(platform),
    // Same staged migration as postId/platform. New projections always write
    // it; the optional validator keeps deploy 1 compatible with stored X rows.
    author: v.optional(v.string()),
    lastKind: kind,
    at: v.number(),
    media: v.optional(media),
  })
    .index('by_device_request', ['deviceId', 'requestId'])
    .index('by_request_id', ['requestId'])
    .index('by_tweet', ['tweetId'])
    .index('by_post', ['postId'])
    .index('by_platform_post', ['platform', 'postId'])
    .index('by_at', ['at']),

  // Cloud byte-upload ledger mirror (ADR-0013). Control plane ONLY — bytes never
  // transit Convex; they go extension → provider (Drive/Dropbox) directly. This
  // mirrors the extension's durable local ledger so upload status is visible
  // cross-device. New `jobId` values are length-delimited v2 tuples. The
  // mutation accepts exact old tuples only for deployed-client compatibility.
  // It derives either form server-side; callers cannot choose an identity.
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
    // Optional during the deployed-row/client migration. New clients always send
    // a positive lease revision after settlement.
    revision: v.optional(v.number()),
    at: v.number(),
    remotePath: v.optional(v.string()),
    bytes: v.optional(v.number()),
    error: v.optional(v.string()),
  })
    .index('by_job', ['jobId'])
    .index('by_at', ['at']),

  // Server-owned cursor and total for the deploy-2 platform-field audit. A
  // stateless final page cannot prove earlier pages were clean.
  platform_backfill_audits: defineTable({
    mediaStateCursor: v.optional(v.string()),
    mediaStateDone: v.boolean(),
    syncEventsCursor: v.optional(v.string()),
    syncEventsDone: v.boolean(),
    remaining: v.number(),
    done: v.boolean(),
  }),

  // Tweet Harvest "Capture" mirror (§9). Best-effort cloud mirror of the
  // extension's local TweetRecord store; IndexedDB remains source of truth.
  // `captureId` is the client's length-delimited, injective idempotency key.
  // Upserts apply the §6.4 rank-then-`at` merge (NOT last-write-wins) so a thin
  // timeline sighting never overwrites a rich TweetDetail row.
  tweet_captures: defineTable(captureRow)
    .index('by_capture_id', ['captureId'])
    .index('by_conversation', ['conversationId'])
    .index('by_conversation_at', ['conversationId', 'at'])
    .index('by_device_at', ['deviceId', 'at'])
    .index('by_device_conversation_at', ['deviceId', 'conversationId', 'at'])
    .index('by_at', ['at']),
})
