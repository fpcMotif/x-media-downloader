import { convexTest } from 'convex-test'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import schema from './schema'
import { api } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')

const SECRET = 'test-shared-secret'

const capture = (over: Record<string, unknown> = {}) => ({
  captureId: 'dev-1/t-1',
  deviceId: 'dev-1',
  tweetId: 't-1',
  conversationId: 't-1',
  handle: 'alice',
  text: 'a thin sighting',
  sourceRank: 1,
  at: 1_000,
  ...over,
})

beforeEach(() => {
  vi.stubEnv('SYNC_SHARED_SECRET', SECRET)
})

describe('captures:recordCaptures', () => {
  it('fails closed on a bad caller secret', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(api.captures.recordCaptures, { captures: [capture()], secret: 'WRONG' }),
    ).rejects.toThrow(/bad or missing sync secret/)
  })

  it('upserts a new row keyed by captureId (`${deviceId}/${tweetId}`)', async () => {
    const t = convexTest(schema, modules)
    const res = await t.mutation(api.captures.recordCaptures, {
      captures: [capture()],
      secret: SECRET,
    })
    expect(res).toEqual({ received: 1, upserted: 1 })

    const rows = await t.run((ctx) => ctx.db.query('tweet_captures').collect())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ captureId: 'dev-1/t-1', tweetId: 't-1', sourceRank: 1 })
  })

  it('§6.4: a later thin sighting (rank 1) does NOT overwrite a rich row (rank 2)', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(api.captures.recordCaptures, {
      captures: [
        capture({
          sourceRank: 2,
          text: 'rich detail with the full thread',
          links: [{ expandedUrl: 'https://example.com', title: 'Example', domain: 'example.com' }],
          at: 2_000,
        }),
      ],
      secret: SECRET,
    })
    // Thin sighting arrives LATER (larger `at`) but at a LOWER rank: must lose.
    const res = await t.mutation(api.captures.recordCaptures, {
      captures: [capture({ sourceRank: 1, text: 'thin', at: 3_000 })],
      secret: SECRET,
    })
    expect(res).toEqual({ received: 1, upserted: 0 })

    const rows = await t.run((ctx) => ctx.db.query('tweet_captures').collect())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ sourceRank: 2, text: 'rich detail with the full thread' })
  })

  it('§6.4: thin-then-rich upgrades the row', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(api.captures.recordCaptures, {
      captures: [capture({ sourceRank: 1, text: 'thin', at: 1_000 })],
      secret: SECRET,
    })
    const res = await t.mutation(api.captures.recordCaptures, {
      captures: [capture({ sourceRank: 2, text: 'rich detail', at: 1_000 })],
      secret: SECRET,
    })
    expect(res).toEqual({ received: 1, upserted: 1 })

    const rows = await t.run((ctx) => ctx.db.query('tweet_captures').collect())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ sourceRank: 2, text: 'rich detail' })
  })
})
