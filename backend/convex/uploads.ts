// Codegen-free typed builders (this package must typecheck without a linked
// deployment), mirroring sync.ts.
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
import schema from './schema'
import { assertSecret } from './auth'

type DataModel = DataModelFromSchemaDefinition<typeof schema>
type Ctx = GenericMutationCtx<DataModel>
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
  revision: v.optional(v.number()),
  at: v.number(),
  remotePath: v.optional(v.string()),
  bytes: v.optional(v.number()),
  error: v.optional(v.string()),
})
type UploadJob = Infer<typeof job>

const uploadJobDoc = v.object({
  _id: v.id('upload_jobs'),
  _creationTime: v.number(),
  jobId: v.string(),
  deviceId: v.string(),
  requestId: v.string(),
  provider,
  status,
  attempts: v.number(),
  revision: v.optional(v.number()),
  at: v.number(),
  remotePath: v.optional(v.string()),
  bytes: v.optional(v.number()),
  error: v.optional(v.string()),
})

const UPLOAD_JOB_ID_PREFIX = 'xmd:cloud:v2:wire:'
const MAX_UPLOAD_BATCH = 64
const MAX_DEVICE_ID_LENGTH = 64
const MAX_REQUEST_ID_LENGTH = 'xmd:v1:sidecar:instagram:512:'.length + 512
// Shared extension wire contract: filename/path and one diagnostic line.
const MAX_REMOTE_PATH_LENGTH = 1024
const MAX_ERROR_LENGTH = 1024
const MAX_JOB_ID_LENGTH =
  UPLOAD_JOB_ID_PREFIX.length +
  'wire:64:'.length +
  MAX_DEVICE_ID_LENGTH +
  5 +
  MAX_REQUEST_ID_LENGTH +
  8

/** Match the extension's length-delimited v2 key. Old deployed clients used
 * `${deviceId}/${requestId}/${provider}`; accept only that exact compatibility
 * form, never an arbitrary caller-supplied key. */
const jobIdFor = (deviceId: string, requestId: string, providerId: 'gdrive' | 'dropbox'): string =>
  `${UPLOAD_JOB_ID_PREFIX}${deviceId.length}:${deviceId}:${requestId.length}:${requestId}:${providerId}`

const legacyJobIdFor = (
  deviceId: string,
  requestId: string,
  providerId: 'gdrive' | 'dropbox',
): string => `${deviceId}/${requestId}/${providerId}`

const hasDerivedJobId = (input: {
  readonly jobId: string
  readonly deviceId: string
  readonly requestId: string
  readonly provider: 'gdrive' | 'dropbox'
}): boolean =>
  input.jobId === jobIdFor(input.deviceId, input.requestId, input.provider) ||
  (!input.deviceId.includes('/') &&
    !input.requestId.includes('/') &&
    input.jobId === legacyJobIdFor(input.deviceId, input.requestId, input.provider))

const isBoundedText = (value: string, maximum: number, allowEmpty = false): boolean =>
  (allowEmpty || value.length > 0) && value.length <= maximum

const hasValidJobPayload = (input: {
  readonly jobId: string
  readonly deviceId: string
  readonly requestId: string
  readonly attempts: number
  readonly revision?: number
  readonly at: number
  readonly bytes?: number
  readonly remotePath?: string
  readonly error?: string
}): boolean =>
  isBoundedText(input.jobId, MAX_JOB_ID_LENGTH) &&
  isBoundedText(input.deviceId, MAX_DEVICE_ID_LENGTH) &&
  isBoundedText(input.requestId, MAX_REQUEST_ID_LENGTH) &&
  Number.isSafeInteger(input.attempts) &&
  input.attempts >= 0 &&
  input.attempts <= 5 &&
  (input.revision === undefined || (Number.isSafeInteger(input.revision) && input.revision >= 0)) &&
  Number.isSafeInteger(input.at) &&
  input.at >= 0 &&
  (input.bytes === undefined || (Number.isSafeInteger(input.bytes) && input.bytes >= 0)) &&
  (input.remotePath === undefined || isBoundedText(input.remotePath, MAX_REMOTE_PATH_LENGTH)) &&
  (input.error === undefined || isBoundedText(input.error, MAX_ERROR_LENGTH, true))

const isSettled = (value: typeof status.type): boolean =>
  value === 'succeeded' || value === 'failed' || value === 'dead' || value === 'skipped'

const shouldReplace = (
  current: {
    readonly revision?: number
    readonly at: number
    readonly status: typeof status.type
  },
  incoming: {
    readonly revision?: number
    readonly at: number
    readonly status: typeof status.type
  },
): boolean => {
  const currentRevision = current.revision ?? 0
  const incomingRevision = incoming.revision ?? 0
  if (incomingRevision !== currentRevision) return incomingRevision > currentRevision
  // Revision zero is the compatibility epoch. Old installed clients and old
  // rows retain their prior wall-time ordering until a new lease revision wins.
  if (incomingRevision === 0) return incoming.at >= current.at
  if (isSettled(current.status)) return false
  return isSettled(incoming.status)
}

