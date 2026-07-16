import { describe, expect, it } from 'vitest'
import { Schema } from 'effect'
import { Settings as SettingsSchema, type MediaItem } from '../core/schema'
import { decideQueueStart } from '../core/download/queue-start'
import { applyQueueStartEffects, type QueueStartApplyPort } from './queue-start'

const media: MediaItem = {
  id: 'm1',
  platform: 'x',
  postId: '100',
  author: 'alice',
  type: 'photo',
  url: 'https://pbs.twimg.com/media/m1.jpg',
  ext: 'jpg',
  index: 0,
}

const effects = decideQueueStart({
  metrics: null,
  requests: [{ id: 'm1', url: media.url, filename: 'alice/m1.jpg' }],
  mediaById: new Map([[media.id, media]]),
  settings: {
    ...Schema.decodeUnknownSync(SettingsSchema)({}),
    clearOnSave: true,
    autoUnbookmarkOnSave: true,
  },
  startedAt: 1_000,
})

describe('applyQueueStartEffects', () => {
  it('applies every queued record and Clear seed before the caller starts saving', async () => {
    const order: string[] = []
    const port: QueueStartApplyPort = {
      resetCorrelation: () => order.push('correlation'),
      setMetrics: () => order.push('metrics'),
      persistSnapshot: async () => {
        order.push('snapshot')
      },
      recordSync: () => order.push('sync'),
      recordHistory: () => order.push('history'),
      recordCloudUploads: () => order.push('cloud'),
      applyClearSeed: () => order.push('clear'),
    }

    await applyQueueStartEffects(effects, port)
    order.push('save')

    expect(order).toEqual([
      'correlation',
      'metrics',
      'snapshot',
      'sync',
      'history',
      'cloud',
      'clear',
      'save',
    ])
  })

  it('does not reset correlation for an extended batch', async () => {
    const calls: string[] = []
    await applyQueueStartEffects(
      { ...effects, resetCorrelation: false },
      {
        resetCorrelation: () => calls.push('correlation'),
        setMetrics: () => {},
        persistSnapshot: async () => {},
        recordSync: () => {},
        recordHistory: () => {},
        recordCloudUploads: () => {},
        applyClearSeed: () => {},
      },
    )

    expect(calls).toEqual([])
  })
})
