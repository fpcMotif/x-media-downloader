import { convexTest } from 'convex-test'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import schema from './schema'
import { api } from './_generated/api'

// Load every Convex module for the in-memory deployment (codegen-free runtime).
const modules = import.meta.glob('./**/*.ts')

const SECRET = 'test-shared-secret'

const media = (over: Record<string, unknown> = {}) => ({
  tweetId: '100',
  handle: 'alice',
  type: 'photo',
  url: 'https://pbs.twimg.com/media/AAA',
  ext: 'jpg',
  index: 0,
  ...over,
})

const evt = (over: Record<string, unknown> = {}) => ({
  eventId: 'dev-1/req-1/queued',
  kind: 'queued' as const,
  requestId: 'req-1',
  deviceId: 'dev-1',
  at: 1_000,
  media: media(),
  ...over,
})

beforeEach(() => {
  vi.stubEnv('SYNC_SHARED_SECRET', SECRET)
})

describe('sync:recordEvents', () => {
  it('inserts events and materializes media_state', async () => {
    const t = convexTest(schema, modules)
    const res = await t.mutation(api.sync.recordEvents, { events: [evt()], secret: SECRET })
    expect(res).toEqual({ received: 1, inserted: 1 })

    const stored = await t.run(async (ctx) => ({
      events: await ctx.db.query('sync_events').collect(),
      state: await ctx.db.query('media_state').collect(),
    }))
    expect(stored.events).toHaveLength(1)
    expect(stored.state).toHaveLength(1)
    expect(stored.state[0]).toMatchObject({
      requestId: 'req-1',
      deviceId: 'dev-1',
      lastKind: 'queued',
      at: 1_000,
    })
  })

  it('is idempotent: a re-sent eventId is skipped (at-least-once → exactly-once)', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(api.sync.recordEvents, { events: [evt()], secret: SECRET })
    const again = await t.mutation(api.sync.recordEvents, { events: [evt()], secret: SECRET })
    expect(again).toEqual({ received: 1, inserted: 0 })

    const count = await t.run((ctx) => ctx.db.query('sync_events').collect())
    expect(count).toHaveLength(1)
  })

  it('materializes last-write-wins by `at` on media_state', async () => {
    const t = convexTest(schema, modules)
    // queued@1000 then completed@2000 for the same request: state advances.
    await t.mutation(api.sync.recordEvents, {
      events: [
        evt({ eventId: 'dev-1/req-1/queued', kind: 'queued', at: 1_000 }),
        evt({ eventId: 'dev-1/req-1/completed', kind: 'completed', at: 2_000, media: undefined }),
      ],
      secret: SECRET,
    })
    const state = await t.run((ctx) =>
      ctx.db
        .query('media_state')
        .withIndex('by_device_request', (q) => q.eq('deviceId', 'dev-1').eq('requestId', 'req-1'))
        .first(),
    )
    expect(state).toMatchObject({ lastKind: 'completed', at: 2_000 })
    // media from the queued event is retained (completed carried none).
    expect(state?.media).toMatchObject({ tweetId: '100' })
  })

  it('does NOT regress media_state on an out-of-order (older `at`) event', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(api.sync.recordEvents, {
      events: [evt({ eventId: 'dev-1/req-1/completed', kind: 'completed', at: 5_000 })],
      secret: SECRET,
    })
    // A late-arriving older event must not overwrite the newer state.
    await t.mutation(api.sync.recordEvents, {
      events: [evt({ eventId: 'dev-1/req-1/queued', kind: 'queued', at: 1_000 })],
      secret: SECRET,
    })
    const state = await t.run((ctx) =>
      ctx.db
        .query('media_state')
        .withIndex('by_device_request', (q) => q.eq('deviceId', 'dev-1').eq('requestId', 'req-1'))
        .first(),
    )
    expect(state).toMatchObject({ lastKind: 'completed', at: 5_000 })
  })

  it('fails closed when the deployment has no SYNC_SHARED_SECRET configured', async () => {
    vi.stubEnv('SYNC_SHARED_SECRET', '')
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(api.sync.recordEvents, { events: [evt()], secret: 'anything' }),
    ).rejects.toThrow(/no SYNC_SHARED_SECRET configured/)
  })

  it('rejects a bad/missing caller secret', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(api.sync.recordEvents, { events: [evt()], secret: 'WRONG' }),
    ).rejects.toThrow(/bad or missing sync secret/)
  })

  it('accepts a batch and reports received vs inserted across a partial dup', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(api.sync.recordEvents, {
      events: [evt({ eventId: 'dev-1/a/queued', requestId: 'a' })],
      secret: SECRET,
    })
    const res = await t.mutation(api.sync.recordEvents, {
      events: [
        evt({ eventId: 'dev-1/a/queued', requestId: 'a' }), // dup
        evt({ eventId: 'dev-1/b/queued', requestId: 'b' }), // new
      ],
      secret: SECRET,
    })
    expect(res).toEqual({ received: 2, inserted: 1 })
  })
})

describe('sync:recentEvents', () => {
  it('returns events newest-first, cursor-paginated', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(api.sync.recordEvents, {
      events: [
        evt({ eventId: 'dev-1/r1/queued', requestId: 'r1', at: 1_000 }),
        evt({ eventId: 'dev-1/r2/queued', requestId: 'r2', at: 3_000 }),
        evt({ eventId: 'dev-1/r3/queued', requestId: 'r3', at: 2_000 }),
      ],
      secret: SECRET,
    })
    const page = await t.query(api.sync.recentEvents, {
      paginationOpts: { numItems: 2, cursor: null },
      secret: SECRET,
    })
    expect(page.page.map((e) => e.at)).toEqual([3_000, 2_000]) // desc by `at`
    expect(page.isDone).toBe(false)

    const rest = await t.query(api.sync.recentEvents, {
      paginationOpts: { numItems: 2, cursor: page.continueCursor },
      secret: SECRET,
    })
    expect(rest.page.map((e) => e.at)).toEqual([1_000])
    expect(rest.isDone).toBe(true)
  })

  it('rejects an unauthenticated read (bad/missing secret)', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.query(api.sync.recentEvents, {
        paginationOpts: { numItems: 2, cursor: null },
        secret: 'x',
      }),
    ).rejects.toThrow(/bad or missing sync secret/)
  })
})
