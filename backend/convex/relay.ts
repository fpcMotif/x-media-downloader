import { v } from 'convex/values'
import { makeFunctionReference } from 'convex/server'
import {
  mutation,
  query,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from './_generated/server'
import type { Doc, Id } from './_generated/dataModel'
import { assertSecret } from './auth'
import {
  LEASE_MS,
  limits,
  publicJob,
  relayDoc,
  relayInput,
  relayProgress,
  setupReason,
} from './relayModel'
import {
  META_MEDIA_HOSTS,
  X_MEDIA_HOSTS,
  validateSourceUrl,
} from '../../src/packages/kernel/source-policy'

const worker = makeFunctionReference<'action', { id: Id<'relay_jobs'> }, null>('relayWorker:run')
const wakeRef = makeFunctionReference<'mutation', { id: Id<'relay_jobs'> }, null>('relay:wake')
const hosts = [...X_MEDIA_HOSTS, ...META_MEDIA_HOSTS]

function visible(job: Doc<'relay_jobs'>) {
  return {
    mediaId: job.mediaId,
    deviceId: job.deviceId,
    execution: job.execution,
    provider: job.provider,
    status: job.status,
    path: job.path,
    at: job.at,
    acceptedAt: job.acceptedAt,
    offset: job.offset,
    failures: job.failures,
    sourceBytes: job.sourceBytes,
    uploadedBytes: job.uploadedBytes,
    peakRss: job.peakRss,
    ...(job.total === undefined ? {} : { total: job.total }),
    ...(job.fileId === undefined ? {} : { fileId: job.fileId }),
    ...(job.error === undefined ? {} : { error: job.error }),
  }
}
async function controls(ctx: MutationCtx) {
  const existing = await ctx.db
    .query('relay_control')
    .withIndex('by_key', (q) => q.eq('key', 'drive'))
    .unique()
  if (existing) return existing
  const id = await ctx.db.insert('relay_control', {
    key: 'drive',
    enabled: false,
    accepting: false,
    connected: false,
    epoch: 0,
    fence: 0,
    leaseUntil: 0,
  })
  const created = await ctx.db.get(id)
  if (!created) throw new Error('Relay control persistence failed')
  return created
}

export const setup = query({
  args: { secret: v.string() },
  returns: v.object({
    available: v.boolean(),
    reason: v.union(v.string(), v.null()),
    chunkBytes: v.number(),
  }),
  handler: (_ctx, { secret }) => {
    assertSecret(secret)
    const reason = setupReason()
    return { available: reason === null, reason, chunkBytes: 8 * 1024 * 1024 }
  },
})

export const control = mutation({
  args: {
    secret: v.string(),
    enabled: v.boolean(),
    accepting: v.boolean(),
    connected: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertSecret(args.secret)
    const current = await controls(ctx)
    await ctx.db.patch(current._id, {
      enabled: args.enabled,
      accepting: args.accepting,
      connected: args.connected,
      epoch: current.epoch + (current.connected && !args.connected ? 1 : 0),
    })
    const queued = await ctx.db
      .query('relay_jobs')
      .withIndex('by_status_next', (q) => q.eq('status', 'queued'))
      .take(100)
    await Promise.all(queued.map((job) => ctx.scheduler.runAfter(0, worker, { id: job._id })))
    return null
  },
})

export const submit = mutation({
  args: { secret: v.string(), ...relayInput },
  returns: v.object({ id: v.id('relay_jobs'), created: v.boolean() }),
  handler: async (ctx, { secret, ...input }) => {
    assertSecret(secret)
    if (
      !input.deviceId ||
      input.deviceId.length > 200 ||
      !input.mediaId ||
      input.mediaId.length > 500 ||
      input.sourceUrl.length > 8192 ||
      input.path.length > 1000 ||
      input.contentType.length > 100
    )
      throw new Error('Invalid relay metadata')
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(input.budgetDay) ||
      !Number.isSafeInteger(input.estimatedBytes) ||
      input.estimatedBytes <= 0
    )
      throw new Error('Invalid acceptance budget metadata')
    validateSourceUrl(input.sourceUrl, hosts)
    if (
      input.path.split('/').length > 8 ||
      input.path
        .split('/')
        .some((part) => !part || part === '.' || part === '..' || /[\\\x00-\x1f]/.test(part))
    )
      throw new Error('Invalid planned path')
    if (!/^(image|video)\/[a-z0-9.+-]+$/.test(input.contentType))
      throw new Error('Unsupported media content type')
    const existing = await ctx.db
      .query('relay_jobs')
      .withIndex('by_device_media', (q) =>
        q.eq('deviceId', input.deviceId).eq('mediaId', input.mediaId),
      )
      .unique()
    if (existing) {
      if (
        existing.sourceUrl !== input.sourceUrl ||
        existing.path !== input.path ||
        existing.contentType !== input.contentType
      )
        throw new Error('Relay idempotency conflict')
      return { id: existing._id, created: false }
    }
    const reason = setupReason()
    if (reason) throw new Error(reason)
    const c = await controls(ctx)
    if (!c.enabled || !c.accepting || !c.connected)
      throw new Error('Relay destination is disabled, paused, or disconnected')
    const now = Date.now()
    const configuredLimits = limits()
    if (input.estimatedBytes > configuredLimits.maxBytes)
      throw new Error('Source exceeds deployment byte limit')
    const id = await ctx.db.insert('relay_jobs', {
      ...input,
      ...configuredLimits,
      maxBytes: input.estimatedBytes,
      execution: 'convex',
      provider: 'gdrive',
      status: 'queued',
      at: now,
      acceptedAt: now,
      epoch: c.epoch,
      fence: 0,
      leaseUntil: 0,
      failures: 0,
      nextAt: now,
      offset: 0,
      sourceBytes: 0,
      uploadedBytes: 0,
      peakRss: 0,
      folderId: process.env.RELAY_DRIVE_FOLDER_ID!,
    })
    const usage = await ctx.db
      .query('relay_usage')
      .withIndex('by_device_day', (q) =>
        q.eq('deviceId', input.deviceId).eq('day', input.budgetDay),
      )
      .unique()
    if (usage)
      await ctx.db.patch(usage._id, {
        bytes: usage.bytes + input.estimatedBytes,
        count: usage.count + 1,
      })
    else
      await ctx.db.insert('relay_usage', {
        deviceId: input.deviceId,
        day: input.budgetDay,
        bytes: input.estimatedBytes,
        count: 1,
      })
    await ctx.scheduler.runAfter(0, worker, { id })
    return { id, created: true }
  },
})

