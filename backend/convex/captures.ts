// Codegen-free typed builders (this package must typecheck without a linked
// deployment), mirroring uploads.ts / sync.ts.
import {
  mutationGeneric,
  queryGeneric,
  type DataModelFromSchemaDefinition,
  type MutationBuilder,
  type QueryBuilder,
} from 'convex/server'
import { v } from 'convex/values'
import schema, { captureRow } from './schema'

type DataModel = DataModelFromSchemaDefinition<typeof schema>
const mutation = mutationGeneric as MutationBuilder<DataModel, 'public'>
const query = queryGeneric as QueryBuilder<DataModel, 'public'>

/**
 * Fail-closed shared-secret authorization (ADR-0009 hardening), shared with the
 * sync/upload mutations. The deployment MUST set `SYNC_SHARED_SECRET` and the
 * caller MUST present a matching `secret`.
 */
function assertSecret(secret: string): void {
  const required = process.env.SYNC_SHARED_SECRET
  if (required === undefined || required === '') {
    throw new Error('unauthorized: deployment has no SYNC_SHARED_SECRET configured')
  }
  if (secret !== required) {
    throw new Error('unauthorized: bad or missing sync secret')
  }
}

/**
 * Best-effort mirror of the extension's local TweetRecord store (§9). Idempotent
 * upsert by `captureId` on the `by_capture_id` index, applying the §6.4 merge
 * rule (rank-then-`at`, NOT raw last-write-wins) so a later thin sighting can
 * never overwrite a richer row. Control plane only; fails closed on the secret.
 */
export const recordCaptures = mutation({
  args: { captures: v.array(captureRow), secret: v.string() },
  returns: v.object({ received: v.number(), upserted: v.number() }),
  handler: async (ctx, { captures, secret }) => {
    assertSecret(secret)
    let upserted = 0
    for (const c of captures) {
      const row = await ctx.db
        .query('tweet_captures')
        .withIndex('by_capture_id', (q) => q.eq('captureId', c.captureId))
        .first()
      if (row === null) {
        await ctx.db.insert('tweet_captures', c)
        upserted += 1
      } else if (
        c.sourceRank > row.sourceRank ||
        (c.sourceRank === row.sourceRank && c.at >= row.at)
      ) {
        await ctx.db.patch(row._id, c)
        upserted += 1
      }
    }
    return { received: captures.length, upserted }
  },
})

/** Default page size: a generous full-history pull for a cross-device export. */
const LIST_DEFAULT_LIMIT = 1000

/**
 * Read the Tweet Harvest mirror so the cloud copy is usable cross-device (§9).
 * Newest-first by default (`by_at` desc); scoped to a single thread via the
 * `by_conversation` index when `conversationId` is given. `deviceId` narrows to
 * one device's rows. No `returns` validator: the docs carry Convex system fields
 * (`_id`/`_creationTime`) the captureRow validator doesn't describe. Reads fail
 * closed on the same shared secret as the write (ADR-0009 hardening): the mirror
 * (text, handles, links, device + tweet ids) is not exposed to an unauthenticated
 * caller on the discoverable `*.convex.cloud` URL.
 */
export const list = query({
  args: {
    secret: v.string(),
    deviceId: v.optional(v.string()),
    limit: v.optional(v.number()),
    conversationId: v.optional(v.string()),
  },
  handler: async (ctx, { secret, deviceId, limit, conversationId }) => {
    assertSecret(secret)
    const base =
      conversationId !== undefined
        ? ctx.db
            .query('tweet_captures')
            .withIndex('by_conversation', (q) => q.eq('conversationId', conversationId))
        : ctx.db.query('tweet_captures').withIndex('by_at').order('desc')
    const rows = await base.take(limit ?? LIST_DEFAULT_LIMIT)
    return deviceId !== undefined ? rows.filter((r) => r.deviceId === deviceId) : rows
  },
})
