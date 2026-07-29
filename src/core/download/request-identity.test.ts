import { describe, expect, it } from 'vitest'
import { mediaRequestId, sidecarRequestId } from './request-identity'

describe('media request identity', () => {
  it('preserves legacy X keys', () => {
    expect(mediaRequestId({ platform: 'x', id: 'shared' })).toBe('shared')
  })

  it('separates equal adapter-local keys', () => {
    expect(
      new Set([
        mediaRequestId({ platform: 'x', id: 'shared' }),
        mediaRequestId({ platform: 'instagram', id: 'shared' }),
        mediaRequestId({ platform: 'threads', id: 'shared' }),
      ]).size,
    ).toBe(3)
  })

  it('uses an injective versioned tuple for non-X and reserved X keys', () => {
    expect(mediaRequestId({ platform: 'instagram', id: 'shared' })).toBe(
      'xmd:v1:media:instagram:6:shared',
    )
    expect(mediaRequestId({ platform: 'x', id: 'xmd:v1:media:instagram:6:shared' })).toBe(
      'xmd:v1:media:x:31:xmd:v1:media:instagram:6:shared',
    )
  })

  it('keeps sidecars distinct from real media ending in .json', () => {
    expect(sidecarRequestId({ platform: 'x', id: 'foo' })).toBe('xmd:v1:sidecar:x:3:foo')
    expect(mediaRequestId({ platform: 'x', id: 'foo.json' })).toBe('foo.json')
  })
})
