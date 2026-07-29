import { describe, it, expect } from 'vitest'
import type { MediaItem } from '../schema'
import { recordFromMediaItem, applyOutcome } from './record'
import {
  DEFAULT_HISTORY_CAP,
  DOWNLOAD_STORE_VERSION,
  decodeHistoryResponse,
  decodeStoredHistory,
  emptyStore,
  isHistoryProjectionFenced,
  resetHistory,
  upsert,
  applyTransition,
} from './store'
import { MAX_DOWNLOAD_HISTORY_FILENAME_LENGTH } from './record'

const mk = (id: string, author = 'alice'): MediaItem => ({
  id,
  platform: 'x',
  postId: id.split('-')[0] ?? id,
  author,
  type: 'photo',
  url: `https://pbs.twimg.com/media/${id}?format=jpg&name=orig`,
  ext: 'jpg',
  index: 0,
})

const rec = (id: string, at: number) => recordFromMediaItem(mk(id), `${id}.jpg`, at)

describe('upsert', () => {
  it('prepends new records newest-first', () => {
    const s = upsert(upsert(emptyStore, rec('1-0', 100)), rec('2-0', 200))
    expect(s.records.map((r) => r.requestId)).toEqual(['2-0', '1-0'])
  })

  it('updates an existing requestId in place without duplicating', () => {
    let s = upsert(emptyStore, rec('1-0', 100))
    s = upsert(s, rec('2-0', 200))
    s = upsert(s, applyOutcome(rec('1-0', 100), 'completed', 300))
    expect(s.records.filter((r) => r.requestId === '1-0')).toHaveLength(1)
    expect(s.records.find((r) => r.requestId === '1-0')?.status).toBe('completed')
  })

  it('is monotonic — a queued upsert never regresses a terminal record', () => {
    let s = upsert(emptyStore, applyOutcome(rec('1-0', 100), 'completed', 300))
    s = upsert(s, rec('1-0', 400)) // a fresh queued record for the same request
    expect(s.records.find((r) => r.requestId === '1-0')?.status).toBe('completed')
  })

  it('makes a duplicate queued admission an exact no-op without changing order', () => {
    let s = upsert(emptyStore, rec('1-0', 100))
    s = upsert(s, rec('2-0', 200))
    const replayed = upsert(s, rec('1-0', 100))

    expect(replayed).toBe(s)
    expect(replayed.records.map((record) => record.requestId)).toEqual(['2-0', '1-0'])
  })

  it('cannot evict a newer row when an older admission arrives late', () => {
    let s = upsert(emptyStore, rec('1-0', 100), 2)
    s = upsert(s, rec('2-0', 200), 2)
    s = upsert(s, rec('old-0', 50), 2)

    expect(s.records.map((record) => record.requestId)).toEqual(['2-0', '1-0'])
  })

  it('ring-evicts the oldest beyond the cap', () => {
    let s = upsert(emptyStore, rec('1-0', 100), 2)
    s = upsert(s, rec('2-0', 200), 2)
    s = upsert(s, rec('3-0', 300), 2)
    expect(s.records.map((r) => r.requestId)).toEqual(['3-0', '2-0'])
  })

  it('does not let a caller widen the durable 500-record cap', () => {
    const records = Array.from({ length: DEFAULT_HISTORY_CAP }, (_, index) =>
      rec(`${index + 1}-0`, index),
    ).toReversed()
    const next = upsert(
      { version: DOWNLOAD_STORE_VERSION, resetFence: [], records },
      rec('501-0', 501),
      DEFAULT_HISTORY_CAP + 1,
    )

    expect(next.records).toHaveLength(DEFAULT_HISTORY_CAP)
    expect(next.records[0]?.requestId).toBe('501-0')
  })
})

describe('applyTransition', () => {
  it('moves a queued record to a terminal state with finishedAt and bytes', () => {
    const s = applyTransition(upsert(emptyStore, rec('1-0', 100)), '1-0', 'completed', 200, {
      received: 10,
      total: 10,
    })
    const r = s.records.find((x) => x.requestId === '1-0')
    expect(r?.status).toBe('completed')
    expect(r?.finishedAt).toBe(200)
    expect(r?.bytesReceived).toBe(10)
  })

  it('is a no-op for an unknown requestId', () => {
    const before = upsert(emptyStore, rec('1-0', 100))
    const after = applyTransition(before, '9-9', 'failed', 200)
    expect(after).toEqual(before)
  })

  it('is monotonic — a later contradictory outcome never regresses a terminal record', () => {
    // A cross-recycle reconcile could record `failed` after `completed` was already
    // mirrored; the first terminal must win (no completed→failed regression).
    const completed = applyTransition(upsert(emptyStore, rec('1-0', 100)), '1-0', 'completed', 200)
    const after = applyTransition(completed, '1-0', 'failed', 300)
    expect(after).toBe(completed) // same reference: nothing changed
    expect(after.records.find((x) => x.requestId === '1-0')?.status).toBe('completed')
  })
})

