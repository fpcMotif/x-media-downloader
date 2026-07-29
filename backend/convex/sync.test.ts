import { convexTest } from 'convex-test'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import schema from './schema'
import { api } from './_generated/api'

// Load every Convex module for the in-memory deployment (codegen-free runtime).
const modules = import.meta.glob('./**/*.ts')

const SECRET = 'test-shared-secret'
const MAX_POST_ID_LENGTH = 128
const MAX_REQUEST_ID_LENGTH = 'xmd:v1:sidecar:instagram:512:'.length + 512

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

const currentEventId = (
  deviceId: string,
  requestId: string,
  kind: 'queued' | 'completed' | 'failed',
): string => `xmd-sync:v1:${deviceId.length}:${deviceId}:${requestId.length}:${requestId}:${kind}`

beforeEach(() => {
  vi.stubEnv('SYNC_SHARED_SECRET', SECRET)
})

describe('sync:recordEvents', () => {
  it('rejects more than 64 events', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(api.sync.recordEvents, {
        events: Array.from({ length: 65 }, () => evt()),
        secret: SECRET,
      }),
    ).rejects.toThrow('sync event batch too large')
  })

  it('accepts both the current injective identity and a valid legacy retry', async () => {
    const t = convexTest(schema, modules)
    const current = evt({ eventId: 'xmd-sync:v1:5:dev-1:5:req-1:queued' })
    const legacy = evt({
      eventId: 'dev-1/req-1/completed',
      kind: 'completed',
      media: undefined,
    })

    expect(
      await t.mutation(api.sync.recordEvents, {
        events: [current],
        secret: SECRET,
      }),
    ).toMatchObject({
      inserted: 1,
    })
    expect(
      await t.mutation(api.sync.recordEvents, {
        events: [legacy],
        secret: SECRET,
      }),
    ).toMatchObject({
      inserted: 1,
    })
  })

  it('normalizes legacy client media before it reaches either durable table', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(api.sync.recordEvents, {
      events: [evt()],
      secret: SECRET,
    })

    const stored = await t.run(async (ctx) => ({
      event: await ctx.db.query('sync_events').first(),
      state: await ctx.db.query('media_state').first(),
    }))
    expect(stored.event?.media).toEqual({
      platform: 'x',
      postId: '100',
      author: 'alice',
      type: 'photo',
      url: 'https://pbs.twimg.com/media/AAA',
      ext: 'jpg',
      index: 0,
    })
    expect(stored.state?.media).toEqual(stored.event?.media)
    expect(stored.state).toMatchObject({
      platform: 'x',
      postId: '100',
      author: 'alice',
    })
  })

  it.each([
    [
      'legacy then current',
      [evt({ at: 100 }), evt({ eventId: 'xmd-sync:v1:5:dev-1:5:req-1:queued', at: 200 })],
    ],
    [
      'current then legacy',
      [evt({ eventId: 'xmd-sync:v1:5:dev-1:5:req-1:queued', at: 100 }), evt({ at: 200 })],
    ],
  ])(
    'stores one canonical first fact for a batch containing %s aliases',
    async (_label, events) => {
      const t = convexTest(schema, modules)
      expect(await t.mutation(api.sync.recordEvents, { events, secret: SECRET })).toEqual({
        received: 2,
        inserted: 1,
      })

      const rows = await t.run((ctx) => ctx.db.query('sync_events').collect())
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        eventId: 'xmd-sync:v1:5:dev-1:5:req-1:queued',
        at: 100,
      })
    },
  )

  it('canonicalizes an existing legacy fact without replacing its payload', async () => {
    const t = convexTest(schema, modules)
    await t.run((ctx) =>
      ctx.db.insert('sync_events', {
        eventId: 'dev-1/req-1/queued',
        kind: 'queued',
        requestId: 'req-1',
        deviceId: 'dev-1',
        at: 100,
        media: media(),
      }),
    )

    expect(
      await t.mutation(api.sync.recordEvents, {
        events: [
          evt({
            eventId: 'xmd-sync:v1:5:dev-1:5:req-1:queued',
            at: 200,
          }),
        ],
        secret: SECRET,
      }),
    ).toEqual({ received: 1, inserted: 0 })

    const rows = await t.run((ctx) => ctx.db.query('sync_events').collect())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      eventId: 'xmd-sync:v1:5:dev-1:5:req-1:queued',
      at: 100,
    })
  })

  it('collapses both historical aliases to the first stored fact', async () => {
    const t = convexTest(schema, modules)
    await t.run((ctx) =>
      ctx.db.insert('sync_events', {
        eventId: 'dev-1/req-1/queued',
        kind: 'queued',
        requestId: 'req-1',
        deviceId: 'dev-1',
        at: 100,
        media: media(),
      }),
    )
    await t.run((ctx) =>
      ctx.db.insert('sync_events', {
        eventId: 'xmd-sync:v1:5:dev-1:5:req-1:queued',
        kind: 'queued',
        requestId: 'req-1',
        deviceId: 'dev-1',
        at: 200,
        media: media({ url: 'https://pbs.twimg.com/media/NEW' }),
      }),
    )

    expect(
      await t.mutation(api.sync.recordEvents, {
        events: [evt({ eventId: 'xmd-sync:v1:5:dev-1:5:req-1:queued', at: 300 })],
        secret: SECRET,
      }),
    ).toEqual({ received: 1, inserted: 0 })

    const rows = await t.run((ctx) => ctx.db.query('sync_events').collect())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      eventId: 'xmd-sync:v1:5:dev-1:5:req-1:queued',
      at: 100,
      media: { url: 'https://pbs.twimg.com/media/AAA' },
    })
  })

  it('repairs media_state from the surviving alias before later outcomes', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('sync_events', {
        eventId: 'dev-1/req-1/queued',
        kind: 'queued',
        requestId: 'req-1',
        deviceId: 'dev-1',
        at: 100,
        media: media(),
      })
      await ctx.db.insert('sync_events', {
        eventId: 'xmd-sync:v1:5:dev-1:5:req-1:queued',
        kind: 'queued',
        requestId: 'req-1',
        deviceId: 'dev-1',
        at: 200,
        media: {
          platform: 'instagram',
          postId: 'loser',
          author: 'bob',
          type: 'photo',
          url: 'https://cdninstagram.com/media/NEW',
          ext: 'jpg',
          index: 0,
        },
      })
      await ctx.db.insert('media_state', {
        requestId: 'req-1',
        deviceId: 'dev-1',
        tweetId: 'loser',
        postId: 'loser',
        platform: 'instagram',
        lastKind: 'queued',
        at: 200,
        media: {
          platform: 'instagram',
          postId: 'loser',
          author: 'bob',
          type: 'photo',
          url: 'https://cdninstagram.com/media/NEW',
          ext: 'jpg',
          index: 0,
        },
      })
    })

    await t.mutation(api.sync.recordEvents, {
      events: [evt({ eventId: 'xmd-sync:v1:5:dev-1:5:req-1:queued', at: 300 })],
      secret: SECRET,
    })
    await t.mutation(api.sync.recordEvents, {
      events: [
        evt({
          eventId: 'xmd-sync:v1:5:dev-1:5:req-1:completed',
          kind: 'completed',
          at: 150,
          media: undefined,
        }),
      ],
      secret: SECRET,
    })

    const state = await t.run((ctx) =>
      ctx.db
        .query('media_state')
        .withIndex('by_device_request', (q) => q.eq('deviceId', 'dev-1').eq('requestId', 'req-1'))
        .first(),
    )
    expect(state).toMatchObject({
      lastKind: 'completed',
      at: 150,
      tweetId: '100',
      postId: '100',
      platform: 'x',
      media: { url: 'https://pbs.twimg.com/media/AAA' },
    })
  })

  it('projects first facts while other transition aliases still await repair', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('sync_events', {
        eventId: 'dev-1/req-1/queued',
        kind: 'queued',
        requestId: 'req-1',
        deviceId: 'dev-1',
        at: 100,
        media: media(),
      })
      await ctx.db.insert('sync_events', {
        eventId: 'xmd-sync:v1:5:dev-1:5:req-1:queued',
        kind: 'queued',
        requestId: 'req-1',
        deviceId: 'dev-1',
        at: 200,
        media: media({ url: 'https://pbs.twimg.com/media/QUEUED-LOSER' }),
      })
      await ctx.db.insert('sync_events', {
        eventId: 'dev-1/req-1/completed',
        kind: 'completed',
        requestId: 'req-1',
        deviceId: 'dev-1',
        at: 300,
      })
      await ctx.db.insert('sync_events', {
        eventId: 'xmd-sync:v1:5:dev-1:5:req-1:completed',
        kind: 'completed',
        requestId: 'req-1',
        deviceId: 'dev-1',
        at: 400,
      })
    })

    await t.mutation(api.sync.recordEvents, {
      events: [evt({ eventId: 'xmd-sync:v1:5:dev-1:5:req-1:queued', at: 500 })],
      secret: SECRET,
    })

    const state = await t.run((ctx) =>
      ctx.db
        .query('media_state')
        .withIndex('by_device_request', (q) => q.eq('deviceId', 'dev-1').eq('requestId', 'req-1'))
        .first(),
    )
    expect(state).toMatchObject({
      lastKind: 'completed',
      at: 300,
      media: { url: 'https://pbs.twimg.com/media/AAA' },
    })
  })

  it('excludes forged historical IDs from the materialized projection', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('sync_events', {
        eventId: 'forged',
        kind: 'queued',
        requestId: 'req-1',
        deviceId: 'dev-1',
        at: 999,
        media: media({ tweetId: '666' }),
      })
      await ctx.db.insert('sync_events', {
        eventId: 'dev-1/req-1/queued',
        kind: 'queued',
        requestId: 'req-1',
        deviceId: 'dev-1',
        at: 100,
        media: media(),
      })
    })

    await t.mutation(api.sync.recordEvents, {
      events: [evt({ eventId: 'xmd-sync:v1:5:dev-1:5:req-1:queued', at: 500 })],
      secret: SECRET,
    })

    const state = await t.run((ctx) =>
      ctx.db
        .query('media_state')
        .withIndex('by_device_request', (q) => q.eq('deviceId', 'dev-1').eq('requestId', 'req-1'))
        .first(),
    )
    expect(state).toMatchObject({
      lastKind: 'queued',
      at: 100,
      tweetId: '100',
      media: { url: 'https://pbs.twimg.com/media/AAA' },
    })
  })

  it('projects known current and legacy facts without reading forged sibling rows', async () => {
    const t = convexTest(schema, modules)
    // oxlint-disable no-await-in-loop -- this seeds one adversarial transaction
    await t.run(async (ctx) => {
      for (let i = 0; i < 1_025; i += 1) {
        await ctx.db.insert('sync_events', {
          eventId: `forged-${i}`,
          kind: 'queued',
          requestId: 'req-1',
          deviceId: 'dev-1',
          at: i,
          media: media({ tweetId: `forged-${i}` }),
        })
      }
      await ctx.db.insert('sync_events', {
        eventId: 'dev-1/req-1/queued',
        kind: 'queued',
        requestId: 'req-1',
        deviceId: 'dev-1',
        at: 100,
        media: media(),
      })
      // Both completed aliases are present. The first stored fact wins.
      await ctx.db.insert('sync_events', {
        eventId: 'dev-1/req-1/completed',
        kind: 'completed',
        requestId: 'req-1',
        deviceId: 'dev-1',
        at: 200,
      })
      await ctx.db.insert('sync_events', {
        eventId: currentEventId('dev-1', 'req-1', 'completed'),
        kind: 'completed',
        requestId: 'req-1',
        deviceId: 'dev-1',
        at: 250,
      })
    })
    // oxlint-enable no-await-in-loop

    await t.mutation(api.sync.recordEvents, {
      events: [
        evt({
          eventId: currentEventId('dev-1', 'req-1', 'failed'),
          kind: 'failed',
          at: 225,
          media: undefined,
        }),
      ],
      secret: SECRET,
    })

    const state = await t.run((ctx) =>
      ctx.db
        .query('media_state')
        .withIndex('by_device_request', (q) => q.eq('deviceId', 'dev-1').eq('requestId', 'req-1'))
        .first(),
    )
    expect(state).toMatchObject({
      lastKind: 'failed',
      at: 225,
      tweetId: '100',
      media: { url: 'https://pbs.twimg.com/media/AAA' },
    })
  })

  it('fails closed on a malformed historical row with a valid alias ID', async () => {
    const t = convexTest(schema, modules)
    await t.run((ctx) =>
      ctx.db.insert('sync_events', {
        eventId: 'dev-1/req-1/queued',
        kind: 'queued',
        requestId: 'req-1',
        deviceId: 'dev-1',
        at: 100,
      }),
    )

    await expect(
      t.mutation(api.sync.recordEvents, {
        events: [evt({ eventId: 'xmd-sync:v1:5:dev-1:5:req-1:queued' })],
        secret: SECRET,
      }),
    ).rejects.toThrow('Conflicting stored sync event identity')
  })

  it('clears stale optional media when surviving aliases carry no media', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('sync_events', {
        eventId: 'dev-1/req-1/completed',
        kind: 'completed',
        requestId: 'req-1',
        deviceId: 'dev-1',
        at: 100,
      })
      await ctx.db.insert('sync_events', {
        eventId: 'xmd-sync:v1:5:dev-1:5:req-1:completed',
        kind: 'completed',
        requestId: 'req-1',
        deviceId: 'dev-1',
        at: 200,
      })
      await ctx.db.insert('media_state', {
        requestId: 'req-1',
        deviceId: 'dev-1',
        tweetId: 'stale',
        postId: 'stale',
        platform: 'instagram',
        lastKind: 'queued',
        at: 200,
        media: {
          platform: 'instagram',
          postId: 'stale',
          author: 'bob',
          type: 'photo',
          url: 'https://cdninstagram.com/media/STALE',
          ext: 'jpg',
          index: 0,
        },
      })
    })

    await t.mutation(api.sync.recordEvents, {
      events: [
        evt({
          eventId: 'xmd-sync:v1:5:dev-1:5:req-1:completed',
          kind: 'completed',
          at: 300,
          media: undefined,
        }),
      ],
      secret: SECRET,
    })

    const state = await t.run((ctx) =>
      ctx.db
        .query('media_state')
        .withIndex('by_device_request', (q) => q.eq('deviceId', 'dev-1').eq('requestId', 'req-1'))
        .first(),
    )
    expect(state).toMatchObject({
      lastKind: 'completed',
      at: 100,
      tweetId: '',
      postId: '',
    })
    expect(state).not.toHaveProperty('platform')
    expect(state).not.toHaveProperty('media')
  })

  it('fails closed on a historical row whose ID names another logical event', async () => {
    const t = convexTest(schema, modules)
    await t.run((ctx) =>
      ctx.db.insert('sync_events', {
        eventId: 'xmd-sync:v1:5:dev-1:5:req-1:queued',
        kind: 'queued',
        requestId: 'other',
        deviceId: 'dev-1',
        at: 100,
        media: media(),
      }),
    )

    await expect(
      t.mutation(api.sync.recordEvents, {
        events: [evt({ eventId: 'xmd-sync:v1:5:dev-1:5:req-1:queued' })],
        secret: SECRET,
      }),
    ).rejects.toThrow('Conflicting stored sync event identity')
  })

  it('rejects an event ID that is not derived from its fields', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(api.sync.recordEvents, {
        events: [evt({ eventId: 'xmd-sync:v1:5:dev-1:5:other:queued' })],
        secret: SECRET,
      }),
    ).rejects.toThrow('Invalid sync event identity')
  })

  it('rejects an oversized event ID as payload before identity matching', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(api.sync.recordEvents, {
        events: [evt({ eventId: 'e'.repeat(636) })],
        secret: SECRET,
      }),
    ).rejects.toThrow('Invalid sync event payload')
  })

  it('rejects extra top-level event fields', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(api.sync.recordEvents, {
        events: [evt({ callerOwned: true })],
        secret: SECRET,
      }),
    ).rejects.toThrow('Unexpected field `callerOwned`')
  })

  it('rejects an ambiguous slash-form legacy identity', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(api.sync.recordEvents, {
        events: [
          evt({
            deviceId: 'dev/one',
            eventId: 'dev/one/req-1/queued',
          }),
        ],
        secret: SECRET,
      }),
    ).rejects.toThrow('Invalid sync event identity')
  })

  it.each([
    ['NaN timestamp', evt({ at: Number.NaN })],
    ['infinite timestamp', evt({ at: Number.POSITIVE_INFINITY })],
    ['fractional timestamp', evt({ at: 1.5 })],
    ['negative timestamp', evt({ at: -1 })],
    ['unsafe timestamp', evt({ at: Number.MAX_SAFE_INTEGER + 1 })],
    ['NaN media index', evt({ media: media({ index: Number.NaN }) })],
    ['fractional media index', evt({ media: media({ index: 0.5 }) })],
    ['negative media index', evt({ media: media({ index: -1 }) })],
  ])('rejects a %s', async (_label, event) => {
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(api.sync.recordEvents, { events: [event], secret: SECRET }),
    ).rejects.toThrow('Invalid sync event payload')
  })

  it.each([
    ['unknown media type', media({ type: 'audio' })],
    ['empty legacy post ID', media({ tweetId: '' })],
    ['long legacy post ID', media({ tweetId: 'p'.repeat(129) })],
    ['long legacy author', media({ handle: 'a'.repeat(257) })],
    ['non-HTTPS URL', media({ url: 'http://example.com/media' })],
    ['long URL', media({ url: `https://example.com/${'u'.repeat(8_193)}` })],
    ['empty extension', media({ ext: '' })],
    ['long extension', media({ ext: 'e'.repeat(17) })],
    ['large media index', media({ index: 1_024 })],
    ['mixed legacy/current shape', media({ platform: 'x', postId: '100', author: 'alice' })],
    [
      'incomplete current shape',
      {
        platform: 'x',
        postId: '100',
        type: 'photo',
        url: 'https://pbs.twimg.com/media/AAA',
        ext: 'jpg',
        index: 0,
      },
    ],
  ])('rejects %s', async (_label, invalidMedia) => {
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(api.sync.recordEvents, {
        events: [evt({ media: invalidMedia })],
        secret: SECRET,
      }),
    ).rejects.toThrow('Invalid sync event payload')
  })

  it('rejects an event above 16 KiB even when each string meets its character cap', async () => {
    const t = convexTest(schema, modules)
    const deviceId = '💾'.repeat(32)
    const requestId = `${'💾'.repeat(270)}a`
    await expect(
      t.mutation(api.sync.recordEvents, {
        events: [
          evt({
            deviceId,
            requestId,
            eventId: currentEventId(deviceId, requestId, 'queued'),
            media: {
              platform: 'instagram',
              postId: '💾'.repeat(64),
              author: '💾'.repeat(128),
              type: 'photo',
              url: `https://example.com/${'💾'.repeat(4_086)}`,
              ext: 'jpeg',
              index: 0,
            },
          }),
        ],
        secret: SECRET,
      }),
    ).rejects.toThrow('Invalid sync event payload')
  })

  it('inserts events and materializes media_state', async () => {
    const t = convexTest(schema, modules)
    const res = await t.mutation(api.sync.recordEvents, {
      events: [evt()],
      secret: SECRET,
    })
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
    await t.mutation(api.sync.recordEvents, {
      events: [evt()],
      secret: SECRET,
    })
    const again = await t.mutation(api.sync.recordEvents, {
      events: [evt()],
      secret: SECRET,
    })
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
        evt({
          eventId: 'dev-1/req-1/completed',
          kind: 'completed',
          at: 2_000,
          media: undefined,
        }),
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
    expect(state?.media).toMatchObject({
      platform: 'x',
      postId: '100',
      author: 'alice',
    })
  })

  it('rebuilds indexed media fields when queued follows terminal-only state', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(api.sync.recordEvents, {
      events: [
        evt({
          eventId: 'xmd-sync:v1:5:dev-1:5:req-1:completed',
          kind: 'completed',
          at: 100,
          media: undefined,
        }),
      ],
      secret: SECRET,
    })
    await t.mutation(api.sync.recordEvents, {
      events: [
        evt({
          eventId: 'xmd-sync:v1:5:dev-1:5:req-1:queued',
          at: 200,
          media: {
            platform: 'instagram',
            postId: 'P',
            author: 'alice',
            type: 'photo',
            url: 'https://cdninstagram.com/media/P',
            ext: 'jpg',
            index: 0,
          },
        }),
      ],
      secret: SECRET,
    })

    const state = await t.run((ctx) =>
      ctx.db
        .query('media_state')
        .withIndex('by_device_request', (q) => q.eq('deviceId', 'dev-1').eq('requestId', 'req-1'))
        .first(),
    )
    expect(state).toMatchObject({
      lastKind: 'queued',
      at: 200,
      tweetId: 'P',
      postId: 'P',
      platform: 'instagram',
      media: { postId: 'P' },
    })
  })

  it('populates a top-level tweetId from queued media and indexes it (by_tweet)', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(api.sync.recordEvents, {
      events: [evt({ media: media({ tweetId: 'T1' }) })],
      secret: SECRET,
    })
    const byIndex = await t.run((ctx) =>
      ctx.db
        .query('media_state')
        .withIndex('by_tweet', (q) => q.eq('tweetId', 'T1'))
        .first(),
    )
    expect(byIndex).toMatchObject({
      tweetId: 'T1',
      requestId: 'req-1',
      deviceId: 'dev-1',
    })
  })

  it('populates the generalized postId/platform from a new-model event (multi-platform)', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(api.sync.recordEvents, {
      events: [
        evt({
          media: {
            platform: 'instagram',
            postId: 'P1',
            author: 'bob',
            type: 'photo',
            url: 'https://example.com/media',
            ext: 'jpg',
            index: 0,
          },
        }),
      ],
      secret: SECRET,
    })
    const byIndex = await t.run((ctx) =>
      ctx.db
        .query('media_state')
        .withIndex('by_post', (q) => q.eq('postId', 'P1'))
        .first(),
    )
    expect(byIndex).toMatchObject({
      postId: 'P1',
      platform: 'instagram',
      requestId: 'req-1',
    })
  })

  it('rejects a queued event without media', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(api.sync.recordEvents, {
        events: [evt({ media: undefined })],
        secret: SECRET,
      }),
    ).rejects.toThrow('Invalid sync event payload')
  })

  it('rejects a terminal event with media', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(api.sync.recordEvents, {
        events: [evt({ eventId: 'dev-1/req-1/completed', kind: 'completed' })],
        secret: SECRET,
      }),
    ).rejects.toThrow('Invalid sync event payload')
  })

  it('preserves the top-level tweetId across an outcome event carrying no media', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(api.sync.recordEvents, {
      events: [
        evt({
          eventId: 'dev-1/req-1/queued',
          kind: 'queued',
          at: 1_000,
          media: media({ tweetId: 'T1' }),
        }),
        evt({
          eventId: 'dev-1/req-1/completed',
          kind: 'completed',
          at: 2_000,
          media: undefined,
        }),
      ],
      secret: SECRET,
    })
    const state = await t.run((ctx) =>
      ctx.db
        .query('media_state')
        .withIndex('by_device_request', (q) => q.eq('deviceId', 'dev-1').eq('requestId', 'req-1'))
        .first(),
    )
    expect(state).toMatchObject({
      tweetId: 'T1',
      lastKind: 'completed',
      at: 2_000,
    })
  })

  it('does NOT regress media_state on an out-of-order (older `at`) event', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(api.sync.recordEvents, {
      events: [
        evt({
          eventId: 'dev-1/req-1/completed',
          kind: 'completed',
          at: 5_000,
          media: undefined,
        }),
      ],
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
      t.mutation(api.sync.recordEvents, {
        events: [evt()],
        secret: 'anything',
      }),
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

describe('sync:recordEvents fails closed', () => {
  it('rejects a bad secret', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(api.sync.recordEvents, { events: [evt()], secret: 'wrong' }),
    ).rejects.toThrow('bad or missing sync secret')
  })

  it('rejects when no secret is configured', async () => {
    vi.stubEnv('SYNC_SHARED_SECRET', '')
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(api.sync.recordEvents, {
        events: [evt()],
        secret: 'anything',
      }),
    ).rejects.toThrow('no SYNC_SHARED_SECRET configured')
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

describe('sync:downloadedAmong', () => {
  // Seed media_state rows for three tweets: T1 completed, T2 queued, T3 failed.
  const seedStates = async (t: ReturnType<typeof convexTest>) => {
    await t.mutation(api.sync.recordEvents, {
      events: [
        evt({
          eventId: 'dev-1/t1/queued',
          requestId: 't1',
          media: media({ tweetId: 'T1' }),
          at: 1_000,
        }),
        evt({
          eventId: 'dev-1/t1/completed',
          kind: 'completed',
          requestId: 't1',
          at: 2_000,
          media: undefined,
        }),
        evt({
          eventId: 'dev-1/t2/queued',
          requestId: 't2',
          media: media({ tweetId: 'T2' }),
          at: 1_000,
        }),
        evt({
          eventId: 'dev-1/t3/queued',
          requestId: 't3',
          media: media({ tweetId: 'T3' }),
          at: 1_000,
        }),
        evt({
          eventId: 'dev-1/t3/failed',
          kind: 'failed',
          requestId: 't3',
          at: 2_000,
          media: undefined,
        }),
      ],
      secret: SECRET,
    })
  }

  it('returns only the tweetIds with a completed row', async () => {
    const t = convexTest(schema, modules)
    await seedStates(t)
    const out = await t.query(api.sync.downloadedAmong, {
      secret: SECRET,
      tweetIds: ['T1', 'T2', 'T3', 'T4'],
    })
    expect(out).toEqual(['T1'])
  })

  it('matches a completed row regardless of which device saved it (cross-device)', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(api.sync.recordEvents, {
      events: [
        evt({
          eventId: 'dev-A/t5/queued',
          requestId: 't5',
          deviceId: 'dev-A',
          media: media({ tweetId: 'T5' }),
          at: 1_000,
        }),
        evt({
          eventId: 'dev-A/t5/completed',
          kind: 'completed',
          requestId: 't5',
          deviceId: 'dev-A',
          at: 2_000,
          media: undefined,
        }),
      ],
      secret: SECRET,
    })
    const out = await t.query(api.sync.downloadedAmong, {
      secret: SECRET,
      tweetIds: ['T5'],
    })
    expect(out).toEqual(['T5'])
  })

  it('uses the current X platform/post index, not an Instagram postId collision', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(api.sync.recordEvents, {
      events: [
        evt({
          eventId: 'dev-1/x-shared/queued',
          requestId: 'x-shared',
          media: {
            platform: 'x',
            postId: 'shared',
            author: 'alice',
            type: 'photo',
            url: 'https://pbs.twimg.com/media/shared',
            ext: 'jpg',
            index: 0,
          },
        }),
        evt({
          eventId: 'dev-1/x-shared/completed',
          kind: 'completed',
          requestId: 'x-shared',
          at: 2_000,
          media: undefined,
        }),
        evt({
          eventId: 'dev-1/instagram-shared/queued',
          requestId: 'instagram-shared',
          media: {
            platform: 'instagram',
            postId: 'shared',
            author: 'alice',
            type: 'photo',
            url: 'https://cdninstagram.com/media/shared',
            ext: 'jpg',
            index: 0,
          },
        }),
        evt({
          eventId: 'dev-1/instagram-shared/completed',
          kind: 'completed',
          requestId: 'instagram-shared',
          at: 2_000,
          media: undefined,
        }),
      ],
      secret: SECRET,
    })

    expect(
      await t.query(api.sync.downloadedAmong, {
        secret: SECRET,
        tweetIds: ['shared'],
      }),
    ).toEqual(['shared'])
  })

  it('never treats an explicit non-X row as a saved X post', async () => {
    const t = convexTest(schema, modules)
    await t.run((ctx) =>
      ctx.db.insert('media_state', {
        requestId: 'instagram-only',
        deviceId: 'dev-1',
        tweetId: 'instagram-only',
        postId: 'instagram-only',
        platform: 'instagram',
        author: 'alice',
        lastKind: 'completed',
        at: 1_000,
      }),
    )

    expect(
      await t.query(api.sync.downloadedAmong, {
        secret: SECRET,
        tweetIds: ['instagram-only'],
      }),
    ).toEqual([])
  })

  it('keeps unbackfilled legacy X rows visible during the platform migration', async () => {
    const t = convexTest(schema, modules)
    await t.run((ctx) =>
      ctx.db.insert('media_state', {
        requestId: 'legacy-x',
        deviceId: 'dev-1',
        tweetId: 'legacy-x',
        lastKind: 'completed',
        at: 1_000,
      }),
    )

    expect(
      await t.query(api.sync.downloadedAmong, {
        secret: SECRET,
        tweetIds: ['legacy-x'],
      }),
    ).toEqual(['legacy-x'])
  })

  it('rejects an unauthenticated read (bad/missing secret)', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.query(api.sync.downloadedAmong, { secret: 'WRONG', tweetIds: ['T1'] }),
    ).rejects.toThrow(/bad or missing sync secret/)
  })

  it('rejects an oversized batch', async () => {
    const t = convexTest(schema, modules)
    const tweetIds = Array.from({ length: 129 }, (_, i) => `t${i}`)
    await expect(t.query(api.sync.downloadedAmong, { secret: SECRET, tweetIds })).rejects.toThrow(
      /batch too large/,
    )
  })

  it.each([
    ['empty', ''],
    ['oversized', 't'.repeat(MAX_POST_ID_LENGTH + 1)],
  ])('rejects an %s post identity', async (_label, tweetId) => {
    const t = convexTest(schema, modules)
    await expect(
      t.query(api.sync.downloadedAmong, {
        secret: SECRET,
        tweetIds: [tweetId],
      }),
    ).rejects.toThrow('downloadedAmong: invalid identity')
  })

  it('accepts the exact post identity width limit', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.query(api.sync.downloadedAmong, {
        secret: SECRET,
        tweetIds: ['t'.repeat(MAX_POST_ID_LENGTH)],
      }),
    ).resolves.toEqual([])
  })
})

