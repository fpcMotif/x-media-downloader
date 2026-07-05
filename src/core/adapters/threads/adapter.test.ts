import { describe, it, expect } from 'vitest'
import {
  THREADS_HOST_MATCH,
  isThreadsUrl,
  isTrackedThreadsResponseUrl,
  threadsAdapter,
} from './adapter'

describe('THREADS_HOST_MATCH', () => {
  it('covers both the pre- and post-migration hosts', () => {
    expect(THREADS_HOST_MATCH).toEqual(['*://www.threads.net/*', '*://www.threads.com/*'])
  })
})

describe('isThreadsUrl', () => {
  it('matches both threads.net and threads.com pages', () => {
    expect(isThreadsUrl('https://www.threads.net/@alice/post/CODE1')).toBe(true)
    expect(isThreadsUrl('https://www.threads.com/@alice/post/CODE1')).toBe(true)
  })

  it('rejects other hosts, including bare (no www) and lookalike domains', () => {
    expect(isThreadsUrl('https://threads.net/@alice')).toBe(false)
    expect(isThreadsUrl('https://www.instagram.com/p/abc/')).toBe(false)
    expect(isThreadsUrl('https://example.com/www.threads.net/fake')).toBe(false)
    expect(isThreadsUrl('not a url at all')).toBe(false)
  })
})

describe('isTrackedThreadsResponseUrl', () => {
  it('matches the graphql endpoint on both hosts', () => {
    expect(isTrackedThreadsResponseUrl('https://www.threads.net/api/graphql')).toBe(true)
    expect(isTrackedThreadsResponseUrl('https://www.threads.com/api/graphql')).toBe(true)
  })

  it('is deliberately loose: a query-stringed or path-suffixed graphql url still matches', () => {
    expect(isTrackedThreadsResponseUrl('https://www.threads.net/api/graphql?abc=1')).toBe(true)
  })

  // Live-verified 2026-07-04 (Chrome Canary, logged-in session): the SAME
  // browsing session dispatched through both /api/graphql AND /graphql/query
  // — unlike Instagram, which was only observed using /api/graphql.
  it('also matches the /graphql/query endpoint (observed alongside /api/graphql in the same live session)', () => {
    expect(isTrackedThreadsResponseUrl('https://www.threads.com/graphql/query')).toBe(true)
    expect(isTrackedThreadsResponseUrl('https://www.threads.com/graphql/query?doc_id=1')).toBe(true)
  })

  it('rejects a non-graphql url', () => {
    expect(isTrackedThreadsResponseUrl('https://www.threads.net/api/v1/media/like')).toBe(false)
  })

  it('ignores the optional requestHeaders param (accepted for interface conformance only)', () => {
    expect(
      isTrackedThreadsResponseUrl('https://www.threads.net/api/graphql', {
        'x-fb-friendly-name': 'AnyOp',
      }),
    ).toBe(true)
  })
})

