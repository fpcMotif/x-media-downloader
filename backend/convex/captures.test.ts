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

  // Tests for deduplication and parallel semantics of `recordCaptures`.
  // With PR #31/#34, same-batch duplicate captureId items are deduplicated
  // in-memory to prevent redundant reads and concurrent write issues. The §6.4
  // merge rule is applied in memory before calling Convex DB.
  describe('same-batch duplicate captureId (parallel and dedup semantics)', () => {
    it('processes deduplication correctly: first insert, second wins in memory (1 upsert)', async () => {
      const t = convexTest(schema, modules)
      const res = await t.mutation(api.captures.recordCaptures, {
        captures: [
          capture({ sourceRank: 1, text: 'thin', at: 1_000 }),
          capture({ sourceRank: 2, text: 'rich detail', at: 2_000 }),
        ],
        secret: SECRET,
      })
      // Only 1 upsert because it's deduplicated in memory. The 2nd one wins the deduplication.
      expect(res).toEqual({ received: 2, upserted: 1 })

      const rows = await t.run((ctx) => ctx.db.query('tweet_captures').collect())
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ sourceRank: 2, text: 'rich detail' })
    })

    it('reversed array order: first wins in memory, second (thinner) loses in memory (1 upsert)', async () => {
      const t = convexTest(schema, modules)
      const res = await t.mutation(api.captures.recordCaptures, {
        captures: [
          capture({ sourceRank: 2, text: 'rich detail', at: 2_000 }),
          capture({ sourceRank: 1, text: 'thin', at: 1_000 }),
        ],
        secret: SECRET,
      })
      // Only 1 upsert. The 1st one wins the deduplication.
      expect(res).toEqual({ received: 2, upserted: 1 })

      const rows = await t.run((ctx) => ctx.db.query('tweet_captures').collect())
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ sourceRank: 2, text: 'rich detail' })
    })

    it('equal rank and `at` (a tie): the later array item always wins (1 upsert)', async () => {
      const t = convexTest(schema, modules)
      const res = await t.mutation(api.captures.recordCaptures, {
        captures: [
          capture({ sourceRank: 1, text: 'first', at: 1_000 }),
          capture({ sourceRank: 1, text: 'second', at: 1_000 }),
        ],
        secret: SECRET,
      })
      // The tie-break is `c.at >= row.at`, so a same-rank/same-`at` duplicate
      // always patches during dedup — "upserted" is 1 as there's only 1 DB interaction.
      expect(res).toEqual({ received: 2, upserted: 1 })

      const rows = await t.run((ctx) => ctx.db.query('tweet_captures').collect())
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ sourceRank: 1, text: 'second' })
    })
  })
})

describe('captures:list', () => {
  it('fails closed on a bad caller secret', async () => {
    const t = convexTest(schema, modules)
    await expect(t.query(api.captures.list, { secret: 'WRONG' })).rejects.toThrow(
      /bad or missing sync secret/,
    )
  })

  it('returns the recorded rows newest-first (`by_at` desc)', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(api.captures.recordCaptures, {
      captures: [
        capture({ captureId: 'dev-1/t-1', tweetId: 't-1', at: 1_000 }),
        capture({ captureId: 'dev-1/t-2', tweetId: 't-2', at: 3_000 }),
        capture({ captureId: 'dev-1/t-3', tweetId: 't-3', at: 2_000 }),
      ],
      secret: SECRET,
    })

    const rows = await t.query(api.captures.list, { secret: SECRET })
    expect(rows.map((r) => r.tweetId)).toEqual(['t-2', 't-3', 't-1'])
  })

  it('scopes to one thread when conversationId is given', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(api.captures.recordCaptures, {
      captures: [
        capture({ captureId: 'dev-1/t-1', tweetId: 't-1', conversationId: 'c-1' }),
        capture({ captureId: 'dev-1/t-2', tweetId: 't-2', conversationId: 'c-2' }),
        capture({ captureId: 'dev-1/t-3', tweetId: 't-3', conversationId: 'c-1' }),
      ],
      secret: SECRET,
    })

    const rows = await t.query(api.captures.list, { secret: SECRET, conversationId: 'c-1' })
    expect(rows.map((r) => r.tweetId).sort()).toEqual(['t-1', 't-3'])
    expect(rows.every((r) => r.conversationId === 'c-1')).toBe(true)
  })

  it('narrows to one device when deviceId is given', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(api.captures.recordCaptures, {
      captures: [
        capture({ captureId: 'dev-1/t-1', tweetId: 't-1', deviceId: 'dev-1' }),
        capture({ captureId: 'dev-2/t-2', tweetId: 't-2', deviceId: 'dev-2' }),
      ],
      secret: SECRET,
    })

    const rows = await t.query(api.captures.list, { secret: SECRET, deviceId: 'dev-2' })
    expect(rows.map((r) => r.tweetId)).toEqual(['t-2'])
    expect(rows.every((r) => r.deviceId === 'dev-2')).toBe(true)
  })
})
