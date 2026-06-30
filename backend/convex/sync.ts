// Codegen-free typed builders (this package must typecheck without a linked
// deployment): derive the DataModel straight from schema.ts — the same thing
// `convex codegen` would emit into `_generated/server`.
import {
  mutationGeneric,
  queryGeneric,
  paginationOptsValidator,
  type DataModelFromSchemaDefinition,
  type GenericMutationCtx,
  type MutationBuilder,
  type QueryBuilder,
} from 'convex/server'
import { v, type Infer } from 'convex/values'
import schema, { syncEventFields } from './schema'
import { assertSecret } from './auth'

type DataModel = DataModelFromSchemaDefinition<typeof schema>
type Ctx = GenericMutationCtx<DataModel>
const mutation = mutationGeneric as MutationBuilder<DataModel, 'public'>
const query = queryGeneric as QueryBuilder<DataModel, 'public'>

// The `sync_events` wire shape comes from schema.ts (single source of truth).
const event = v.object(syncEventFields)
type SyncEvent = Infer<typeof event>

// A stored `sync_events` row as returned by reads (the table doc plus Convex's
// system fields). Used for the `recentEvents` return validator.
const syncEventDoc = v.object({
  _id: v.id('sync_events'),
  _creationTime: v.number(),
  ...syncEventFields,
})

// Materialize the latest state per request (URL/state cache), last-write-wins
// by `at`. Media is only carried forward when the event supplies it.
async function materializeState(ctx: Ctx, e: SyncEvent): Promise<void> {
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
    assertSecret(secret)
    let inserted = 0
    for (const e of events) {
      const seen = await ctx.db
        .query('sync_events')
        .withIndex('by_event_id', (q) => q.eq('eventId', e.eventId))
        .first()
      if (seen !== null) continue
      await ctx.db.insert('sync_events', e)
      inserted += 1
      await materializeState(ctx, e)
    }
    return { received: events.length, inserted }
  },
})

/**
 * Newest-first event ledger, cursor-paginated (never fetch 10k rows at once).
 * Reads fail closed on the same shared secret as the writes (ADR-0009 hardening):
 * a discoverable `*.convex.cloud` URL must NOT expose the sync ledger (media
 * urls/tweetIds/handles, device + request ids) to an unauthenticated caller.
 */
export const recentEvents = query({
  args: { paginationOpts: paginationOptsValidator, secret: v.string() },
  returns: v.object({
    page: v.array(syncEventDoc),
    isDone: v.boolean(),
    continueCursor: v.string(),
    splitCursor: v.optional(v.union(v.string(), v.null())),
    pageStatus: v.optional(
      v.union(v.literal('SplitRecommended'), v.literal('SplitRequired'), v.null()),
    ),
  }),
  handler: (ctx, { paginationOpts, secret }) => {
    assertSecret(secret)
    return ctx.db.query('sync_events').withIndex('by_at').order('desc').paginate(paginationOpts)
  },
})
