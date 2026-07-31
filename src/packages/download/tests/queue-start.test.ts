import { describe, expect, it } from 'vitest'
import { Schema } from 'effect'
import { decideQueueStart } from '../queue-start'
import { planClearSeed } from '@/packages/clear/seed'
import { emptyMetrics, recordSample } from '../metrics'
import { Settings, type MediaItem } from '@/packages/schema'
import type { SaveRequest } from '../strategy'

const settings = Schema.decodeUnknownSync(Settings)({
  clearOnSave: true,
  autoUnbookmarkOnSave: true,
  cloudDeviceId: 'device-1',
  downloadConcurrency: 3,
})

const item: MediaItem = {
  id: 'm1',
  platform: 'x',
  postId: '100',
  author: 'alice',
  type: 'photo',
  url: 'https://cdn/m1',
  ext: 'jpg',
  index: 0,
}

const requests: SaveRequest[] = [
  { id: 'm1', url: item.url, filename: 'm1.jpg' },
  { id: 'm1.json', url: 'data:application/json,{}', filename: 'm1.json' },
]

describe('decideQueueStart', () => {
  it('starts fresh and derives every mirror effect only for real media', () => {
    const effects = decideQueueStart({
      metrics: null,
      requests,
      mediaById: new Map([[item.id, item]]),
      settings,
      startedAt: 1_000,
      originTabId: 9,
    })

    expect(effects.metrics.total).toBe(2)
    expect(effects.resetCorrelation).toBe(true)
    expect(effects.syncEvents.map((event) => event.requestId)).toEqual(['m1'])
    expect(effects.historyActions).toEqual([
      { kind: 'queued', item, filename: 'm1.jpg', at: 1_000 },
    ])
    expect(effects.uploadItems).toEqual([{ item, filename: 'm1.jpg' }])
    expect(effects.clearSeed).toMatchObject({
      decision: 'seed',
      origin: 'hook',
      originTabId: 9,
    })
    expect(effects.persistSnapshot).toBe(true)
  })

  it('extends active Metrics without resetting correlation', () => {
    const active = recordSample(emptyMetrics({ total: 1, concurrencyCap: 2, startedAt: 500 }), {
      id: 'old',
      bytesReceived: 1,
      totalBytes: 10,
      t: 900,
    })

    const effects = decideQueueStart({
      metrics: active,
      requests: [requests[0]!],
      mediaById: new Map([[item.id, item]]),
      settings,
      startedAt: 1_000,
    })

    expect(effects.metrics.total).toBe(2)
    expect(effects.metrics.startedAt).toBe(500)
    expect(effects.metrics.concurrencyCap).toBe(3)
    expect(effects.resetCorrelation).toBe(false)
  })

  it.each([
    {
      name: 'aria2 skip',
      settings: { ...settings, downloadStrategy: 'aria2' as const },
    },
    {
      name: 'sweep scope widening',
      settings: {
        ...settings,
        autoUnlikeOnSave: true,
        clearAllListsOnSave: true,
      },
      sweep: { scope: 'bookmark' as const },
    },
    {
      name: 'clearExpect widening',
      settings,
      clearExpect: [{ tweetId: '100', ids: ['m1', 'm2'] }],
    },
  ])('passes every Clear planner input through: $name', (input) => {
    const mediaById = new Map([[item.id, item]])
    const effects = decideQueueStart({
      metrics: null,
      requests,
      mediaById,
      settings: input.settings,
      startedAt: 1_000,
      ...(input.sweep ? { sweep: input.sweep } : {}),
      ...(input.clearExpect ? { clearExpect: input.clearExpect } : {}),
    })

    expect(effects.clearSeed).toEqual(
      planClearSeed({
        requests,
        mediaById,
        settings: input.settings,
        ...(input.sweep ? { sweep: input.sweep } : {}),
        ...(input.clearExpect ? { clearExpect: input.clearExpect } : {}),
      }),
    )
  })
})