const toWireJob = (row: Infer<typeof uploadJobDoc>): UploadJob => ({
  jobId: row.jobId,
  deviceId: row.deviceId,
  requestId: row.requestId,
  provider: row.provider,
  status: row.status,
  attempts: row.attempts,
  ...(row.revision === undefined ? {} : { revision: row.revision }),
  at: row.at,
  ...(row.remotePath === undefined ? {} : { remotePath: row.remotePath }),
  ...(row.bytes === undefined ? {} : { bytes: row.bytes }),
  ...(row.error === undefined ? {} : { error: row.error }),
})

const isSameLogicalJob = (left: UploadJob, right: UploadJob): boolean =>
  left.deviceId === right.deviceId &&
  left.requestId === right.requestId &&
  left.provider === right.provider

const sameJob = (left: UploadJob, right: UploadJob): boolean =>
  left.jobId === right.jobId &&
  left.deviceId === right.deviceId &&
  left.requestId === right.requestId &&
  left.provider === right.provider &&
  left.status === right.status &&
  left.attempts === right.attempts &&
  left.revision === right.revision &&
  left.at === right.at &&
  left.remotePath === right.remotePath &&
  left.bytes === right.bytes &&
  left.error === right.error

/**
 * Old clients retried slash-delimited ids while new clients use length-delimited
 * ids. Fold both aliases before applying the incoming state: one canonical row,
 * one monotonic outcome, no duplicate control-plane effect.
 */
async function reconcileJobAliases(
  ctx: Ctx,
  incoming: UploadJob,
): Promise<{ readonly changed: boolean; readonly found: boolean }> {
  const canonicalId = jobIdFor(incoming.deviceId, incoming.requestId, incoming.provider)
  const canonicalRows = await ctx.db
    .query('upload_jobs')
    .withIndex('by_job', (q) => q.eq('jobId', canonicalId))
    .collect()
  const legacyRows =
    incoming.deviceId.includes('/') || incoming.requestId.includes('/')
      ? []
      : await ctx.db
          .query('upload_jobs')
          .withIndex('by_job', (q) =>
            q.eq('jobId', legacyJobIdFor(incoming.deviceId, incoming.requestId, incoming.provider)),
          )
          .collect()
  const rows = [...canonicalRows, ...legacyRows]
  if (
    rows.some((row) => {
      const stored = toWireJob(row)
      return (
        !isSameLogicalJob(stored, incoming) ||
        !hasValidJobPayload(stored) ||
        !hasDerivedJobId(stored)
      )
    })
  ) {
    throw new Error('Conflicting stored upload job identity.')
  }
  if (rows.length === 0) return { changed: false, found: false }

  // oxlint-disable no-underscore-dangle -- stable Convex system-field tie-break
  rows.sort(
    (left, right) =>
      left._creationTime - right._creationTime || String(left._id).localeCompare(String(right._id)),
  )
  const [survivor, ...duplicates] = rows
  let winner = toWireJob(survivor!)
  for (const row of duplicates) {
    const candidate = toWireJob(row)
    if (shouldReplace(winner, candidate)) winner = candidate
  }
  const canonicalIncoming = { ...incoming, jobId: canonicalId }
  if (shouldReplace(winner, canonicalIncoming)) winner = canonicalIncoming
  const next = { ...winner, jobId: canonicalId }
  await Promise.all(duplicates.map((duplicate) => ctx.db.delete(duplicate._id)))
  if (!sameJob(toWireJob(survivor!), next)) await ctx.db.replace(survivor!._id, next)
  // oxlint-enable no-underscore-dangle
  return {
    found: true,
    changed: duplicates.length > 0 || !sameJob(toWireJob(survivor!), next),
  }
}

/**
 * Best-effort mirror of the extension's local UploadJob ledger (ADR-0013).
 * Idempotent + monotonic lease revision on the `by_job` index: wall time is
 * harmless. Control plane only — NO bytes ever reach Convex; the byte path is
 * extension → provider. Fails closed on the shared secret, like recordEvents.
 */
export const recordUploadJobs = mutation({
  args: { jobs: v.array(job), secret: v.string() },
  returns: v.object({ received: v.number(), upserted: v.number() }),
  handler: async (ctx, { jobs, secret }) => {
    assertSecret(secret)
    if (jobs.length > MAX_UPLOAD_BATCH) throw new Error('upload batch too large')
    for (const j of jobs) {
      if (!hasValidJobPayload(j) || !hasDerivedJobId(j))
        throw new Error('invalid upload job identity or payload')
    }
    let upserted = 0
    // oxlint-disable no-await-in-loop -- duplicate aliases in one batch must merge in input order
    for (const j of jobs) {
      const canonical = { ...j, jobId: jobIdFor(j.deviceId, j.requestId, j.provider) }
      const reconciliation = await reconcileJobAliases(ctx, canonical)
      if (!reconciliation.found) {
        await ctx.db.insert('upload_jobs', canonical)
        upserted += 1
      } else if (reconciliation.changed) upserted += 1
    }
    // oxlint-enable no-await-in-loop
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
