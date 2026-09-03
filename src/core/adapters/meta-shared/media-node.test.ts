import { describe, it, expect } from 'vitest'
import type { JsonValue } from '@/packages/schema'
import { pickLargestCandidate, mediaNodesFromPost } from './media-node'

describe('pickLargestCandidate', () => {
  it('returns undefined for an empty array', () => {
    expect(pickLargestCandidate([])).toBeUndefined()
  })

  it('returns the only candidate when there is one', () => {
    const c = { url: 'a', width: 100, height: 100 }
    expect(pickLargestCandidate([c])).toBe(c)
  })

  it('picks the candidate with the largest width×height area', () => {
    const small = { url: 'small', width: 100, height: 100 }
    const big = { url: 'big', width: 1080, height: 1080 }
    const medium = { url: 'medium', width: 400, height: 400 }
    expect(pickLargestCandidate([small, big, medium])).toBe(big)
  })

  it('keeps the first candidate when areas tie (including two undimensioned candidates)', () => {
    const first = { url: 'first' }
    const second = { url: 'second' }
    expect(pickLargestCandidate([first, second])).toBe(first)

    const firstDimensioned = { url: 'f', width: 200, height: 200 }
    const secondDimensioned = { url: 's', width: 200, height: 200 }
    expect(pickLargestCandidate([firstDimensioned, secondDimensioned])).toBe(firstDimensioned)
  })
})

describe('mediaNodesFromPost', () => {
  it('returns [] for a non-object node', () => {
    expect(mediaNodesFromPost(null)).toEqual([])
    expect(mediaNodesFromPost(undefined)).toEqual([])
    expect(mediaNodesFromPost('a string')).toEqual([])
    expect(mediaNodesFromPost(42)).toEqual([])
  })

  it('returns [] for a post with none of the three media shapes', () => {
    expect(mediaNodesFromPost({ caption: { text: 'hello' } })).toEqual([])
  })

  it('resolves a single photo from image_versions2.candidates (largest picked)', () => {
    const node = {
      image_versions2: {
        candidates: [
          { url: 'small.jpg', width: 320, height: 320 },
          { url: 'orig.jpg', width: 1440, height: 1440 },
        ],
      },
    }
    expect(mediaNodesFromPost(node)).toEqual([
      { kind: 'photo', url: 'orig.jpg', width: 1440, height: 1440 },
    ])
  })

  it('resolves a single video from video_versions (largest picked)', () => {
    const node = {
      video_versions: [
        { url: 'lo.mp4', width: 480, height: 480 },
        { url: 'hi.mp4', width: 1080, height: 1080 },
      ],
    }
    expect(mediaNodesFromPost(node)).toEqual([
      { kind: 'video', url: 'hi.mp4', width: 1080, height: 1080 },
    ])
  })

  it('prefers video_versions over image_versions2 when a node somehow has both', () => {
    const node = {
      video_versions: [{ url: 'v.mp4', width: 100, height: 100 }],
      image_versions2: { candidates: [{ url: 'poster.jpg', width: 100, height: 100 }] },
    }
    expect(mediaNodesFromPost(node)).toEqual([
      { kind: 'video', url: 'v.mp4', width: 100, height: 100 },
    ])
  })

  it('recurses into carousel_media, flattening each child in order (mixed photo+video)', () => {
    const node = {
      carousel_media: [
        { image_versions2: { candidates: [{ url: 'c1.jpg', width: 100, height: 100 }] } },
        { video_versions: [{ url: 'c2.mp4', width: 100, height: 100 }] },
      ],
    }
    expect(mediaNodesFromPost(node)).toEqual([
      { kind: 'photo', url: 'c1.jpg', width: 100, height: 100 },
      { kind: 'video', url: 'c2.mp4', width: 100, height: 100 },
    ])
  })

  it('falls through to video/image checks when carousel_media is present but empty', () => {
    const node = {
      carousel_media: [],
      video_versions: [{ url: 'v.mp4', width: 10, height: 10 }],
    }
    expect(mediaNodesFromPost(node)).toEqual([
      { kind: 'video', url: 'v.mp4', width: 10, height: 10 },
    ])
  })

  it('falls through to the image check when video_versions is present but empty', () => {
    const node = {
      video_versions: [],
      image_versions2: { candidates: [{ url: 'p.jpg', width: 10, height: 10 }] },
    }
    expect(mediaNodesFromPost(node)).toEqual([
      { kind: 'photo', url: 'p.jpg', width: 10, height: 10 },
    ])
  })

  it('returns [] when image_versions2 is malformed (not an object)', () => {
    expect(mediaNodesFromPost({ image_versions2: 'not an object' })).toEqual([])
  })

  it('returns [] when image_versions2.candidates is missing or empty', () => {
    expect(mediaNodesFromPost({ image_versions2: {} })).toEqual([])
    expect(mediaNodesFromPost({ image_versions2: { candidates: [] } })).toEqual([])
  })

  it('omits width/height entirely (not as `undefined`) when a chosen candidate lacks them', () => {
    const node = { image_versions2: { candidates: [{ url: 'no-dims.jpg' }] } }
    const result = mediaNodesFromPost(node)
    expect(result).toEqual([{ kind: 'photo', url: 'no-dims.jpg' }])
    expect('width' in result[0]!).toBe(false)
    expect('height' in result[0]!).toBe(false)
  })

  it('filters out malformed candidate entries (missing url / non-object)', () => {
    const node = {
      image_versions2: {
        candidates: [
          null,
          42,
          { width: 100, height: 100 },
          { url: 'ok.jpg', width: 50, height: 50 },
        ],
      },
    }
    expect(mediaNodesFromPost(node)).toEqual([
      { kind: 'photo', url: 'ok.jpg', width: 50, height: 50 },
    ])
  })

  it('fails closed (does not throw) on a circular carousel_media reference', () => {
    const carousel: JsonValue[] = []
    const node = { carousel_media: carousel }
    carousel.push(node)
    expect(() => mediaNodesFromPost(node)).not.toThrow()
    expect(mediaNodesFromPost(node)).toEqual([])
  })
})