export const budget = query({
  args: { secret: v.string(), deviceId: v.string(), day: v.string() },
  returns: v.object({ bytes: v.number(), count: v.number() }),
  handler: async (ctx, { secret, deviceId, day }) => {
    assertSecret(secret)
    const usage = await ctx.db
      .query('relay_usage')
      .withIndex('by_device_day', (q) => q.eq('deviceId', deviceId).eq('day', day))
      .unique()
    return { bytes: usage?.bytes ?? 0, count: usage?.count ?? 0 }
  },
})

export const status = query({
  args: { secret: v.string(), deviceId: v.string(), mediaIds: v.array(v.string()) },
  returns: v.array(publicJob),
  handler: async (ctx, { secret, deviceId, mediaIds }) => {
    assertSecret(secret)
    if (mediaIds.length > 100) throw new Error('At most 100 status requests')
    const rows = await Promise.all(
      mediaIds.map((mediaId) =>
        ctx.db
          .query('relay_jobs')
          .withIndex('by_device_media', (q) => q.eq('deviceId', deviceId).eq('mediaId', mediaId))
          .unique(),
      ),
    )
    return rows.flatMap((row) => (row ? [visible(row)] : []))
  },
})

export const retry = mutation({
  args: { secret: v.string(), deviceId: v.string(), mediaId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { secret, deviceId, mediaId }) => {
    assertSecret(secret)
    const job = await ctx.db
      .query('relay_jobs')
      .withIndex('by_device_media', (q) => q.eq('deviceId', deviceId).eq('mediaId', mediaId))
      .unique()
    const c = await controls(ctx)
    if (!job || job.status !== 'failed' || !c.connected || !c.enabled || job.epoch !== c.epoch)
      return false
    if (Date.now() - job.acceptedAt >= job.maxElapsedMs || job.failures >= job.maxRetries)
      return false
    await ctx.db.patch(job._id, { status: 'queued', error: undefined, nextAt: Date.now() })
    await ctx.scheduler.runAfter(0, worker, { id: job._id })
    return true
  },
})

