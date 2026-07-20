import { describe, expect, it } from 'vitest'
import { Schema } from 'effect'
import { applyQueueStartEffects } from './queue-start-applier'
import { decideQueueStart } from '../core/download/queue-start'
import { Settings, type MediaItem } from '../core/schema'

const settings = Schema.decodeUnknownSync(Settings)({
  clearOnSave: true,
  autoUnbookmarkOnSave: true,
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

describe('applyQueueStartEffects', () => {
  it('applies queued records and Clear seed before save starts', async () => {
    const effects = decideQueueStart({
      metrics: null,
      requests: [{ id: 'm1', url: item.url, filename: 'm1.jpg' }],
      mediaById: new Map([[item.id, item]]),
      settings,
      startedAt: 100,
    })
    const order: string[] = []

    await applyQueueStartEffects(effects, 100, {
      resetCorrelation: () => void order.push('correlation'),
      setMetrics: () => void order.push('metrics'),
      persistSnapshot: async () => void order.push('snapshot'),
      recordSync: () => void order.push('sync'),
      recordHistory: () => void order.push('history'),
      recordUploads: () => void order.push('uploads'),
      seedClear: async () => void order.push('clear'),
    })
    order.push('save')

    expect(order).toEqual([
      'correlation',
      'metrics',
      'snapshot',
      'sync',
      'history',
      'uploads',
      'clear',
      'save',
    ])
  })
})
