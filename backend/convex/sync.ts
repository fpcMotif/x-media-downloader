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

/**
 * Idempotent batch ingest for the extension outbox (`POST /api/mutation`,
 * path `sync:recordEvents`). The outbox delivers at-least-once; skipping on a
 * seen `eventId` makes recording exactly-once. Batches are ≤64 events
 * (≤128 doc writes) — far below the 16 MiB / 16k-docs mutation limits.
 *
 * When the `SYNC_SHARED_SECRET` env var is set on the deployment, callers
 * must present it; otherwise the deployment URL itself is the capability.
 */
export const recordEvents = mutation({
  args: { events: v.array(event), secret: v.optional(v.string()) },
  handler: async (ctx, { events, secret }) => {
    const required = process.env.SYNC_SHARED_SECRET
    if (required !== undefined && required !== '' && secret !== required) {
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
  handler: (ctx, { paginationOpts }) =>
    ctx.db.query('sync_events').withIndex('by_at').order('desc').paginate(paginationOpts),
})
