import { convexTest } from 'convex-test'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import schema from './schema'
import { api } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')

const SECRET = 'test-shared-secret'

const job = (over: Record<string, unknown> = {}) => ({
  jobId: 'dev-1/req-1/gdrive',
  deviceId: 'dev-1',
  requestId: 'req-1',
  provider: 'gdrive' as const,
  status: 'pending' as const,
  attempts: 0,
  revision: 0,
  at: 1_000,
  ...over,
})

beforeEach(() => {
  vi.stubEnv('SYNC_SHARED_SECRET', SECRET)
})

describe('uploads:recordUploadJobs', () => {
  it('inserts a new job (control-plane mirror; never carries bytes)', async () => {
    const t = convexTest(schema, modules)
    const res = await t.mutation(api.uploads.recordUploadJobs, { jobs: [job()], secret: SECRET })
    expect(res).toEqual({ received: 1, upserted: 1 })

    const rows = await t.run((ctx) => ctx.db.query('upload_jobs').collect())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      jobId: 'xmd:cloud:v2:wire:5:dev-1:5:req-1:gdrive',
      status: 'pending',
      attempts: 0,
    })
  })

  it('last-write-wins by `at`: a newer state patches the same jobId in place', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(api.uploads.recordUploadJobs, {
      jobs: [job({ status: 'uploading', at: 1_000 })],
      secret: SECRET,
    })
    const res = await t.mutation(api.uploads.recordUploadJobs, {
      jobs: [job({ status: 'succeeded', at: 2_000, bytes: 4096, remotePath: 'alice/x.jpg' })],
      secret: SECRET,
    })
    expect(res).toEqual({ received: 1, upserted: 1 })

    const rows = await t.run((ctx) => ctx.db.query('upload_jobs').collect())
    expect(rows).toHaveLength(1) // patched, not duplicated
    expect(rows[0]).toMatchObject({ status: 'succeeded', at: 2_000, bytes: 4096 })
  })

  it('ignores an out-of-order (older `at`) update', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(api.uploads.recordUploadJobs, {
      jobs: [job({ status: 'succeeded', at: 5_000 })],
      secret: SECRET,
    })
    const res = await t.mutation(api.uploads.recordUploadJobs, {
      jobs: [job({ status: 'pending', at: 1_000 })],
      secret: SECRET,
    })
    expect(res).toEqual({ received: 1, upserted: 0 }) // stale → no write

    const rows = await t.run((ctx) => ctx.db.query('upload_jobs').collect())
    expect(rows[0]).toMatchObject({ status: 'succeeded', at: 5_000 })
  })

  it('keeps a newer success when the wall clock rolls back', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(api.uploads.recordUploadJobs, {
      jobs: [job({ status: 'uploading', revision: 7, at: 9_000 })],
      secret: SECRET,
    })
    await t.mutation(api.uploads.recordUploadJobs, {
      jobs: [job({ status: 'succeeded', revision: 7, at: 1_000, bytes: 64 })],
      secret: SECRET,
    })
    const stale = await t.mutation(api.uploads.recordUploadJobs, {
      jobs: [job({ status: 'uploading', revision: 7, at: 10_000 })],
      secret: SECRET,
    })
    expect(stale).toEqual({ received: 1, upserted: 0 })
    const rows = await t.run((ctx) => ctx.db.query('upload_jobs').collect())
    expect(rows[0]).toMatchObject({ status: 'succeeded', revision: 7, at: 1_000 })
  })

  it('migrates an existing revisionless row without rejecting the schema', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('upload_jobs', {
        jobId: 'dev-1/req-1/gdrive',
        deviceId: 'dev-1',
        requestId: 'req-1',
        provider: 'gdrive',
        status: 'failed',
        attempts: 1,
        at: 9_000,
      })
    })

    const result = await t.mutation(api.uploads.recordUploadJobs, {
      jobs: [job({ status: 'succeeded', revision: 1, at: 1_000, bytes: 64 })],
      secret: SECRET,
    })

    expect(result).toEqual({ received: 1, upserted: 1 })
    const rows = await t.run((ctx) => ctx.db.query('upload_jobs').collect())
    expect(rows[0]).toMatchObject({ status: 'succeeded', revision: 1, at: 1_000 })
  })

  it('keeps old clients compatible without letting them overwrite a revisioned row', async () => {
    const t = convexTest(schema, modules)
    const { revision: _revision, ...legacy } = job({ status: 'failed', at: 1_000 })
    await t.mutation(api.uploads.recordUploadJobs, { jobs: [legacy], secret: SECRET })
    await t.mutation(api.uploads.recordUploadJobs, {
      jobs: [job({ status: 'succeeded', revision: 2, at: 500, bytes: 64 })],
      secret: SECRET,
    })
    const stale = await t.mutation(api.uploads.recordUploadJobs, {
      jobs: [{ ...legacy, status: 'failed', at: 99_000 }],
      secret: SECRET,
    })

    expect(stale).toEqual({ received: 1, upserted: 0 })
    const rows = await t.run((ctx) => ctx.db.query('upload_jobs').collect())
    expect(rows[0]).toMatchObject({ status: 'succeeded', revision: 2, at: 500 })
  })

  it('reconciles legacy and canonical retries to one canonical monotonic row', async () => {
    const t = convexTest(schema, modules)
    const canonicalId = 'xmd:cloud:v2:wire:5:dev-1:5:req-1:gdrive'
    await t.run(async (ctx) => {
      await ctx.db.insert('upload_jobs', job({ status: 'pending', at: 100 }))
      await ctx.db.insert(
        'upload_jobs',
        job({ jobId: canonicalId, status: 'succeeded', revision: 1, at: 200, bytes: 64 }),
      )
    })

    expect(
      await t.mutation(api.uploads.recordUploadJobs, {
        jobs: [job({ status: 'pending', at: 50 })],
        secret: SECRET,
      }),
    ).toEqual({ received: 1, upserted: 1 })

    const rows = await t.run((ctx) => ctx.db.query('upload_jobs').collect())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      jobId: canonicalId,
      status: 'succeeded',
      revision: 1,
      at: 200,
      bytes: 64,
    })
  })

  it('makes an alias retry a no-op once the canonical row exists', async () => {
    const t = convexTest(schema, modules)
    const canonicalId = 'xmd:cloud:v2:wire:5:dev-1:5:req-1:gdrive'
    await t.mutation(api.uploads.recordUploadJobs, {
      jobs: [job({ jobId: canonicalId })],
      secret: SECRET,
    })

    expect(
      await t.mutation(api.uploads.recordUploadJobs, { jobs: [job()], secret: SECRET }),
    ).toEqual({ received: 1, upserted: 0 })
    const rows = await t.run((ctx) => ctx.db.query('upload_jobs').collect())
    expect(rows).toHaveLength(1)
    expect(rows[0]?.jobId).toBe(canonicalId)
  })

  it('separates jobs per provider for the same media item', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(api.uploads.recordUploadJobs, {
      jobs: [
        job({ jobId: 'dev-1/req-1/gdrive', provider: 'gdrive' }),
        job({ jobId: 'dev-1/req-1/dropbox', provider: 'dropbox' }),
      ],
      secret: SECRET,
    })
    const rows = await t.run((ctx) => ctx.db.query('upload_jobs').collect())
    expect(rows).toHaveLength(2)
  })

  it('rejects a forged job ID', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(api.uploads.recordUploadJobs, {
        jobs: [job({ jobId: 'forged' })],
        secret: SECRET,
      }),
    ).rejects.toThrow('invalid upload job identity')
  })

  it('accepts the injective v2 job ID when fields contain delimiters', async () => {
    const t = convexTest(schema, modules)
    const deviceId = 'device/a'
    const requestId = 'request/b'
    const provider = 'gdrive' as const
    const jobId = `xmd:cloud:v2:wire:${deviceId.length}:${deviceId}:${requestId.length}:${requestId}:${provider}`
    const result = await t.mutation(api.uploads.recordUploadJobs, {
      jobs: [job({ jobId, deviceId, requestId, provider })],
      secret: SECRET,
    })
    expect(result).toEqual({ received: 1, upserted: 1 })
  })

  it('rejects an ambiguous slash-delimited legacy ID and invalid numeric payloads', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(api.uploads.recordUploadJobs, {
        jobs: [
          job({ deviceId: 'device/a', requestId: 'request', jobId: 'device/a/request/gdrive' }),
        ],
        secret: SECRET,
      }),
    ).rejects.toThrow('invalid upload job identity or payload')
    await expect(
      t.mutation(api.uploads.recordUploadJobs, {
        jobs: [job({ attempts: 0.5 })],
        secret: SECRET,
      }),
    ).rejects.toThrow('invalid upload job identity or payload')
  })

  it.each([
    ['remotePath', { remotePath: 'p'.repeat(1_025) }],
    ['error', { error: 'e'.repeat(1_025) }],
  ])('rejects an oversized %s diagnostic field', async (_field, patch) => {
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(api.uploads.recordUploadJobs, { jobs: [job(patch)], secret: SECRET }),
    ).rejects.toThrow('invalid upload job identity or payload')
  })

  it('fails closed without a configured secret, and rejects a bad caller secret', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(api.uploads.recordUploadJobs, { jobs: [job()], secret: 'WRONG' }),
    ).rejects.toThrow(/bad or missing sync secret/)

    vi.stubEnv('SYNC_SHARED_SECRET', '')
    const t2 = convexTest(schema, modules)
    await expect(
      t2.mutation(api.uploads.recordUploadJobs, { jobs: [job()], secret: 'x' }),
    ).rejects.toThrow(/no SYNC_SHARED_SECRET configured/)
  })
})