export const claim = internalMutation({
  args: { id: v.id('relay_jobs') },
  returns: v.union(relayDoc, v.null()),
  handler: async (ctx, { id }) => {
    const job = await ctx.db.get(id)
    if (!job || job.status === 'completed' || job.status === 'failed') return null
    const c = await controls(ctx)
    const now = Date.now()
    if (!c.connected || c.epoch !== job.epoch || now - job.acceptedAt >= job.maxElapsedMs) {
      await ctx.db.patch(id, {
        status: 'failed',
        error:
          !c.connected || c.epoch !== job.epoch
            ? 'Backend Drive authorization revoked'
            : 'Elapsed-time limit reached',
        at: now,
      })
      return null
    }
    if (!c.enabled || process.env.RELAY_ENABLED !== 'true') {
      await ctx.scheduler.runAfter(60_000, wakeRef, { id })
      return null
    }
    const due = Math.max(c.leaseUntil, job.nextAt)
    if (due > now) {
      await ctx.scheduler.runAfter(due - now, wakeRef, { id })
      return null
    }
    const fence = c.fence + 1
    await ctx.db.patch(c._id, { active: id, fence, leaseUntil: now + LEASE_MS })
    await ctx.db.patch(id, { fence, leaseUntil: now + LEASE_MS, status: 'uploading', at: now })
    await ctx.scheduler.runAfter(LEASE_MS, wakeRef, { id })
    return await ctx.db.get(id)
  },
})

export const wake = internalMutation({
  args: { id: v.id('relay_jobs') },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    const job = await ctx.db.get(id)
    if (job && job.status !== 'completed' && job.status !== 'failed')
      await ctx.scheduler.runAfter(0, worker, { id })
    return null
  },
})

export const admissionAllowed = internalQuery({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    const c = await ctx.db
      .query('relay_control')
      .withIndex('by_key', (q) => q.eq('key', 'drive'))
      .unique()
    return !!(c?.enabled && c.connected && c.accepting && setupReason() === null)
  },
})

export const authorized = internalQuery({
  args: { id: v.id('relay_jobs'), fence: v.number() },
  returns: v.boolean(),
  handler: async (ctx, { id, fence }) => {
    const job = await ctx.db.get(id)
    const c = await ctx.db
      .query('relay_control')
      .withIndex('by_key', (q) => q.eq('key', 'drive'))
      .unique()
    return !!(
      job &&
      c &&
      c.enabled &&
      process.env.RELAY_ENABLED === 'true' &&
      c.connected &&
      c.epoch === job.epoch &&
      c.active === id &&
      c.fence === fence &&
      c.leaseUntil > Date.now() &&
      job.status === 'uploading'
    )
  },
})

export const checkpoint = internalMutation({
  args: {
    id: v.id('relay_jobs'),
    fence: v.number(),
    progress: v.object(relayProgress),
    release: v.boolean(),
    completed: v.boolean(),
    error: v.optional(v.string()),
    permanent: v.optional(v.boolean()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.id)
    const c = await controls(ctx)
    const now = Date.now()
    if (
      !job ||
      !c.connected ||
      c.epoch !== job.epoch ||
      c.active !== args.id ||
      c.fence !== args.fence ||
      c.leaseUntil <= now ||
      job.status !== 'uploading'
    )
      return false
    const failures = job.failures + (args.error ? 1 : 0)
    const failed = args.error && (args.permanent || failures >= job.maxRetries)
    let status: Doc<'relay_jobs'>['status'] = 'uploading'
    if (args.completed) status = 'completed'
    else if (failed) status = 'failed'
    else if (args.release) status = 'queued'
    const nextAt = now + (args.error ? 2 ** failures * 1000 : 0)
    await ctx.db.patch(job._id, {
      ...args.progress,
      status,
      failures,
      nextAt,
      at: now,
      error: args.error,
    })
    if (args.release || args.completed || failed) {
      await ctx.db.patch(c._id, { active: undefined, leaseUntil: 0 })
      if (status === 'queued')
        await ctx.scheduler.runAfter(Math.max(0, nextAt - now), worker, { id: job._id })
      const next = await ctx.db
        .query('relay_jobs')
        .withIndex('by_status_next', (q) => q.eq('status', 'queued'))
        .first()
      if (next && next._id !== job._id)
        await ctx.scheduler.runAfter(Math.max(0, next.nextAt - now), worker, { id: next._id })
    }
    return true
  },
})
