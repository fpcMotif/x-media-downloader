import { convexTest } from 'convex-test'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from './_generated/api'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')

const SECRET = 'test-shared-secret'
const CAPTURE_ID_PREFIX = 'xmd:capture:v1:'
const MAX_CAPTURE_EVENT_BYTES = 256 * 1024 + 16 * 1024
const encoder = new TextEncoder()

const captureIdFor = (deviceId: string, tweetId: string): string =>
  `${CAPTURE_ID_PREFIX}${deviceId.length}:${deviceId}:${tweetId.length}:${tweetId}`

const capture = (over: Record<string, unknown> = {}) => {
  const deviceId = typeof over.deviceId === 'string' ? over.deviceId : 'dev-1'
  const tweetId = typeof over.tweetId === 'string' ? over.tweetId : '101'
  return {
    captureId: captureIdFor(deviceId, tweetId),
    deviceId,
    tweetId,
    conversationId: '101',
    handle: 'alice',
    text: 'a thin sighting',
    sourceRank: 1,
    at: 1_000,
    ...over,
  }
}

const firstPage = (numItems = 100) => ({ numItems, cursor: null })

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

  it('stores the injective capture identity', async () => {
    const t = convexTest(schema, modules)
    const res = await t.mutation(api.captures.recordCaptures, {
      captures: [capture()],
      secret: SECRET,
    })
    expect(res).toEqual({ received: 1, upserted: 1 })

    const rows = await t.run((ctx) => ctx.db.query('tweet_captures').collect())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      captureId: captureIdFor('dev-1', '101'),
      tweetId: '101',
      sourceRank: 1,
    })
  })

  it('accepts a genuine slash-free legacy identity and stores its canonical form', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(api.captures.recordCaptures, {
        captures: [capture({ captureId: 'dev-1/101' })],
        secret: SECRET,
      }),
    ).resolves.toEqual({ received: 1, upserted: 1 })

    const rows = await t.run((ctx) => ctx.db.query('tweet_captures').collect())
    expect(rows).toHaveLength(1)
    expect(rows[0]?.captureId).toBe(captureIdFor('dev-1', '101'))
  })

  it('migrates a stored legacy row instead of duplicating it', async () => {
    const t = convexTest(schema, modules)
    await t.run((ctx) =>
      ctx.db.insert('tweet_captures', capture({ captureId: 'dev-1/101', text: 'legacy' })),
    )

    await expect(
      t.mutation(api.captures.recordCaptures, {
        captures: [capture({ text: 'current', at: 2_000 })],
        secret: SECRET,
      }),
    ).resolves.toEqual({ received: 1, upserted: 1 })

    const rows = await t.run((ctx) => ctx.db.query('tweet_captures').collect())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      captureId: captureIdFor('dev-1', '101'),
      text: 'current',
    })
  })

  it('reconciles divergent canonical and legacy aliases, then stays idempotent', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert(
        'tweet_captures',
        capture({ captureId: captureIdFor('dev-1', '101'), text: 'thin canonical', at: 3_000 }),
      )
      await ctx.db.insert(
        'tweet_captures',
        capture({
          captureId: 'dev-1/101',
          sourceRank: 2,
          text: 'rich legacy',
          at: 2_000,
        }),
      )
    })

    await expect(
      t.mutation(api.captures.recordCaptures, {
        captures: [capture({ text: 'later thin input', at: 4_000 })],
        secret: SECRET,
      }),
    ).resolves.toEqual({ received: 1, upserted: 1 })

    const rows = await t.run((ctx) => ctx.db.query('tweet_captures').collect())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      captureId: captureIdFor('dev-1', '101'),
      sourceRank: 2,
      text: 'rich legacy',
      at: 2_000,
    })

    await expect(
      t.mutation(api.captures.recordCaptures, {
        captures: [capture({ text: 'later thin input', at: 4_000 })],
        secret: SECRET,
      }),
    ).resolves.toEqual({ received: 1, upserted: 0 })
  })

  it('keeps stored alias ties stable, then lets incoming win an exact §6.4 tie', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert(
        'tweet_captures',
        capture({ captureId: captureIdFor('dev-1', '101'), text: 'canonical tie' }),
      )
      await ctx.db.insert('tweet_captures', capture({ captureId: 'dev-1/101', text: 'legacy tie' }))
    })

    await t.mutation(api.captures.recordCaptures, {
      captures: [capture({ text: 'input tie' })],
      secret: SECRET,
    })

    const rows = await t.run((ctx) => ctx.db.query('tweet_captures').collect())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      captureId: captureIdFor('dev-1', '101'),
      text: 'input tie',
    })
  })

  it('fails closed when any stored alias violates current payload bounds', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('tweet_captures', capture({ text: 'valid canonical' }))
      await ctx.db.insert(
        'tweet_captures',
        capture({
          captureId: 'dev-1/101',
          text: 'x'.repeat(MAX_CAPTURE_EVENT_BYTES + 1),
        }),
      )
    })

    await expect(
      t.mutation(api.captures.recordCaptures, {
        captures: [capture({ text: 'valid incoming' })],
        secret: SECRET,
      }),
    ).rejects.toThrow(/stored capture identity or payload mismatch/i)

    const rows = await t.run((ctx) => ctx.db.query('tweet_captures').collect())
    expect(rows).toHaveLength(2)
  })

  it('accepts delimiters inside a device only through the injective identity', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(api.captures.recordCaptures, {
        captures: [capture({ deviceId: 'dev/one' })],
        secret: SECRET,
      }),
    ).resolves.toEqual({ received: 1, upserted: 1 })
    await expect(
      t.mutation(api.captures.recordCaptures, {
        captures: [capture({ deviceId: 'dev/one', captureId: 'dev/one/101' })],
        secret: SECRET,
      }),
    ).rejects.toThrow(/invalid capture identity or payload/i)
  })

  it('rejects a forged identity', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(api.captures.recordCaptures, {
        captures: [capture({ captureId: captureIdFor('dev-2', '101') })],
        secret: SECRET,
      }),
    ).rejects.toThrow(/invalid capture identity or payload/i)
  })

  it('accepts 64 rows and rejects 65', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(api.captures.recordCaptures, {
        captures: Array.from({ length: 64 }, (_, index) =>
          capture({ tweetId: String(1_000 + index), conversationId: '1000' }),
        ),
        secret: SECRET,
      }),
    ).resolves.toMatchObject({ received: 64 })
    await expect(
      t.mutation(api.captures.recordCaptures, {
        captures: Array.from({ length: 65 }, () => capture()),
        secret: SECRET,
      }),
    ).rejects.toThrow(/capture batch too large/i)
  })

  it('rejects a count-valid batch above the durable client byte bound', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(api.captures.recordCaptures, {
        captures: Array.from({ length: 64 }, (_, index) =>
          capture({
            tweetId: String(2_000 + index),
            conversationId: '2000',
            text: 'x'.repeat(70_000),
          }),
        ),
        secret: SECRET,
      }),
    ).rejects.toThrow(/capture batch too large/i)
  })

  it.each([
    ['tweetId', { tweetId: 'not-a-snowflake' }],
    ['conversationId', { conversationId: 'thread-1' }],
    ['inReplyToTweetId', { inReplyToTweetId: 'reply-1' }],
  ])('rejects an invalid %s', async (_field, over) => {
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(api.captures.recordCaptures, {
        captures: [capture(over)],
        secret: SECRET,
      }),
    ).rejects.toThrow(/invalid capture identity or payload/i)
  })

  it.each([
    ['empty device', { deviceId: '' }],
    ['long device', { deviceId: 'd'.repeat(65) }],
    ['long handle', { handle: 'h'.repeat(65) }],
    ['long URL', { links: [{ expandedUrl: 'u'.repeat(8_193) }] }],
    ['long link title', { links: [{ expandedUrl: 'u', title: 't'.repeat(513) }] }],
    ['long link domain', { links: [{ expandedUrl: 'u', domain: 'd'.repeat(256) }] }],
    [
      'too many links',
      { links: Array.from({ length: 101 }, () => ({ expandedUrl: 'https://example.test' })) },
    ],
    ['negative createdAt', { createdAt: -1 }],
    ['fractional createdAt', { createdAt: 1.5 }],
    ['unsafe createdAt', { createdAt: Number.MAX_SAFE_INTEGER + 1 }],
    ['invalid source rank', { sourceRank: 3 }],
    ['negative at', { at: -1 }],
    ['fractional at', { at: 1.5 }],
    ['unsafe at', { at: Number.MAX_SAFE_INTEGER + 1 }],
  ])('rejects %s', async (_case, over) => {
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(api.captures.recordCaptures, {
        captures: [capture(over)],
        secret: SECRET,
      }),
    ).rejects.toThrow(/invalid capture identity or payload/i)
  })

  it('rejects a row whose escaped JSON exceeds the event byte budget', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(api.captures.recordCaptures, {
        captures: [capture({ text: '\0'.repeat(50_000) })],
        secret: SECRET,
      }),
    ).rejects.toThrow(/invalid capture identity or payload/i)
  })

  it('budgets the canonical row when accepting a shorter legacy identity', async () => {
    const t = convexTest(schema, modules)
    const canonicalBaseBytes = encoder.encode(JSON.stringify(capture({ text: '' }))).byteLength
    const text = 'x'.repeat(MAX_CAPTURE_EVENT_BYTES - canonicalBaseBytes + 1)
    const legacy = capture({ captureId: 'dev-1/101', text })
    expect(encoder.encode(JSON.stringify(legacy)).byteLength).toBeLessThanOrEqual(
      MAX_CAPTURE_EVENT_BYTES,
    )
    await expect(
      t.mutation(api.captures.recordCaptures, {
        captures: [legacy],
        secret: SECRET,
      }),
    ).rejects.toThrow(/invalid capture identity or payload/i)
  })

  it('rejects excess row fields', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(api.captures.recordCaptures, {
        captures: [capture({ forged: true })],
        secret: SECRET,
      }),
    ).rejects.toThrow(/unexpected field.*forged/i)
  })

  it('§6.4: a later thin sighting does not overwrite a rich row', async () => {
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

  it('§6.4: an old same-rank retry cannot appear newer', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(api.captures.recordCaptures, {
      captures: [capture({ sourceRank: 2, text: 'current', at: 2_000 })],
      secret: SECRET,
    })
    await expect(
      t.mutation(api.captures.recordCaptures, {
        captures: [capture({ sourceRank: 2, text: 'old retry', at: 1_000 })],
        secret: SECRET,
      }),
    ).resolves.toEqual({ received: 1, upserted: 0 })

    const rows = await t.run((ctx) => ctx.db.query('tweet_captures').collect())
    expect(rows[0]).toMatchObject({ text: 'current', at: 2_000 })
  })
})