describe('threadsAdapter', () => {
  it('reports the threads platform tag and THREADS_HOST_MATCH host patterns', () => {
    expect(threadsAdapter.platform).toBe('threads')
    expect(threadsAdapter.hostMatch).toBe(THREADS_HOST_MATCH)
  })

  it('matchesUrl delegates to isThreadsUrl', () => {
    expect(threadsAdapter.matchesUrl('https://www.threads.net/@alice/post/C1')).toBe(true)
    expect(threadsAdapter.matchesUrl('https://www.instagram.com/p/abc/')).toBe(false)
  })

  it('isTrackedResponseUrl delegates to the graphql-url filter', () => {
    expect(threadsAdapter.isTrackedResponseUrl('https://www.threads.net/api/graphql')).toBe(true)
    expect(threadsAdapter.isTrackedResponseUrl('https://www.threads.net/other')).toBe(false)
  })

  it('detectFromResponse tags resolved media with the threads platform', () => {
    const json = {
      pk: '111',
      code: 'CODE1',
      user: { username: 'alice' },
      image_versions2: {
        candidates: [{ url: 'https://cdn.example/media/AAA.jpg', width: 1080, height: 1080 }],
      },
    }
    const items = threadsAdapter.detectFromResponse('https://www.threads.net/api/graphql', json)
    expect(items).toEqual([
      {
        id: 'AAA',
        platform: 'threads',
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
    const items = threadsAdapter.detectFromResponse('https://www.threads.net/api/graphql', json)
    expect(items).toEqual([
      {
        id: 'BBB',
        platform: 'threads',
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

  it('detectFromResponse resolves a carousel post into multiple ordered MediaItems', () => {
    const json = {
      pk: '333',
      code: 'CODE3',
      user: { username: 'carol' },
      carousel_media: [
        { image_versions2: { candidates: [{ url: 'https://cdn.example/c1.jpg' }] } },
        { video_versions: [{ url: 'https://cdn.example/c2.mp4' }] },
      ],
    }
    const items = threadsAdapter.detectFromResponse('https://www.threads.net/api/graphql', json)
    expect(
      items.map((i) => ({ id: i.id, type: i.type, index: i.index, postId: i.postId })),
    ).toEqual([
      { id: 'c1', type: 'photo', index: 0, postId: '333' },
      { id: 'c2', type: 'video', index: 1, postId: '333' },
    ])
  })

  it('detectFromResponse resolves BOTH the quoting and quoted post as independent MediaItems (quote-post)', () => {
    // Threads-specific: text_post_app_info.share_info.quoted_post wraps the
    // original post. The generic recursive walk (forEachPostNode) finds the
    // nested quoted_post as its own post-shaped node for free — no
    // Threads-specific unwrapping code needed. This test proves it actually
    // happens, rather than merely asserting it in a comment.
    const json = {
      pk: '9001',
      code: 'QUOTER_CODE',
      user: { username: 'quoter' },
      image_versions2: {
        candidates: [{ url: 'https://cdn.example/quoter-own.jpg', width: 100, height: 100 }],
      },
      text_post_app_info: {
        share_info: {
          quoted_post: {
            pk: '8000',
            code: 'QUOTED_CODE',
            user: { username: 'original_author' },
            image_versions2: {
              candidates: [
                { url: 'https://cdn.example/quoted-media.jpg', width: 200, height: 200 },
              ],
            },
          },
        },
      },
    }
    const items = threadsAdapter.detectFromResponse('https://www.threads.net/api/graphql', json)
    const quoter = items.find((i) => i.postId === '9001')
    const quoted = items.find((i) => i.postId === '8000')
    expect(quoter).toBeDefined()
    expect(quoted).toBeDefined()
    expect(quoter).toMatchObject({ author: 'quoter', url: 'https://cdn.example/quoter-own.jpg' })
    expect(quoted).toMatchObject({
      author: 'original_author',
      url: 'https://cdn.example/quoted-media.jpg',
    })
    expect(items).toHaveLength(2)
  })

  it('detectFromResponse resolves BOTH sides of a bare repost (reposted_post)', () => {
    const json = {
      pk: '9002',
      code: 'REPOSTER_CODE',
      user: { username: 'reposter' },
      text_post_app_info: {
        share_info: {
          reposted_post: {
            pk: '7000',
            code: 'ORIG_CODE',
            user: { username: 'orig_author' },
            video_versions: [{ url: 'https://cdn.example/orig.mp4', width: 480, height: 852 }],
          },
        },
      },
    }
    const items = threadsAdapter.detectFromResponse('https://www.threads.net/api/graphql', json)
    // The reposter's own node carries no media of its own (a bare repost has
    // none) — only the reposted_post's media resolves, under ITS OWN postId.
    expect(items).toEqual([
      {
        id: 'orig',
        platform: 'threads',
        postId: '7000',
        author: 'orig_author',
        type: 'video',
        url: 'https://cdn.example/orig.mp4',
        ext: 'mp4',
        index: 0,
        width: 480,
        height: 852,
      },
    ])
  })

  describe('DOM path (tee-first, photo-only DOM fallback — video stays tee-map-only)', () => {
    it('detectRenderedMedia always returns [] (no independent DOM post-identity detection)', () => {
      const root = document.createElement('div')
      root.innerHTML = `<article><img src="https://cdn.example/rendered.jpg" /></article>`
      expect(threadsAdapter.detectRenderedMedia(root, '/@alice/post/C1')).toEqual([])
    })

    it('resolveHoverItem returns the tee-detected item for a known key, else null (non-photo element)', () => {
      const el = document.createElement('div')
      const item = {
        id: 'k1',
        platform: 'threads' as const,
        postId: '1',
        author: 'a',
        type: 'photo' as const,
        url: 'https://cdn.example/k1.jpg',
        ext: 'jpg',
        index: 0,
      }
      const detected = new Map([['k1', item]])
      expect(threadsAdapter.resolveHoverItem(el, 'k1', detected, '/')).toEqual(item)
      expect(threadsAdapter.resolveHoverItem(el, 'unknown', detected, '/')).toBeNull()
    })

    it('canResolveHoverItem reflects tee-map membership (non-photo element)', () => {
      const el = document.createElement('div')
      const item = {
        id: 'k1',
        platform: 'threads' as const,
        postId: '1',
        author: 'a',
        type: 'photo' as const,
        url: 'https://cdn.example/k1.jpg',
        ext: 'jpg',
        index: 0,
      }
      const detected = new Map([['k1', item]])
      expect(threadsAdapter.canResolveHoverItem(el, 'k1', detected)).toBe(true)
      expect(threadsAdapter.canResolveHoverItem(el, 'unknown', detected)).toBe(false)
    })

    it('mediaKeyFromUrl delegates to mediaKeyFromMetaUrl (shared with Instagram, no Threads-specific variant)', () => {
      expect(
        threadsAdapter.mediaKeyFromUrl(
          'https://scontent.cdninstagram.com/v/t51.82787-15/AAA_n.jpg',
        ),
      ).toBe('AAA_n')
      expect(
        threadsAdapter.mediaKeyFromUrl(
          'https://scontent.cdninstagram.com/v/t51.82787-19/AAA_n.jpg',
        ),
      ).toBeNull()
    })

    it('resolveHoverItem/canResolveHoverItem fall back to a DOM photo resolve when the tee misses it', () => {
      const root = document.createElement('div')
      root.innerHTML = '<img src="https://scontent.cdninstagram.com/v/t51.82787-15/AAA_n.jpg" />'
      const img = root.querySelector('img')!
      const key = threadsAdapter.mediaKeyFromUrl(img.src)!

      expect(threadsAdapter.canResolveHoverItem(img, key, new Map())).toBe(true)
      expect(threadsAdapter.resolveHoverItem(img, key, new Map(), '/')).toEqual({
        id: key,
        platform: 'threads',
        postId: key,
        author: '',
        type: 'photo',
        url: img.src,
        ext: 'jpg',
        index: 0,
      })
    })

    it('resolveHoverItem/canResolveHoverItem do not fall back for a non-<img> element even with a grabbable-looking key', () => {
      const el = document.createElement('div')
      expect(threadsAdapter.canResolveHoverItem(el, 'unknown', new Map())).toBe(false)
      expect(threadsAdapter.resolveHoverItem(el, 'unknown', new Map(), '/')).toBeNull()
    })

    it('resolveHoverItem returns null for an <img> whose src is not a grabbable photo (avatar)', () => {
      const avatarImg = document.createElement('img')
      avatarImg.src = 'https://scontent.cdninstagram.com/v/t51.82787-19/BBB_n.jpg'
      expect(threadsAdapter.canResolveHoverItem(avatarImg, 'unknown', new Map())).toBe(false)
      expect(threadsAdapter.resolveHoverItem(avatarImg, 'unknown', new Map(), '/')).toBeNull()
    })

    it('falls back to .src when currentSrc is empty (not-yet-loaded image)', () => {
      const img = document.createElement('img')
      img.src = 'https://scontent.cdninstagram.com/v/t51.82787-15/AAA_n.jpg'
      // currentSrc would short-circuit the `||`; force it empty so the `.src` arm runs.
      Object.defineProperty(img, 'currentSrc', { value: '', configurable: true })
      const key = threadsAdapter.mediaKeyFromUrl(img.src)!
      expect(threadsAdapter.canResolveHoverItem(img, key, new Map())).toBe(true)
      expect(threadsAdapter.resolveHoverItem(img, key, new Map(), '/')).toEqual({
        id: key,
        platform: 'threads',
        postId: key,
        author: '',
        type: 'photo',
        url: img.src,
        ext: 'jpg',
        index: 0,
      })
    })
  })

  it('does not implement findMediaNeedingRecovery (no public/no-auth fallback exists)', () => {
    expect(threadsAdapter.findMediaNeedingRecovery).toBeUndefined()
  })
})
