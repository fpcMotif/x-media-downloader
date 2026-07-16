import { describe, expect, it } from 'vitest'
import { Schema } from 'effect'
import { planClearSeed } from '../clear/seed'
import { Settings as SettingsSchema, type MediaItem, type Settings } from '../schema'
import { emptyMetrics, recordOutcome, recordSample } from './metrics'
import type { SaveRequest } from './strategy'
import { decideQueueStart } from './queue-start'

const STARTED_AT = 1_000
const baseSettings = Schema.decodeUnknownSync(SettingsSchema)({})
const settings = (over: Partial<Settings> = {}): Settings => ({ ...baseSettings, ...over })

const item = (id: string, postId = '100'): MediaItem => ({
  id,
  platform: 'x',
  postId,
  author: 'alice',
  type: 'photo',
  url: `https://pbs.twimg.com/media/${id}.jpg`,
  ext: 'jpg',
  index: 0,
})

const request = (id: string, filename = `${id}.jpg`): SaveRequest => ({
  id,
  url: `https://pbs.twimg.com/media/${id}.jpg`,
  filename,
})

const decide = (over: Partial<Parameters<typeof decideQueueStart>[0]> = {}) => {
  const media = item('m1')
  return decideQueueStart({
    metrics: null,
    requests: [request(media.id, 'alice/m1.jpg')],
    mediaById: new Map([[media.id, media]]),
    settings: settings({
      cloudDeviceId: 'device-1',
      downloadConcurrency: 3,
      clearOnSave: true,
      autoUnbookmarkOnSave: true,
    }),
    startedAt: STARTED_AT,
    ...over,
  })
}

describe('decideQueueStart — Metrics and correlation', () => {
  it('starts fresh Metrics and explicitly resets correlation', () => {
    const fx = decide()

    expect(fx.metrics).toMatchObject({
      total: 1,
      concurrencyCap: 3,
      startedAt: STARTED_AT,
      completed: 0,
      failed: 0,
    })
    expect(fx.resetCorrelation).toBe(true)
    expect(fx.persistSnapshot).toBe(true)
  })

  it('starts fresh after the prior Metrics batch becomes inactive', () => {
    const prior = recordOutcome(
      emptyMetrics({ total: 1, concurrencyCap: 2, startedAt: 100 }),
      'old',
      'complete',
      200,
    )
    const fx = decide({ metrics: prior })

    expect(fx.metrics.startedAt).toBe(STARTED_AT)
    expect(fx.metrics.total).toBe(1)
    expect(fx.resetCorrelation).toBe(true)
  })

  it('extends active Metrics without resetting correlation', () => {
    const prior = recordSample(emptyMetrics({ total: 2, concurrencyCap: 2, startedAt: 100 }), {
      id: 'old',
      bytesReceived: 5,
      totalBytes: 10,
      t: 200,
    })
    const fx = decide({
      metrics: prior,
      requests: [request('m1'), request('m2')],
      settings: settings({ cloudDeviceId: 'device-1', downloadConcurrency: 5 }),
    })

    expect(fx.metrics.total).toBe(4)
    expect(fx.metrics.concurrencyCap).toBe(5)
    expect(fx.metrics.startedAt).toBe(100)
    expect(fx.resetCorrelation).toBe(false)
  })
})

describe('decideQueueStart — mirror effects', () => {
  it('projects media once and omits sidecars from Sync, History, upload, and Clear items', () => {
    const media = item('m1')
    const fx = decide({
      requests: [request('m1', 'alice/m1.jpg'), request('m1.json', 'alice/m1.json')],
      mediaById: new Map([[media.id, media]]),
    })

    expect(fx.syncEvents).toHaveLength(1)
    expect(fx.syncEvents[0]).toMatchObject({
      kind: 'queued',
      requestId: 'm1',
      deviceId: 'device-1',
      at: STARTED_AT,
    })
    expect(fx.historyActions).toEqual([
      { kind: 'queued', item: media, filename: 'alice/m1.jpg', at: STARTED_AT },
    ])
    expect(fx.uploadItems).toEqual([{ item: media, filename: 'alice/m1.jpg' }])
    expect(fx.clearSeed).toMatchObject({ decision: 'seed' })
    const byTweet = fx.clearSeed.decision === 'seed' ? fx.clearSeed.byTweet : new Map()
    expect(byTweet.get('100')).toEqual(['m1'])
  })

  it('uses one startedAt for Metrics, Sync, and History start records', () => {
    const fx = decide()

    expect(fx.metrics.startedAt).toBe(STARTED_AT)
    expect(fx.syncEvents[0]?.at).toBe(STARTED_AT)
    expect(fx.historyActions[0]?.at).toBe(STARTED_AT)
  })

  it('keeps queue-start effects for aria2 but returns the Clear aria2 skip', () => {
    const fx = decide({
      settings: settings({ cloudDeviceId: 'device-1', downloadStrategy: 'aria2' }),
    })

    expect(fx.syncEvents).toHaveLength(1)
    expect(fx.historyActions).toHaveLength(1)
    expect(fx.uploadItems).toHaveLength(1)
    expect(fx.clearSeed).toEqual({ decision: 'skip', reason: 'aria2' })
  })
})

describe('decideQueueStart — Clear planner ownership', () => {
  it.each([
    {
      name: 'clear off',
      settings: settings({ clearOnSave: false }),
    },
    {
      name: 'no hook scopes',
      settings: settings({
        clearOnSave: true,
        autoUnbookmarkOnSave: false,
        autoUnlikeOnSave: false,
        autoNotInterestedOnSave: false,
      }),
    },
    {
      name: 'sweep widening',
      settings: settings({
        clearOnSave: true,
        clearAllListsOnSave: true,
        autoUnbookmarkOnSave: true,
        autoUnlikeOnSave: true,
        autoNotInterestedOnSave: true,
      }),
      sweep: { scope: 'bookmark' as const },
    },
    {
      name: 'clearExpect widening',
      settings: settings({ clearOnSave: true, autoUnbookmarkOnSave: true }),
      clearExpect: [{ tweetId: '100', ids: ['m1', 'm2'] }],
    },
  ])('preserves planClearSeed: $name', ({ settings: cfg, sweep, clearExpect }) => {
    const media = item('m1')
    const input = {
      requests: [request('m1'), request('m1.json')],
      mediaById: new Map([[media.id, media]]),
      settings: cfg,
      ...(sweep ? { sweep } : {}),
      ...(clearExpect ? { clearExpect } : {}),
    }

    expect(
      decide({
        ...input,
        startedAt: STARTED_AT,
        metrics: null,
      }).clearSeed,
    ).toEqual(planClearSeed(input))
  })
})