describe('sync:downloadedRequestIdsAmong', () => {
  // Seed media_state rows for three requests (media ids): m1 completed, m2
  // queued, m3 failed — parallel to the downloadedAmong fixture, but the
  // lookup key is the canonical Save Request ID, not raw MediaItem ID or tweetId.
  const seedStates = async (t: ReturnType<typeof convexTest>) => {
    await t.mutation(api.sync.recordEvents, {
      events: [
        evt({
          eventId: 'dev-1/m1/queued',
          requestId: 'm1',
          media: media({ tweetId: 'T1' }),
          at: 1_000,
        }),
        evt({
          eventId: 'dev-1/m1/completed',
          kind: 'completed',
          requestId: 'm1',
          at: 2_000,
          media: undefined,
        }),
        evt({
          eventId: 'dev-1/m2/queued',
          requestId: 'm2',
          media: media({ tweetId: 'T1' }),
          at: 1_000,
        }),
        evt({
          eventId: 'dev-1/m3/queued',
          requestId: 'm3',
          media: media({ tweetId: 'T2' }),
          at: 1_000,
        }),
        evt({
          eventId: 'dev-1/m3/failed',
          kind: 'failed',
          requestId: 'm3',
          at: 2_000,
          media: undefined,
        }),
      ],
      secret: SECRET,
    })
  }

  it('returns only the requestIds with a completed row', async () => {
    const t = convexTest(schema, modules)
    await seedStates(t)
    const out = await t.query(api.sync.downloadedRequestIdsAmong, {
      secret: SECRET,
      requestIds: ['m1', 'm2', 'm3', 'm4'],
    })
    expect(out).toEqual(['m1'])
  })

  it('matches a completed row regardless of which device saved it (cross-device)', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(api.sync.recordEvents, {
      events: [
        evt({
          eventId: 'dev-A/m5/queued',
          requestId: 'm5',
          deviceId: 'dev-A',
          media: media({ tweetId: 'T5' }),
          at: 1_000,
        }),
        evt({
          eventId: 'dev-A/m5/completed',
          kind: 'completed',
          requestId: 'm5',
          deviceId: 'dev-A',
          at: 2_000,
          media: undefined,
        }),
      ],
      secret: SECRET,
    })
    const out = await t.query(api.sync.downloadedRequestIdsAmong, {
      secret: SECRET,
      requestIds: ['m5'],
    })
    expect(out).toEqual(['m5'])
  })

  it('looks up non-X items by canonical Save Request ID', async () => {
    const t = convexTest(schema, modules)
    const requestId = 'xmd:v1:media:instagram:6:shared'
    await t.mutation(api.sync.recordEvents, {
      events: [
        evt({
          eventId: currentEventId('dev-1', requestId, 'queued'),
          requestId,
          media: {
            platform: 'instagram',
            postId: 'post-1',
            author: 'alice',
            type: 'photo',
            url: 'https://cdninstagram.com/media/shared',
            ext: 'jpg',
            index: 0,
          },
        }),
        evt({
          eventId: currentEventId('dev-1', requestId, 'completed'),
          kind: 'completed',
          requestId,
          at: 2_000,
          media: undefined,
        }),
      ],
      secret: SECRET,
    })

    const out = await t.query(api.sync.downloadedRequestIdsAmong, {
      secret: SECRET,
      requestIds: ['shared', requestId],
    })
    expect(out).toEqual([requestId])
  })

  it('rejects an unauthenticated read (bad/missing secret)', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.query(api.sync.downloadedRequestIdsAmong, {
        secret: 'WRONG',
        requestIds: ['m1'],
      }),
    ).rejects.toThrow(/bad or missing sync secret/)
  })

  it('rejects an oversized batch', async () => {
    const t = convexTest(schema, modules)
    const requestIds = Array.from({ length: 129 }, (_, i) => `m${i}`)
    await expect(
      t.query(api.sync.downloadedRequestIdsAmong, {
        secret: SECRET,
        requestIds,
      }),
    ).rejects.toThrow(/batch too large/)
  })

  it.each([
    ['empty', ''],
    ['oversized', 'm'.repeat(MAX_REQUEST_ID_LENGTH + 1)],
  ])('rejects an %s request identity', async (_label, requestId) => {
    const t = convexTest(schema, modules)
    await expect(
      t.query(api.sync.downloadedRequestIdsAmong, {
        secret: SECRET,
        requestIds: [requestId],
      }),
    ).rejects.toThrow('downloadedRequestIdsAmong: invalid identity')
  })

  it('accepts the exact request identity width limit', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.query(api.sync.downloadedRequestIdsAmong, {
        secret: SECRET,
        requestIds: ['m'.repeat(MAX_REQUEST_ID_LENGTH)],
      }),
    ).resolves.toEqual([])
  })
})

