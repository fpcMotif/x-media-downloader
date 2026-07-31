import { describe, it, expect } from 'vitest'
import type { MediaItem } from '@/packages/schema'
import {
  sidecarFilename,
  buildSidecar,
  sidecarDataUrl,
  planDownloads,
  partitionUsableIds,
  SIDECAR_ID_SUFFIX,
} from '../destination'

const item: MediaItem = {
  id: 'm1',
  platform: 'x',
  postId: '123',
  author: 'alice',
  type: 'photo',
  url: 'https://pbs.twimg.com/media/AAA.jpg?name=orig',
  ext: 'jpg',
  index: 0,
}

describe('sidecarFilename', () => {
  it('swaps the last extension for .json', () => {
    expect(sidecarFilename('alice/123_0.jpg')).toBe('alice/123_0.json')
  })

  it('appends .json when there is no extension', () => {
    expect(sidecarFilename('noext')).toBe('noext.json')
  })
})

describe('buildSidecar', () => {
  it('includes tweetUrl when ctx provides it', () => {
    const meta = buildSidecar(item, { tweetUrl: 'https://x.com/alice/status/123' })
    expect(meta.tweetUrl).toBe('https://x.com/alice/status/123')
    expect(meta).toMatchObject({ handle: 'alice', tweetId: '123', type: 'photo', index: 0 })
  })

  it('omits tweetUrl without ctx', () => {
    const meta = buildSidecar(item)
    expect('tweetUrl' in meta).toBe(false)
  })

  it('includes capturedAt when ctx provides it', () => {
    const meta = buildSidecar(item, { capturedAt: '2026-06-20T00:00:00Z' })
    expect(meta.capturedAt).toBe('2026-06-20T00:00:00Z')
    expect('tweetUrl' in meta).toBe(false)
  })

  it('omits capturedAt when ctx is present but capturedAt is undefined', () => {
    const meta = buildSidecar(item, { tweetUrl: 'https://x.com/alice/status/123' })
    expect('capturedAt' in meta).toBe(false)
  })
})

describe('planDownloads', () => {
  it('emits only the media download when sidecar is off', () => {
    const plan = planDownloads({
      template: '{handle}/{tweetId}_{index}.{ext}',
      item,
      sidecar: false,
    })
    expect(plan).toHaveLength(1)
    expect(plan[0]).toMatchObject({ id: 'm1', url: item.url, filename: 'alice/123_0.jpg' })
  })

  it('appends a json sidecar sibling when sidecar is on', () => {
    const plan = planDownloads({
      template: '{handle}/{tweetId}_{index}.{ext}',
      item,
      sidecar: true,
    })
    expect(plan).toHaveLength(2)
    const sidecar = plan[1]!
    expect(sidecar.id).toBe('m1.json')
    expect(sidecar.filename).toBe('alice/123_0.json')
    expect(sidecar.url.startsWith('data:application/json')).toBe(true)

    const payload = sidecar.url.slice(sidecar.url.indexOf(',') + 1)
    const decoded = JSON.parse(decodeURIComponent(payload))
    expect(decoded).toMatchObject({ handle: 'alice', tweetId: '123', type: 'photo', index: 0 })
    expect(decoded.url).toBe(item.url)
  })

  it('renders the date token in the media filename', () => {
    const plan = planDownloads({
      template: '{date}/{tweetId}_{index}.{ext}',
      item,
      sidecar: false,
      date: '2026-06-08',
    })
    expect(plan[0]!.filename).toBe('2026-06-08/123_0.jpg')
  })
})

describe('sidecarDataUrl', () => {
  it('round-trips through decodeURIComponent + JSON.parse', () => {
    const meta = { handle: 'alice', tweetId: '123' }
    const url = sidecarDataUrl(meta)
    expect(url.startsWith('data:application/json;charset=utf-8,')).toBe(true)
    const payload = url.slice(url.indexOf(',') + 1)
    expect(JSON.parse(decodeURIComponent(payload))).toEqual(meta)
  })
})

describe('partitionUsableIds', () => {
  const withId = (id: string): MediaItem => ({ ...item, id })

  it('passes a batch of distinct, non-reserved ids through untouched', () => {
    const items = [withId('m1'), withId('m2')]
    expect(partitionUsableIds(items)).toEqual({ allowed: items, rejected: [] })
  })

  it("rejects an id that would collide with another item's generated sidecar", () => {
    // `planDownloads` mints item `Y`'s sidecar as `Y.json`. A page-supplied item
    // literally called `Y.json` keys onto that same request id, and whichever
    // download settles first resolves the other's entry.
    const sidecarId = `m1${SIDECAR_ID_SUFFIX}`
    expect(planDownloads({ template: '{id}', item, sidecar: true })[1]?.id).toBe(sidecarId)

    const { allowed, rejected } = partitionUsableIds([withId('m1'), withId(sidecarId)])
    expect(allowed.map((i) => i.id)).toEqual(['m1'])
    expect(rejected).toEqual([{ itemId: sidecarId, reason: 'reserved sidecar id' }])
  })

  it('rejects a repeat of an id inside one batch, keeping the first', () => {
    const { allowed, rejected } = partitionUsableIds([withId('m1'), withId('m1'), withId('m2')])
    expect(allowed.map((i) => i.id)).toEqual(['m1', 'm2'])
    expect(rejected).toEqual([{ itemId: 'm1', reason: 'duplicate id in batch' }])
  })

  it('partitions rather than failing the whole batch, so good slides still save', () => {
    const { allowed, rejected } = partitionUsableIds([
      withId('good1'),
      withId(`x${SIDECAR_ID_SUFFIX}`),
      withId('good2'),
      withId('good1'),
    ])
    expect(allowed.map((i) => i.id)).toEqual(['good1', 'good2'])
    expect(rejected.map((r) => r.reason)).toEqual(['reserved sidecar id', 'duplicate id in batch'])
  })

  it('reports a repeated reserved id under the reserved reason both times', () => {
    // The reserved check runs first, so such an id never reaches `seen` — it can
    // never be reported as a duplicate, which would understate why it was refused.
    const id = `dupe${SIDECAR_ID_SUFFIX}`
    expect(partitionUsableIds([withId(id), withId(id)]).rejected).toEqual([
      { itemId: id, reason: 'reserved sidecar id' },
      { itemId: id, reason: 'reserved sidecar id' },
    ])
  })

  it('is a no-op on an empty batch', () => {
    expect(partitionUsableIds([])).toEqual({ allowed: [], rejected: [] })
  })
})
