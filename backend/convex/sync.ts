// Codegen-free typed builders (this package must typecheck without a linked
// deployment): derive the DataModel straight from schema.ts — the same thing
// `convex codegen` would emit into `_generated/server`.
import {
  mutationGeneric,
  queryGeneric,
  paginationOptsValidator,
  type DataModelFromSchemaDefinition,
  type MutationBuilder,
  type QueryBuilder,
} from 'convex/server'
import { v } from 'convex/values'
import schema from './schema'

type DataModel = DataModelFromSchemaDefinition<typeof schema>
const mutation = mutationGeneric as MutationBuilder<DataModel, 'public'>
const query = queryGeneric as QueryBuilder<DataModel, 'public'>

const kind = v.union(v.literal('queued'), v.literal('completed'), v.literal('failed'))

const media = v.object({
  tweetId: v.string(),
  handle: v.string(),
  type: v.string(),
  url: v.string(),
  ext: v.string(),
  index: v.number(),
})

const event = v.object({
  eventId: v.string(),
  kind,
  requestId: v.string(),
  deviceId: v.string(),
  at: v.number(),
  media: v.optional(media),
})

// A stored `sync_events` row as returned by reads (the table doc plus Convex's
// system fields). Used for the `recentEvents` return validator.
const syncEventDoc = v.object({
  _id: v.id('sync_events'),
  _creationTime: v.number(),
  eventId: v.string(),
  kind,
  requestId: v.string(),
  deviceId: v.string(),
  at: v.number(),
  media: v.optional(media),
})

/**
 * Idempotent batch ingest for the extension outbox (`POST /api/mutation`,
 * path `sync:recordEvents`). The outbox delivers at-least-once; skipping on a
 * seen `eventId` makes recording exactly-once. Batches are ≤64 events
 * (≤128 doc writes) — far below the 16 MiB / 16k-docs mutation limits.
 *
 * Writes fail closed (ADR-0009 hardening): the deployment MUST set
 * `SYNC_SHARED_SECRET` and the caller MUST present a matching `secret`. A
 * `*.convex.cloud` URL is discoverable and is NOT a write capability, so the
 * URL alone never authorizes an insert.
 */
export const recordEvents = mutation({
  args: { events: v.array(event), secret: v.string() },
  returns: v.object({ received: v.number(), inserted: v.number() }),
  handler: async (ctx, { events, secret }) => {
    const required = process.env.SYNC_SHARED_SECRET
    if (required === undefined || required === '') {
      throw new Error('unauthorized: deployment has no SYNC_SHARED_SECRET configured')
    }
    if (secret !== required) {
      throw new Error('unauthorized: bad or missing sync secret')
    }
    let inserted = 0
    for (const e of events) {
      const seen = await ctx.db
        .query('sync_events')
        .withIndex('by_event_id', (q) => q.eq('eventId', e.eventId))
        .first()
      if (seen !== null) continue
      await ctx.db.insert('sync_events', e)
      inserted += 1

      // Materialize the latest state per request (URL/state cache).
      const row = await ctx.db
        .query('media_state')
        .withIndex('by_device_request', (q) =>
          q.eq('deviceId', e.deviceId).eq('requestId', e.requestId),
        )
        .first()
      const patch = {
        lastKind: e.kind,
        at: e.at,
        ...(e.media !== undefined ? { media: e.media } : {}),
      }
      if (row === null) {
        await ctx.db.insert('media_state', { requestId: e.requestId, deviceId: e.deviceId, ...patch })
      } else if (e.at >= row.at) {
        await ctx.db.patch(row._id, patch)
      }
    }
    return { received: events.length, inserted }
  },
})

/** Newest-first event ledger, cursor-paginated (never fetch 10k rows at once). */
export const recentEvents = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: v.object({
    page: v.array(syncEventDoc),
    isDone: v.boolean(),
    continueCursor: v.string(),
    splitCursor: v.optional(v.union(v.string(), v.null())),
    pageStatus: v.optional(
      v.union(v.literal('SplitRecommended'), v.literal('SplitRequired'), v.null()),
    ),
  }),
  handler: (ctx, { paginationOpts }) =>
    ctx.db.query('sync_events').withIndex('by_at').order('desc').paginate(paginationOpts),
})
