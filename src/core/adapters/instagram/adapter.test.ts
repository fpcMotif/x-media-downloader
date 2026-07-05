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

  it('detectRenderedMedia always returns [] (no independent DOM post-identity detection)', () => {
    const root = document.createElement('div')
    root.innerHTML =
      '<img src="https://scontent-lga3-2.cdninstagram.com/v/t51.82787-15/AAA_n.jpg" />'
    expect(instagramAdapter.detectRenderedMedia(root, '/p/CODE1/')).toEqual([])
  })

  it('mediaKeyFromUrl delegates to mediaKeyFromMetaUrl', () => {
    expect(
      instagramAdapter.mediaKeyFromUrl(
        'https://scontent-lga3-2.cdninstagram.com/v/t51.82787-15/AAA_n.jpg?a=1',
      ),
    ).toBe('AAA_n')
    expect(
      instagramAdapter.mediaKeyFromUrl(
        'https://scontent-lga3-2.cdninstagram.com/v/t51.2885-19/AAA_n.jpg',
      ),
    ).toBeNull()
  })

  it('resolveHoverItem/canResolveHoverItem prefer the tee map, else fall back to a DOM photo resolve', () => {
    const root = document.createElement('div')
    root.innerHTML =
      '<img src="https://scontent-lga3-2.cdninstagram.com/v/t51.82787-15/AAA_n.jpg" />'
    const img = root.querySelector('img')!
    const key = instagramAdapter.mediaKeyFromUrl(img.src)!

    // Unknown key, non-<img> element — no fallback possible.
    const div = document.createElement('div')
    expect(instagramAdapter.canResolveHoverItem(div, key, new Map())).toBe(false)
    expect(instagramAdapter.resolveHoverItem(div, key, new Map(), '/p/CODE1/')).toBeNull()

    // Unknown key, real <img> with a non-grabbable src — no fallback.
    const avatarImg = document.createElement('img')
    avatarImg.src = 'https://scontent-lga3-2.cdninstagram.com/v/t51.2885-19/BBB_n.jpg'
    expect(instagramAdapter.canResolveHoverItem(avatarImg, 'unknown', new Map())).toBe(false)
    expect(instagramAdapter.resolveHoverItem(avatarImg, 'unknown', new Map(), '/')).toBeNull()

    // Unknown key, grabbable <img> — DOM fallback resolves a placeholder photo item.
    expect(instagramAdapter.canResolveHoverItem(img, key, new Map())).toBe(true)
    const resolved = instagramAdapter.resolveHoverItem(img, key, new Map(), '/p/CODE1/')
    expect(resolved).toEqual({
      id: key,
      platform: 'instagram',
      postId: key,
      author: '',
      type: 'photo',
      url: img.src,
      ext: 'jpg',
      index: 0,
    })

    // Tee already knows the key — tee item wins over the DOM fallback.
    const teed = {
      id: key,
      platform: 'instagram' as const,
      postId: '111',
      author: 'alice',
      type: 'photo' as const,
      url: img.src,
      ext: 'jpg',
      index: 0,
    }
    const detected = new Map([[key, teed]])
    expect(instagramAdapter.canResolveHoverItem(img, key, detected)).toBe(true)
    expect(instagramAdapter.resolveHoverItem(img, key, detected, '/p/CODE1/')).toBe(teed)
  })

  it('has no findMediaNeedingRecovery (no public no-auth recovery fallback exists)', () => {
    expect(instagramAdapter.findMediaNeedingRecovery).toBeUndefined()
  })

  it('resolveHoverItem/canResolveHoverItem fall back to .src when currentSrc is empty (not-yet-loaded image)', () => {
    const img = document.createElement('img')
    img.src = 'https://scontent-lga3-2.cdninstagram.com/v/t51.82787-15/AAA_n.jpg'
    // currentSrc would short-circuit the `||`; force it empty so the `.src` arm runs.
    Object.defineProperty(img, 'currentSrc', { value: '', configurable: true })
    const key = instagramAdapter.mediaKeyFromUrl(img.src)!
    expect(instagramAdapter.canResolveHoverItem(img, key, new Map())).toBe(true)
    expect(instagramAdapter.resolveHoverItem(img, key, new Map(), '/')).toEqual({
      id: key,
      platform: 'instagram',
      postId: key,
      author: '',
      type: 'photo',
      url: img.src,
      ext: 'jpg',
      index: 0,
    })
  })

  describe('postKeyFromVideoElement', () => {
    it('returns post:{code} for a <video> inside a real <article> with a /p/{code}/ link', () => {
      const root = document.createElement('div')
      root.innerHTML = `<article><a href="/p/CODE1/">link</a><div><video></video></div></article>`
      const video = root.querySelector('video')!
      expect(instagramAdapter.postKeyFromVideoElement?.(video)).toBe('post:code:CODE1')
    })

    it('returns null when the <video> has no <article> ancestor', () => {
      const root = document.createElement('div')
      root.innerHTML = `<div><video></video></div>`
      const video = root.querySelector('video')!
      expect(instagramAdapter.postKeyFromVideoElement?.(video)).toBeNull()
    })

    it('returns null when the <article> has no matching post link', () => {
      const root = document.createElement('div')
      root.innerHTML = `<article><a href="/explore/">link</a><video></video></article>`
      const video = root.querySelector('video')!
      expect(instagramAdapter.postKeyFromVideoElement?.(video)).toBeNull()
    })
  })

  describe('extractPostCodes', () => {
    it('delegates to postCodesInResponse', () => {
      const json = { pk: '111', code: 'CODE1', user: { username: 'alice' } }
      expect([...instagramAdapter.extractPostCodes!(json)]).toEqual([['111', 'CODE1']])
    })
  })

  describe('resolveHoverItem/canResolveHoverItem for a <video> resolved via a post-level key', () => {
    it('resolves via detected when the key is a registered post:{code} string', () => {
      const root = document.createElement('div')
      root.innerHTML = `<article><a href="/p/CODE1/">link</a><video></video></article>`
      const video = root.querySelector('video')!
      const key = instagramAdapter.postKeyFromVideoElement!(video)!
      const teedVideo = {
        id: 'BBB',
        platform: 'instagram' as const,
        postId: '111',
        author: 'alice',
        type: 'video' as const,
        url: 'https://cdn.example/v/BBB.mp4',
        ext: 'mp4',
        index: 0,
      }
      const detected = new Map([[key, teedVideo]])
      expect(instagramAdapter.canResolveHoverItem(video, key, detected)).toBe(true)
      expect(instagramAdapter.resolveHoverItem(video, key, detected, '/p/CODE1/')).toBe(teedVideo)
    })

    it('canResolveHoverItem is false for a video whose post-key was never registered (e.g. carousel)', () => {
      const root = document.createElement('div')
      root.innerHTML = `<article><a href="/p/CODE1/">link</a><video></video></article>`
      const video = root.querySelector('video')!
      const key = instagramAdapter.postKeyFromVideoElement!(video)!
      expect(instagramAdapter.canResolveHoverItem(video, key, new Map())).toBe(false)
      expect(instagramAdapter.resolveHoverItem(video, key, new Map(), '/p/CODE1/')).toBeNull()
    })
  })
})
