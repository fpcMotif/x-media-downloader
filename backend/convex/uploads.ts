// Codegen-free typed builders (this package must typecheck without a linked
// deployment), mirroring sync.ts.
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
import { assertSecret } from './auth'

type DataModel = DataModelFromSchemaDefinition<typeof schema>
const mutation = mutationGeneric as MutationBuilder<DataModel, 'public'>
const query = queryGeneric as QueryBuilder<DataModel, 'public'>

const provider = v.union(v.literal('gdrive'), v.literal('dropbox'))
const status = v.union(
  v.literal('pending'),
  v.literal('uploading'),
  v.literal('succeeded'),
  v.literal('failed'),
  v.literal('dead'),
  v.literal('skipped'),
)

const job = v.object({
  jobId: v.string(),
  deviceId: v.string(),
  requestId: v.string(),
  provider,
  status,
  attempts: v.number(),
  at: v.number(),
  remotePath: v.optional(v.string()),
  bytes: v.optional(v.number()),
  error: v.optional(v.string()),
})

const uploadJobDoc = v.object({
  _id: v.id('upload_jobs'),
  _creationTime: v.number(),
  jobId: v.string(),
  deviceId: v.string(),
  requestId: v.string(),
  provider,
  status,
  attempts: v.number(),
  at: v.number(),
  remotePath: v.optional(v.string()),
  bytes: v.optional(v.number()),
  error: v.optional(v.string()),
})

/**
 * Best-effort mirror of the extension's local UploadJob ledger (ADR-0013).
 * Idempotent + last-write-wins by `at` on the `by_job` index: re-sent state is
 * harmless. Control plane only — NO bytes ever reach Convex; the byte path is
 * extension → provider. Fails closed on the shared secret, like recordEvents.
 */
export const recordUploadJobs = mutation({
  args: { jobs: v.array(job), secret: v.string() },
  returns: v.object({ received: v.number(), upserted: v.number() }),
  handler: async (ctx, { jobs, secret }) => {
    assertSecret(secret)

    const deduped = new Map<string, typeof jobs[0]>()
    for (const j of jobs) {
      const existing = deduped.get(j.jobId)
      if (!existing || j.at >= existing.at) {
        deduped.set(j.jobId, j)
      }
    }

    const results = await Promise.all(
      Array.from(deduped.values()).map(async (j) => {
        const row = await ctx.db
          .query('upload_jobs')
          .withIndex('by_job', (q) => q.eq('jobId', j.jobId))
          .first()
        if (row === null) {
          await ctx.db.insert('upload_jobs', j)
          return 1
        } else if (j.at >= row.at) {
          await ctx.db.patch(row._id, j)
          return 1
        }
        return 0
      })
    )

    const upserted = results.reduce<number>((acc, curr) => acc + curr, 0)

    return { received: jobs.length, upserted }
  },
})

/**
 * Newest-first upload-job ledger, cursor-paginated. Reads fail closed on the
 * shared secret (ADR-0009 hardening), like the write mutation: the control-plane
 * ledger (provider, status, remotePath, bytes, device ids) is not exposed to an
 * unauthenticated caller on the discoverable `*.convex.cloud` URL.
 */
export const recentUploadJobs = query({
  args: { paginationOpts: paginationOptsValidator, secret: v.string() },
  returns: v.object({
    page: v.array(uploadJobDoc),
    isDone: v.boolean(),
    continueCursor: v.string(),
    splitCursor: v.optional(v.union(v.string(), v.null())),
    pageStatus: v.optional(
      v.union(v.literal('SplitRecommended'), v.literal('SplitRequired'), v.null()),
    ),
  }),
  handler: (ctx, { paginationOpts, secret }) => {
    assertSecret(secret)
    return ctx.db.query('upload_jobs').withIndex('by_at').order('desc').paginate(paginationOpts)
  },
})