describe('sync:backfillTweetId', () => {
  it('fills a missing top-level tweetId from the nested media', async () => {
    const t = convexTest(schema, modules)
    // A legacy row written before the tweetId column existed: empty tweetId,
    // but the provenance media still carries it.
    await t.run(async (ctx) => {
      await ctx.db.insert('media_state', {
        requestId: 'r-old',
        deviceId: 'dev-1',
        lastKind: 'completed',
        at: 1_000,
        tweetId: '',
        media: media({ tweetId: 'T6' }),
      })
    })
    const res = await t.mutation(api.sync.backfillTweetId, { secret: SECRET })
    expect(res).toMatchObject({ patched: 1, isDone: true })

    const row = await t.run((ctx) =>
      ctx.db
        .query('media_state')
        .withIndex('by_tweet', (q) => q.eq('tweetId', 'T6'))
        .first(),
    )
    expect(row).toMatchObject({ tweetId: 'T6', requestId: 'r-old' })
  })

  it('fills a pre-column row whose top-level tweetId is absent', async () => {
    const t = convexTest(schema, modules)
    await t.run((ctx) =>
      ctx.db.insert('media_state', {
        requestId: 'r-pre-column',
        deviceId: 'dev-1',
        lastKind: 'completed',
        at: 1_000,
        media: media({ tweetId: 'T-pre-column' }),
      }),
    )

    expect(await t.mutation(api.sync.backfillTweetId, { secret: SECRET })).toMatchObject({
      patched: 1,
      isDone: true,
    })
    const row = await t.run((ctx) =>
      ctx.db
        .query('media_state')
        .withIndex('by_tweet', (q) => q.eq('tweetId', 'T-pre-column'))
        .first(),
    )
    expect(row).toMatchObject({ requestId: 'r-pre-column', tweetId: 'T-pre-column' })
  })

  it('rejects an unauthenticated caller', async () => {
    const t = convexTest(schema, modules)
    await expect(t.mutation(api.sync.backfillTweetId, { secret: 'WRONG' })).rejects.toThrow(
      /bad or missing sync secret/,
    )
  })

  it('pages over more than 1,000 rows and remains resumable and idempotent', async () => {
    const t = convexTest(schema, modules)
    const total = 1_001
    // oxlint-disable no-await-in-loop -- this seeds one bounded-migration corpus
    await t.run(async (ctx) => {
      for (let i = 0; i < total; i += 1) {
        await ctx.db.insert('media_state', {
          requestId: `r-${i}`,
          deviceId: 'dev-1',
          lastKind: 'completed',
          at: i,
          tweetId: '',
          media: media({ tweetId: `T-${i}` }),
        })
      }
    })
    // oxlint-enable no-await-in-loop

    let cursor: string | null = null
    let patched = 0
    let pages = 0
    let isDone = false
    // oxlint-disable no-await-in-loop -- each request consumes the prior page cursor
    while (!isDone) {
      const result: { patched: number; isDone: boolean; continueCursor: string } =
        await t.mutation(api.sync.backfillTweetId, { cursor, secret: SECRET })
      expect(result.patched).toBeLessThanOrEqual(128)
      patched += result.patched
      pages += 1
      cursor = result.continueCursor
      isDone = result.isDone
    }
    // oxlint-enable no-await-in-loop
    expect(patched).toBe(total)
    expect(pages).toBeGreaterThan(1)

    // A complete second traversal patches nothing, including after a restart.
    cursor = null
    isDone = false
    let repatched = 0
    // oxlint-disable no-await-in-loop -- each request consumes the prior page cursor
    while (!isDone) {
      const result: { patched: number; isDone: boolean; continueCursor: string } =
        await t.mutation(api.sync.backfillTweetId, { cursor, secret: SECRET })
      expect(result.patched).toBe(0)
      repatched += result.patched
      cursor = result.continueCursor
      isDone = result.isDone
    }
    // oxlint-enable no-await-in-loop
    expect(repatched).toBe(0)
  })
})

