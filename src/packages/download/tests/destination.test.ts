import { describe, it, expect } from 'vitest'
import type { MediaItem } from '@/packages/schema'
import { sidecarFilename, buildSidecar, sidecarDataUrl, planDownloads } from '../destination'

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
