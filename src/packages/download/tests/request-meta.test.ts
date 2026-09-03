import { describe, it, expect } from 'vitest'
import {
  decodeRequestMetaStore,
  emptyRequestMetaStore,
  planMetaReconcile,
  type PersistedRequestMeta,
  type RequestMetaStore,
} from '../request-meta'
import type { MediaItem } from '@/packages/schema'

const meta = (extra: Partial<PersistedRequestMeta> = {}): PersistedRequestMeta => ({
  url: 'https://cdn.example/a.mp4',
  filename: 'a.mp4',
  ...extra,
})

const item: MediaItem = {
  id: 'a',
  platform: 'x',
  postId: 'post1',
  author: 'handle',
  type: 'video',
  url: 'https://cdn.example/a.mp4',
  ext: 'mp4',
  index: 0,
}

describe('decodeRequestMetaStore', () => {
  it('round-trips a store including an entry with an optional item', () => {
    const store: RequestMetaStore = { a: meta(), b: meta({ item }) }
    // `decodeRequestMetaStore` reads persisted JSON, so hand it what storage
    // actually gives back — a plain-JSON clone — rather than the live typed
    // value (which may carry optional fields JsonValue can't express).
    expect(decodeRequestMetaStore(JSON.parse(JSON.stringify(store)))).toEqual(store)
  })

  it('decodes an entry with no item (optional field genuinely absent)', () => {
    const store: RequestMetaStore = { a: meta() }
    const decoded = decodeRequestMetaStore(JSON.parse(JSON.stringify(store)))
    expect(decoded.a?.item).toBeUndefined()
  })

  it('falls back to empty on a malformed persisted record, never throws', () => {
    expect(decodeRequestMetaStore({ a: { url: 'only-a-url' } })).toEqual({})
    expect(decodeRequestMetaStore('not-an-object')).toEqual({})
    expect(decodeRequestMetaStore(null)).toEqual({})
    expect(decodeRequestMetaStore(undefined)).toEqual({})
  })

  it('exposes the empty store constant used as the storage fallback', () => {
    expect(emptyRequestMetaStore).toEqual({})
  })
})

describe('planMetaReconcile', () => {
  it('restores persisted entries whose id is re-seeded and not retry-owned', () => {
    const plan = planMetaReconcile({
      reSeedIds: ['a', 'b'],
      retryOwnedIds: new Set(),
      persisted: { a: meta(), b: meta({ item }) },
    })
    expect(Object.fromEntries(plan.restore)).toEqual({ a: meta(), b: meta({ item }) })
    expect(plan.restore).toHaveLength(2)
    expect(plan.prune).toEqual([])
  })

  it('prunes orphans: persisted entries belonging to no live owner (neither re-seeded nor retry-owned)', () => {
    const plan = planMetaReconcile({
      reSeedIds: ['a'],
      retryOwnedIds: new Set(),
      persisted: { a: meta(), orphan: meta() },
    })
    expect(Object.fromEntries(plan.restore)).toEqual({ a: meta() })
    expect(new Set(plan.prune)).toEqual(new Set(['orphan']))
  })

  it('retry-owned ids are owned by session:interruptRetries, so the sibling record excludes them from restore AND prunes them — even when also re-seeded', () => {
    const plan = planMetaReconcile({
      reSeedIds: ['a'],
      retryOwnedIds: new Set(['a']),
      persisted: { a: meta() },
    })
    expect(plan.restore).toEqual([])
    expect(plan.prune).toEqual(['a'])
  })

  it('empty reSeedIds (idle boot) restores nothing and prunes every entry — orphans as unowned, retry-owned per their session:interruptRetries ownership', () => {
    const plan = planMetaReconcile({
      reSeedIds: [],
      retryOwnedIds: new Set(['retrying']),
      persisted: { orphan: meta(), retrying: meta({ item }) },
    })
    expect(plan.restore).toEqual([])
    expect(new Set(plan.prune)).toEqual(new Set(['orphan', 'retrying']))
    expect(plan.prune).toHaveLength(2)
  })

  it('returns empty restore/prune for an empty persisted record', () => {
    const plan = planMetaReconcile({
      reSeedIds: ['a'],
      retryOwnedIds: new Set(),
      persisted: emptyRequestMetaStore,
    })
    expect(plan.restore).toEqual([])
    expect(plan.prune).toEqual([])
  })
})
