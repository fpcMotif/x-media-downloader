import { describe, it, expect } from 'vitest'
import { Schema } from 'effect'
import { Settings as SettingsSchema, type Settings, type MediaItem } from '../schema'
import { queuedEvent } from '../sync/events'
import { emptyStore } from './store'
import { planHistory, isMirrorableRequest } from './wiring'

const item: MediaItem = {
  id: '123-0',
  platform: 'x',
  postId: '123',
  author: 'alice',
  type: 'photo',
  url: 'https://pbs.twimg.com/media/abc?format=jpg&name=orig',
  ext: 'jpg',
  index: 0,
}

const mkSettings = (over: Partial<Settings>): Settings => ({
  ...Schema.decodeUnknownSync(SettingsSchema)({}),
  ...over,
})

describe('planHistory', () => {
  it('reconciles with the queued Sync Event — same media payload and requestId', () => {
    const s = planHistory(emptyStore, mkSettings({ downloadHistoryEnabled: true }), {
      kind: 'queued',
      item,
      filename: 'alice/123_0.jpg',
      at: 1000,
    })
    const record = s.records[0]!
    expect(record.media).toEqual(queuedEvent(item, 'dev1', 1000).media)
    expect(record.requestId).toBe(queuedEvent(item, 'dev1', 1000).requestId)
  })

  it('records a queued action when the toggle is on', () => {
    const s = planHistory(emptyStore, mkSettings({ downloadHistoryEnabled: true }), {
      kind: 'queued',
      item,
      filename: 'f.jpg',
      at: 1000,
    })
    expect(s.records).toHaveLength(1)
    expect(s.records[0]!.status).toBe('queued')
  })

  it('is a no-op when the toggle is off', () => {
    const off = mkSettings({ downloadHistoryEnabled: false })
    const s = planHistory(emptyStore, off, { kind: 'queued', item, filename: 'f.jpg', at: 1000 })
    expect(s).toBe(emptyStore)
  })

  it('skips a non-mirrorable queued action (sidecar .json id) even when on', () => {
    const on = mkSettings({ downloadHistoryEnabled: true })
    const sidecar = { ...item, id: '123-0.json' }
    const s = planHistory(emptyStore, on, {
      kind: 'queued',
      item: sidecar,
      filename: '123-0.json',
      at: 1000,
    })
    expect(s).toBe(emptyStore)
  })

  it('applies a terminal transition when on', () => {
    const on = mkSettings({ downloadHistoryEnabled: true })
    const queued = planHistory(emptyStore, on, {
      kind: 'queued',
      item,
      filename: 'f.jpg',
      at: 1000,
    })
    const done = planHistory(queued, on, {
      kind: 'completed',
      requestId: '123-0',
      at: 2000,
      bytes: { received: 5, total: 5 },
    })
    expect(done.records.find((r) => r.requestId === '123-0')?.status).toBe('completed')
  })

  it('depends only on downloadHistoryEnabled, orthogonal to cloudSyncEnabled', () => {
    const localOnly = mkSettings({ downloadHistoryEnabled: true, cloudSyncEnabled: false })
    const cloudOnly = mkSettings({ downloadHistoryEnabled: false, cloudSyncEnabled: true })
    expect(
      planHistory(emptyStore, localOnly, { kind: 'queued', item, filename: 'f.jpg', at: 1 })
        .records,
    ).toHaveLength(1)
    expect(
      planHistory(emptyStore, cloudOnly, { kind: 'queued', item, filename: 'f.jpg', at: 1 }),
    ).toBe(emptyStore)
  })
})

describe('isMirrorableRequest', () => {
  it('excludes sidecar .json requests and requests without a Media Item', () => {
    expect(isMirrorableRequest('123-0', true)).toBe(true)
    expect(isMirrorableRequest('123-0.json', true)).toBe(false)
    expect(isMirrorableRequest('123-0', false)).toBe(false)
  })
})
