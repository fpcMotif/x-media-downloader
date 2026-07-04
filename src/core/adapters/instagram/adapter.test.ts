import { describe, it, expect } from 'vitest'
import {
  instagramAdapter,
  INSTAGRAM_HOST_MATCH,
  isInstagramUrl,
  isTrackedInstagramResponseUrl,
} from './adapter'

describe('INSTAGRAM_HOST_MATCH / isInstagramUrl', () => {
  it('is the single www.instagram.com host pattern', () => {
    expect(INSTAGRAM_HOST_MATCH).toEqual(['*://www.instagram.com/*'])
  })

  it('matches an instagram.com page url', () => {
    expect(isInstagramUrl('https://www.instagram.com/p/CODE1/')).toBe(true)
    expect(isInstagramUrl('https://www.instagram.com/alice/reel/CODE2/')).toBe(true)
  })

  it('rejects a non-instagram url', () => {
    expect(isInstagramUrl('https://x.com/alice/status/1')).toBe(false)
    expect(isInstagramUrl('https://www.threads.net/@bob/post/CODE')).toBe(false)
  })

  it('rejects a url that merely contains an instagram.com substring', () => {
    expect(isInstagramUrl('https://evil.example/redirect?u=https://www.instagram.com/x')).toBe(
      false,
    )
  })
})

describe('isTrackedInstagramResponseUrl', () => {
  // Live-verified 2026-07-05 (Chrome Canary, logged-in session, TWO passes):
  // the first pass (initial page load only) saw only `/api/graphql` and
  // wrongly concluded `/graphql/query` was unused. A second pass exercising
  // normal feed scrolling observed BOTH firing — Instagram uses both
  // endpoints, exactly like Threads, just not necessarily in the same
  // interaction. Match both; a single interaction pattern isn't enough to
  // rule an endpoint out.
  it('matches the real /api/graphql endpoint', () => {
    expect(isTrackedInstagramResponseUrl('https://www.instagram.com/api/graphql')).toBe(true)
  })

  it('matches /graphql/query too (observed during feed scrolling, not initial load)', () => {
    expect(isTrackedInstagramResponseUrl('https://www.instagram.com/graphql/query')).toBe(true)
  })

  it('matches a REST-ish /api/v1/ url (kept as a courtesy fallback per research)', () => {
    expect(isTrackedInstagramResponseUrl('https://www.instagram.com/api/v1/feed/timeline/')).toBe(
      true,
    )
  })

  it('rejects an unrelated url', () => {
    expect(isTrackedInstagramResponseUrl('https://www.instagram.com/static/bundles/app.js')).toBe(
      false,
    )
  })
})

describe('instagramAdapter', () => {
  it('reports the instagram platform tag and host patterns', () => {
    expect(instagramAdapter.platform).toBe('instagram')
    expect(instagramAdapter.hostMatch).toBe(INSTAGRAM_HOST_MATCH)
  })

  it('matchesUrl delegates to isInstagramUrl', () => {
    expect(instagramAdapter.matchesUrl('https://www.instagram.com/p/CODE1/')).toBe(true)
    expect(instagramAdapter.matchesUrl('https://x.com/alice/status/1')).toBe(false)
  })

  it('isTrackedResponseUrl delegates to isTrackedInstagramResponseUrl, ignoring requestHeaders', () => {
    expect(
      instagramAdapter.isTrackedResponseUrl('https://www.instagram.com/api/v1/feed/timeline/', {
        'x-fb-friendly-name': 'AnythingAtAll',
      }),
    ).toBe(true)
    expect(instagramAdapter.isTrackedResponseUrl('https://www.instagram.com/static/app.js')).toBe(
      false,
    )
  })

  it('detectFromResponse tags media items with the instagram platform (single photo)', () => {
    const json = {
      items: [
        {
          pk: '111',
          code: 'CODE1',
          user: { username: 'alice' },
          image_versions2: {
            candidates: [{ url: 'https://cdn.example/media/AAA.jpg', width: 1080, height: 1080 }],
          },
        },
      ],
    }
    const items = instagramAdapter.detectFromResponse(
      'https://www.instagram.com/api/v1/feed/timeline/',
      json,
    )
    expect(items).toEqual([
      {
        id: 'AAA',
        platform: 'instagram',
        postId: '111',
        author: 'alice',
        type: 'photo',
        url: 'https://cdn.example/media/AAA.jpg',
        ext: 'jpg',
        index: 0,
        width: 1080,
        height: 1080,
      },
    ])
  })

  it('detectFromResponse resolves a single video post', () => {
    const json = {
      pk: 222,
      code: 'CODE2',
      user: { username: 'bob' },
      video_versions: [{ url: 'https://cdn.example/v/BBB.mp4', width: 720, height: 1280 }],
    }
    const items = instagramAdapter.detectFromResponse(
      'https://www.instagram.com/graphql/query/',
      json,
    )
    expect(items).toEqual([
      {
        id: 'BBB',
        platform: 'instagram',
        postId: '222',
        author: 'bob',
        type: 'video',
        url: 'https://cdn.example/v/BBB.mp4',
        ext: 'mp4',
        index: 0,
        width: 720,
        height: 1280,
      },
    ])
  })

  it('detectFromResponse resolves a carousel post into multiple indexed MediaItems', () => {
    const json = {
      pk: '333',
      code: 'CODE3',
      user: { username: 'carol' },
      carousel_media: [
        { image_versions2: { candidates: [{ url: 'https://cdn.example/c1.jpg' }] } },
        { video_versions: [{ url: 'https://cdn.example/c2.mp4' }] },
      ],
    }
    const items = instagramAdapter.detectFromResponse(
      'https://www.instagram.com/graphql/query/',
      json,
    )
    expect(
      items.map((i) => ({ id: i.id, type: i.type, index: i.index, postId: i.postId })),
    ).toEqual([
      { id: 'c1', type: 'photo', index: 0, postId: '333' },
      { id: 'c2', type: 'video', index: 1, postId: '333' },
    ])
  })

  it('detectFromResponse returns [] for a response with no post-shaped nodes (ignores the url param)', () => {
    expect(
      instagramAdapter.detectFromResponse('https://www.instagram.com/api/v1/nonsense/', {
        hello: 'world',
      }),
    ).toEqual([])
  })

  it('detectRenderedMedia/resolveHoverItem/canResolveHoverItem defer to the tee map (no DOM-only resolution)', () => {
    const root = document.createElement('div')
    root.innerHTML = '<img src="https://cdn.example/media/AAA.jpg" />'
    expect(instagramAdapter.detectRenderedMedia(root, '/p/CODE1/')).toEqual([])

    const img = root.querySelector('img')!
    expect(instagramAdapter.canResolveHoverItem(img, 'unknown-key', new Map())).toBe(false)
    expect(instagramAdapter.resolveHoverItem(img, 'unknown-key', new Map(), '/p/CODE1/')).toBeNull()

    const item = {
      id: 'AAA',
      platform: 'instagram' as const,
      postId: '111',
      author: 'alice',
      type: 'photo' as const,
      url: 'https://cdn.example/media/AAA.jpg',
      ext: 'jpg',
      index: 0,
    }
    const detected = new Map([['AAA', item]])
    expect(instagramAdapter.canResolveHoverItem(img, 'AAA', detected)).toBe(true)
    expect(instagramAdapter.resolveHoverItem(img, 'AAA', detected, '/p/CODE1/')).toBe(item)
  })

  it('has no findMediaNeedingRecovery (no public no-auth recovery fallback exists)', () => {
    expect(instagramAdapter.findMediaNeedingRecovery).toBeUndefined()
  })
})
