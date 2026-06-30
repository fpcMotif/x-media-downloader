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
    expect(rows[0]).toMatchObject({ jobId: 'dev-1/req-1/gdrive', status: 'pending', attempts: 0 })
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
        job({ jobId: 'j1', at: 1_000 }),
        job({ jobId: 'j2', at: 3_000 }),
        job({ jobId: 'j3', at: 2_000 }),
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