describe('sync:backfillPlatformFields', () => {
  it('fills postId/platform (and media.postId/author/platform) on a legacy row', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('media_state', {
        requestId: 'r-legacy',
        deviceId: 'dev-1',
        lastKind: 'completed',
        at: 1_000,
        tweetId: 'T7',
        media: media({ tweetId: 'T7', handle: 'bob' }),
      })
    })
    const res = await t.mutation(api.sync.backfillPlatformFields, {
      secret: SECRET,
    })
    expect(res).toMatchObject({
      patched: 1,
      mediaState: { isDone: true },
      syncEvents: { isDone: true },
    })

    const row = await t.run((ctx) =>
      ctx.db
        .query('media_state')
        .withIndex('by_post', (q) => q.eq('postId', 'T7'))
        .first(),
    )
    expect(row).toMatchObject({
      postId: 'T7',
      platform: 'x',
      author: 'bob',
      requestId: 'r-legacy',
      media: { postId: 'T7', author: 'bob', platform: 'x' },
    })
  })

  it('derives postId from the nested media when the row has no top-level tweetId either', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('media_state', {
        requestId: 'r-no-top-level',
        deviceId: 'dev-1',
        lastKind: 'completed',
        at: 1_000,
        // No top-level tweetId at all (pre-backfillTweetId row) — only the media carries it.
        media: media({ tweetId: 'T11' }),
      })
    })
    const res = await t.mutation(api.sync.backfillPlatformFields, {
      secret: SECRET,
    })
    expect(res).toMatchObject({ patched: 1 })
    const row = await t.run((ctx) =>
      ctx.db
        .query('media_state')
        .withIndex('by_post', (q) => q.eq('postId', 'T11'))
        .first(),
    )
    expect(row).toMatchObject({ postId: 'T11', platform: 'x' })
  })

  it('backfills legacy media embedded in sync_events', async () => {
    const t = convexTest(schema, modules)
    await t.run((ctx) =>
      ctx.db.insert('sync_events', {
        eventId: 'dev-1/r-event/queued',
        kind: 'queued',
        requestId: 'r-event',
        deviceId: 'dev-1',
        at: 1_000,
        media: media({ tweetId: 'T12', handle: 'dana' }),
      }),
    )

    expect(await t.mutation(api.sync.backfillPlatformFields, { secret: SECRET })).toMatchObject({
      patched: 1,
    })
    const row = await t.run((ctx) =>
      ctx.db
        .query('sync_events')
        .withIndex('by_event_id', (q) => q.eq('eventId', 'dev-1/r-event/queued'))
        .first(),
    )
    expect(row?.media).toMatchObject({
      postId: 'T12',
      author: 'dana',
      platform: 'x',
    })
  })

  it('defaults postId to empty string for a row with neither a top-level tweetId nor any media', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('media_state', {
        requestId: 'r-bare',
        deviceId: 'dev-1',
        lastKind: 'queued',
        at: 1_000,
      })
    })
    const res = await t.mutation(api.sync.backfillPlatformFields, {
      secret: SECRET,
    })
    expect(res).toMatchObject({ patched: 1 })
    const row = await t.run((ctx) =>
      ctx.db
        .query('media_state')
        .withIndex('by_device_request', (q) => q.eq('deviceId', 'dev-1').eq('requestId', 'r-bare'))
        .first(),
    )
    expect(row).toMatchObject({ postId: '', platform: 'x' })
  })

  it('is idempotent — a row that already has postId is left alone', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('media_state', {
        requestId: 'r-new',
        deviceId: 'dev-1',
        lastKind: 'completed',
        at: 1_000,
        postId: 'T8',
        platform: 'x',
        author: 'carol',
        media: {
          platform: 'x',
          postId: 'T8',
          author: 'carol',
          type: 'photo',
          url: 'u',
          ext: 'jpg',
          index: 0,
        },
      })
    })
    const res = await t.mutation(api.sync.backfillPlatformFields, {
      secret: SECRET,
    })
    expect(res).toMatchObject({ patched: 0 })
  })

  it('rejects an unauthenticated caller', async () => {
    const t = convexTest(schema, modules)
    await expect(t.mutation(api.sync.backfillPlatformFields, { secret: 'WRONG' })).rejects.toThrow(
      /bad or missing sync secret/,
    )
  })
})