describe('captures:list', () => {
  it('fails closed on a bad caller secret', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.query(api.captures.list, { secret: 'WRONG', paginationOpts: firstPage() }),
    ).rejects.toThrow(/bad or missing sync secret/)
  })

  it('returns recorded rows newest-first with cursor state', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(api.captures.recordCaptures, {
      captures: [
        capture({ tweetId: '101', at: 1_000 }),
        capture({ tweetId: '102', at: 3_000 }),
        capture({ tweetId: '103', at: 2_000 }),
      ],
      secret: SECRET,
    })

    const page = await t.query(api.captures.list, {
      secret: SECRET,
      paginationOpts: firstPage(2),
    })
    expect(page.page.map((row) => row.tweetId)).toEqual(['102', '103'])
    expect(page.continueCursor).toEqual(expect.any(String))
    expect(page.isDone).toBe(false)

    const rest = await t.query(api.captures.list, {
      secret: SECRET,
      paginationOpts: { numItems: 2, cursor: page.continueCursor },
    })
    expect(rest.page.map((row) => row.tweetId)).toEqual(['101'])
    expect(rest.isDone).toBe(true)
  })

  it('pages more than 1,000 rows without dropping history', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      for (let index = 0; index < 1_001; index += 1) {
        const tweetId = String(10_000 + index)
        await ctx.db.insert(
          'tweet_captures',
          capture({ tweetId, conversationId: '10000', at: index }),
        )
      }
    })

    const first = await t.query(api.captures.list, {
      secret: SECRET,
      paginationOpts: firstPage(1_000),
    })
    expect(first.page).toHaveLength(1_000)
    expect(first.isDone).toBe(false)
    expect(first.continueCursor).toEqual(expect.any(String))

    const second = await t.query(api.captures.list, {
      secret: SECRET,
      paginationOpts: { numItems: 1_000, cursor: first.continueCursor },
    })
    expect(second.page).toHaveLength(1)
    expect(second.isDone).toBe(true)
    expect(new Set([...first.page, ...second.page].map((row) => row.captureId)).size).toBe(1_001)
  })

  it('uses the conversation index before pagination', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(api.captures.recordCaptures, {
      captures: [
        capture({ tweetId: '101', conversationId: '201' }),
        capture({ tweetId: '102', conversationId: '202' }),
        capture({ tweetId: '103', conversationId: '201' }),
      ],
      secret: SECRET,
    })

    const page = await t.query(api.captures.list, {
      secret: SECRET,
      conversationId: '201',
      paginationOpts: firstPage(),
    })
    expect(page.page.map((row) => row.tweetId).toSorted()).toEqual(['101', '103'])
    expect(page.page.every((row) => row.conversationId === '201')).toBe(true)
  })

  it('uses the device index before pagination', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(api.captures.recordCaptures, {
      captures: [
        capture({ tweetId: '101', deviceId: 'dev-1' }),
        capture({ tweetId: '102', deviceId: 'dev-2' }),
      ],
      secret: SECRET,
    })

    const page = await t.query(api.captures.list, {
      secret: SECRET,
      deviceId: 'dev-2',
      paginationOpts: firstPage(),
    })
    expect(page.page.map((row) => row.tweetId)).toEqual(['102'])
    expect(page.page.every((row) => row.deviceId === 'dev-2')).toBe(true)
  })

  it('applies the device filter before pagination', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(api.captures.recordCaptures, {
      captures: [
        capture({ tweetId: '101', deviceId: 'dev-1', at: 1_000 }),
        capture({ tweetId: '102', deviceId: 'dev-2', at: 3_000 }),
        capture({ tweetId: '103', deviceId: 'dev-2', at: 2_000 }),
      ],
      secret: SECRET,
    })

    const page = await t.query(api.captures.list, {
      secret: SECRET,
      deviceId: 'dev-1',
      paginationOpts: firstPage(1),
    })
    expect(page.page.map((row) => row.tweetId)).toEqual(['101'])
  })

  it('uses both indexed filters before pagination', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(api.captures.recordCaptures, {
      captures: [
        capture({ tweetId: '101', deviceId: 'dev-1', conversationId: '201', at: 1_000 }),
        capture({ tweetId: '102', deviceId: 'dev-2', conversationId: '201', at: 3_000 }),
        capture({ tweetId: '103', deviceId: 'dev-1', conversationId: '202', at: 2_000 }),
      ],
      secret: SECRET,
    })

    const page = await t.query(api.captures.list, {
      secret: SECRET,
      deviceId: 'dev-1',
      conversationId: '201',
      paginationOpts: firstPage(1),
    })
    expect(page.page.map((row) => row.tweetId)).toEqual(['101'])
  })

  it.each([
    ['deviceId', { deviceId: 'd'.repeat(65) }],
    ['conversationId', { conversationId: 'not-a-snowflake' }],
  ])('rejects an invalid %s filter', async (_field, filter) => {
    const t = convexTest(schema, modules)
    await expect(
      t.query(api.captures.list, { secret: SECRET, paginationOpts: firstPage(), ...filter }),
    ).rejects.toThrow(/invalid capture list filter/i)
  })
})
