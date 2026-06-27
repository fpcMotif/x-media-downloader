// Codegen-free typed builders (this package must typecheck without a linked
// deployment), mirroring uploads.ts / sync.ts.
import {
  mutationGeneric,
  type DataModelFromSchemaDefinition,
  type MutationBuilder,
} from 'convex/server'
import { v } from 'convex/values'
import schema, { captureRow } from './schema'

type DataModel = DataModelFromSchemaDefinition<typeof schema>
const mutation = mutationGeneric as MutationBuilder<DataModel, 'public'>

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