describe('decodeStoredHistory', () => {
  it('round-trips a valid store', () => {
    const s = upsert(emptyStore, rec('1-0', 100))
    expect(decodeStoredHistory(s)).toEqual({ kind: 'current', store: s })
  })

  it('distinguishes absent storage from corrupt persisted History', () => {
    expect(decodeStoredHistory(undefined)).toEqual({ kind: 'absent', store: emptyStore })
    expect(decodeStoredHistory(null)).toEqual({ kind: 'absent', store: emptyStore })
    expect(decodeStoredHistory('garbage')).toEqual({ kind: 'corrupt' })
  })

  it('migrates an unversioned raw Media Key into the current identity', () => {
    const current = recordFromMediaItem(
      { ...mk('shared'), platform: 'instagram' },
      'shared.jpg',
      100,
    )
    const { mediaKey: _mediaKey, ...legacy } = current
    const rawLegacy = { ...legacy, requestId: 'shared' }

    expect(decodeStoredHistory({ records: [rawLegacy] })).toEqual({
      kind: 'legacy',
      store: {
        version: DOWNLOAD_STORE_VERSION,
        resetFence: [],
        records: [
          {
            ...current,
            requestId: 'xmd:v1:media:instagram:6:shared',
            mediaKey: 'shared',
          },
        ],
      },
    })
  })

  it('migrates the exact pre-platform X media shape', () => {
    const current = rec('123-0', 100)
    const { mediaKey: _mediaKey, media, ...legacy } = current
    const rawLegacy = {
      ...legacy,
      requestId: current.mediaKey,
      media: {
        tweetId: media.postId,
        handle: media.author,
        type: media.type,
        url: media.url,
        ext: media.ext,
        index: media.index,
      },
    }

    expect(decodeStoredHistory({ records: [rawLegacy] })).toEqual({
      kind: 'legacy',
      store: {
        version: DOWNLOAD_STORE_VERSION,
        resetFence: [],
        records: [current],
      },
    })
  })

  it('treats a prefix-looking legacy X id as a raw Media Key', () => {
    const prefixKey = 'xmd:v1:media:instagram:6:shared'
    const current = rec(prefixKey, 100)
    const { mediaKey: _mediaKey, ...legacy } = current

    const decoded = decodeStoredHistory({
      records: [{ ...legacy, requestId: prefixKey }],
    })

    expect(decoded.kind).toBe('legacy')
    if (decoded.kind !== 'legacy') throw new Error('expected legacy History')
    expect(decoded.store.records[0]).toMatchObject({
      mediaKey: prefixKey,
      requestId: `xmd:v1:media:x:${prefixKey.length}:${prefixKey}`,
    })
  })

  it('rejects collisions after legacy identity normalization', () => {
    const current = recordFromMediaItem(
      { ...mk('shared'), platform: 'instagram' },
      'shared.jpg',
      100,
    )
    const { mediaKey: _mediaKey, ...legacy } = current
    const rawLegacy = { ...legacy, requestId: 'shared' }

    expect(decodeStoredHistory({ records: [rawLegacy, rawLegacy] })).toEqual({
      kind: 'corrupt',
    })
  })

  it('accepts exactly 500 records and rejects 501 before reading entries', () => {
    const records = Array.from({ length: DEFAULT_HISTORY_CAP }, (_, index) =>
      rec(`${index + 1}-0`, index),
    ).toReversed()
    expect(
      decodeStoredHistory({ version: DOWNLOAD_STORE_VERSION, resetFence: [], records }),
    ).toEqual({
      kind: 'current',
      store: { version: DOWNLOAD_STORE_VERSION, resetFence: [], records },
    })
    expect(decodeHistoryResponse({ records })).toEqual({ records })
    expect(decodeHistoryResponse({ version: DOWNLOAD_STORE_VERSION, records })).toBeUndefined()

    const oversize = [...records, rec('501-0', 501)]
    let reads = 0
    Object.defineProperty(oversize, '0', {
      enumerable: true,
      get: () => {
        reads += 1
        throw new Error('count cap must run first')
      },
    })
    expect(
      decodeStoredHistory({
        version: DOWNLOAD_STORE_VERSION,
        resetFence: [],
        records: oversize,
      }),
    ).toEqual({ kind: 'corrupt' })
    expect(decodeHistoryResponse({ records: oversize })).toBeUndefined()
    expect(reads).toBe(0)
  })

  it('rejects oversize fields and nested excess keys for storage and wire', () => {
    const oversized = {
      ...rec('1-0', 1),
      filename: 'f'.repeat(MAX_DOWNLOAD_HISTORY_FILENAME_LENGTH + 1),
    }
    const excess = { ...rec('1-0', 1), attacker: true }
    const base = rec('nested-0', 1)
    const nestedExcess = { ...base, media: { ...base.media, auth: 'secret' } }
    const duplicate = rec('duplicate-0', 1)
    for (const records of [[oversized], [excess], [nestedExcess], [duplicate, duplicate]]) {
      expect(
        decodeStoredHistory({ version: DOWNLOAD_STORE_VERSION, resetFence: [], records }),
      ).toEqual({ kind: 'corrupt' })
      expect(decodeHistoryResponse({ records })).toBeUndefined()
    }
  })

  it('rejects an accessor-backed records field without invoking it', () => {
    let reads = 0
    const storedPayload = { version: DOWNLOAD_STORE_VERSION, resetFence: [] }
    Object.defineProperty(storedPayload, 'records', {
      enumerable: true,
      get: () => {
        reads += 1
        throw new Error('must not run')
      },
    })
    const wirePayload = {}
    Object.defineProperty(wirePayload, 'records', {
      enumerable: true,
      get: () => {
        reads += 1
        throw new Error('must not run')
      },
    })

    expect(decodeStoredHistory(storedPayload)).toEqual({ kind: 'corrupt' })
    expect(decodeHistoryResponse(wirePayload)).toBeUndefined()
    expect(reads).toBe(0)
  })

  it('rejects an accessor-backed reset fence without invoking it', () => {
    let reads = 0
    const storedPayload = { version: DOWNLOAD_STORE_VERSION, records: [] }
    Object.defineProperty(storedPayload, 'resetFence', {
      enumerable: true,
      get: () => {
        reads += 1
        throw new Error('must not run')
      },
    })

    expect(decodeStoredHistory(storedPayload)).toEqual({ kind: 'corrupt' })
    expect(reads).toBe(0)
  })

  it('rejects a current row with mismatched canonical identity', () => {
    const record = recordFromMediaItem(
      { ...mk('shared'), platform: 'instagram' },
      'shared.jpg',
      100,
    )
    const mismatched = { ...record, requestId: record.mediaKey }

    expect(
      decodeStoredHistory({
        version: DOWNLOAD_STORE_VERSION,
        resetFence: [],
        records: [mismatched],
      }),
    ).toEqual({ kind: 'corrupt' })
    expect(decodeHistoryResponse({ records: [mismatched] })).toBeUndefined()
  })

  it('migrates the exact v2 envelope with an empty reset fence and canonical order', () => {
    const records = [rec('old-0', 100), rec('new-0', 200)]

    expect(decodeStoredHistory({ version: 2, records })).toEqual({
      kind: 'legacy',
      store: {
        version: DOWNLOAD_STORE_VERSION,
        resetFence: [],
        records: [records[1], records[0]],
      },
    })
  })

  it('rejects unordered v3 storage and wire responses', () => {
    const records = [rec('old-0', 100), rec('new-0', 200)]

    expect(
      decodeStoredHistory({ version: DOWNLOAD_STORE_VERSION, resetFence: [], records }),
    ).toEqual({ kind: 'corrupt' })
    expect(decodeHistoryResponse({ records })).toBeUndefined()
  })

  it('round-trips an exact bounded reset fence and rejects malformed fences', () => {
    const reset = resetHistory(['projection-2', 'projection-1', 'projection-1'])
    expect(reset.resetFence).toEqual(['projection-1', 'projection-2'])
    expect(isHistoryProjectionFenced(reset, 'projection-1')).toBe(true)
    expect(decodeStoredHistory(reset)).toEqual({ kind: 'current', store: reset })

    expect(
      decodeStoredHistory({
        version: DOWNLOAD_STORE_VERSION,
        resetFence: ['projection-1', 'projection-1'],
        records: [],
      }),
    ).toEqual({ kind: 'corrupt' })
    expect(
      decodeStoredHistory({
        version: DOWNLOAD_STORE_VERSION,
        resetFence: [''],
        records: [],
      }),
    ).toEqual({ kind: 'corrupt' })
    expect(
      decodeStoredHistory({
        version: DOWNLOAD_STORE_VERSION,
        resetFence: ['projection-2', 'projection-1'],
        records: [],
      }),
    ).toEqual({ kind: 'corrupt' })
  })
})