describe('uploads:recordUploadJobs fails closed', () => {
  it('rejects a bad secret', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(api.uploads.recordUploadJobs, { jobs: [], secret: 'wrong' }),
    ).rejects.toThrow('bad or missing sync secret')
  })

  it('rejects when no secret is configured', async () => {
    vi.stubEnv('SYNC_SHARED_SECRET', '')
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(api.uploads.recordUploadJobs, { jobs: [], secret: 'anything' }),
    ).rejects.toThrow('no SYNC_SHARED_SECRET configured')
  })
})

describe('uploads:recentUploadJobs', () => {
  it('returns jobs newest-first, cursor-paginated', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(api.uploads.recordUploadJobs, {
      jobs: [
        job({ jobId: 'dev-1/r1/gdrive', requestId: 'r1', at: 1_000 }),
        job({ jobId: 'dev-1/r2/gdrive', requestId: 'r2', at: 3_000 }),
        job({ jobId: 'dev-1/r3/gdrive', requestId: 'r3', at: 2_000 }),
      ],
      secret: SECRET,
    })
    const page = await t.query(api.uploads.recentUploadJobs, {
      paginationOpts: { numItems: 10, cursor: null },
      secret: SECRET,
    })
    expect(page.page.map((j) => j.at)).toEqual([3_000, 2_000, 1_000])
    expect(page.isDone).toBe(true)
  })

  it('rejects an unauthenticated read (bad/missing secret)', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.query(api.uploads.recentUploadJobs, {
        paginationOpts: { numItems: 10, cursor: null },
        secret: 'x',
      }),
    ).rejects.toThrow(/bad or missing sync secret/)
  })
})
