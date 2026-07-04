import { describe, it, expect } from 'vitest'
import type { MediaItem } from '../schema'
import { recordFromMediaItem, applyOutcome } from './record'
import { emptyStore, decodeStore, upsert, applyTransition } from './store'

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

  it('ring-evicts the oldest beyond the cap', () => {
    let s = upsert(emptyStore, rec('1-0', 100), 2)
    s = upsert(s, rec('2-0', 200), 2)
    s = upsert(s, rec('3-0', 300), 2)
    expect(s.records.map((r) => r.requestId)).toEqual(['3-0', '2-0'])
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

describe('decodeStore', () => {
  it('round-trips a valid store', () => {
    const s = upsert(emptyStore, rec('1-0', 100))
    expect(decodeStore(s)).toEqual(s)
  })

  it('recovers to an empty store on corrupt input', () => {
    expect(decodeStore('garbage')).toEqual(emptyStore)
    expect(decodeStore({ records: [{ nope: true }] })).toEqual(emptyStore)
    expect(decodeStore(null)).toEqual(emptyStore)
  })
})