describe('sync:platformBackfillRemaining', () => {
  it('counts legacy media_state and sync_events rows', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('media_state', {
        requestId: 'r-old',
        deviceId: 'dev-1',
        lastKind: 'completed',
        at: 1_000,
        tweetId: 'T9',
        media: media({ tweetId: 'T9' }),
      })
      await ctx.db.insert('media_state', {
        requestId: 'r-migrated',
        deviceId: 'dev-1',
        lastKind: 'completed',
        at: 1_000,
        postId: 'T10',
        platform: 'x',
        author: 'alice',
      })
      await ctx.db.insert('sync_events', {
        eventId: 'dev-1/req-event/queued',
        kind: 'queued',
        requestId: 'req-event',
        deviceId: 'dev-1',
        at: 1_000,
        media: media({ tweetId: 'T11', handle: 'alice' }),
      })
    })
    expect(await t.query(api.sync.platformBackfillRemaining, { secret: SECRET })).toMatchObject({
      pageRemaining: 2,
    })
  })

  it('rejects an unauthenticated caller', async () => {
    const t = convexTest(schema, modules)
    await expect(t.query(api.sync.platformBackfillRemaining, { secret: 'WRONG' })).rejects.toThrow(
      /bad or missing sync secret/,
    )
  })
})

describe('sync:platform backfill audit', () => {
  it('cannot call deploy-2 clean when an earlier page was dirty and the final page is clean', async () => {
    const t = convexTest(schema, modules)
    await t.run(async (ctx) => {
      await ctx.db.insert('media_state', {
        requestId: 'r-legacy-first',
        deviceId: 'dev-1',
        lastKind: 'completed',
        at: 0,
        tweetId: 'T-first',
        media: media({ tweetId: 'T-first', handle: 'alice' }),
      })
      for (let index = 0; index < 128; index += 1) {
        await ctx.db.insert('media_state', {
          requestId: `r-clean-${index}`,
          deviceId: 'dev-1',
          lastKind: 'completed',
          at: index,
          postId: `P${index}`,
          platform: 'x',
          author: 'alice',
        })
      }
    })

    const auditId = await t.mutation(api.sync.startPlatformBackfillAudit, {
      secret: SECRET,
    })
    const first = await t.mutation(api.sync.advancePlatformBackfillAudit, {
      secret: SECRET,
      auditId,
    })
    expect(first).toEqual({ done: false, complete: false, remaining: 1 })
    const second = await t.mutation(api.sync.advancePlatformBackfillAudit, {
      secret: SECRET,
      auditId,
    })
    expect(second).toEqual({ done: true, complete: false, remaining: 1 })
  })

  it('proves clean only after every server-owned page is clean', async () => {
    const t = convexTest(schema, modules)
    const auditId = await t.mutation(api.sync.startPlatformBackfillAudit, {
      secret: SECRET,
    })
    await expect(
      t.mutation(api.sync.advancePlatformBackfillAudit, {
        secret: SECRET,
        auditId,
      }),
    ).resolves.toEqual({ done: true, complete: true, remaining: 0 })
  })

  it('stays clean when an old client writes during an audit', async () => {
    const t = convexTest(schema, modules)
    const auditId = await t.mutation(api.sync.startPlatformBackfillAudit, {
      secret: SECRET,
    })
    await t.mutation(api.sync.recordEvents, {
      events: [evt()],
      secret: SECRET,
    })

    await expect(
      t.mutation(api.sync.advancePlatformBackfillAudit, {
        secret: SECRET,
        auditId,
      }),
    ).resolves.toEqual({ done: true, complete: true, remaining: 0 })
  })
})
