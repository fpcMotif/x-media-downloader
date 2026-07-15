import { describe, it, expect } from 'vitest'
import {
  THREADS_HOST_MATCH,
  isThreadsUrl,
  isTrackedThreadsResponseUrl,
  threadsAdapter,
} from './adapter'
import { META_CDN_HOSTS } from '../meta-shared/cdn'

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

  it('reports the shared Meta CDN hosts', () => {
    expect(threadsAdapter.cdnHosts).toBe(META_CDN_HOSTS)
    expect(threadsAdapter.cdnHosts).toEqual([{ host: 'cdninstagram.com', includeSubdomains: true }])
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

    it('mediaKeyFromUrl delegates to mediaKeyFromMetaCombinedUrl (shared with Instagram, no Threads-specific variant)', () => {
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

    it('mediaKeyFromUrl also resolves a real (non-blob:) video url via the combined key path', () => {
      // LIVE-VERIFIED 2026-07-05: a real Threads carousel video slide
      // (@zuck/DZ7eGA1G7wU) serves a direct, resolvable `tN`-shaped url — not
      // blob: — so it resolves here with zero DOM-anchor machinery needed.
      expect(
        threadsAdapter.mediaKeyFromUrl(
          'https://scontent-lga3-1.cdninstagram.com/o1/v/t16/f2/m84/AQM-abc123.mp4?efg=1',
        ),
      ).toBe('AQM-abc123')
    })

    it('resolveHoverItem/canResolveHoverItem fall back to a DOM photo resolve when the tee misses it', () => {
      const root = document.createElement('div')
      root.innerHTML = '<img src="https://scontent.cdninstagram.com/v/t51.82787-15/AAA_n.jpg" />'
      const img = root.querySelector('img')!
      const key = threadsAdapter.mediaKeyFromUrl(img.src)!

      // Full placeholder shape is asserted in meta-shared/dom.test.ts; here we
      // only prove the routing + 'threads' platform tag.
      expect(threadsAdapter.canResolveHoverItem(img, key, new Map())).toBe(true)
      expect(threadsAdapter.resolveHoverItem(img, key, new Map(), '/')).toMatchObject({
        id: key,
        platform: 'threads',
        postId: key,
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
      expect(threadsAdapter.resolveHoverItem(img, key, new Map(), '/')).toMatchObject({
        id: key,
        platform: 'threads',
        postId: key,
      })
    })
  })

  it('does not implement findMediaNeedingRecovery (no public/no-auth fallback exists)', () => {
    expect(threadsAdapter.findMediaNeedingRecovery).toBeUndefined()
  })

  describe('postKeyFromVideoElement', () => {
    it('returns post:{code} for a <video> inside a pressable-container with a /@user/post/{code} link', () => {
      const root = document.createElement('div')
      root.innerHTML = `<div data-pressable-container="true"><a href="/@zuck/post/CODE1">link</a><video></video></div>`
      const video = root.querySelector('video')!
      expect(threadsAdapter.postKeyFromVideoElement?.(video, '/@zuck/post/CODE1')).toBe(
        'post:code:CODE1',
      )
    })

    it('handles a trailing /media suffix and a trailing dash in the code', () => {
      const root = document.createElement('div')
      root.innerHTML = `<div data-pressable-container="true"><a href="/@zuck/post/DaXWrlBEyf-/media">link</a><video></video></div>`
      const video = root.querySelector('video')!
      expect(threadsAdapter.postKeyFromVideoElement?.(video, '/')).toBe('post:code:DaXWrlBEyf-')
    })

    it('returns null when there is no pressable-container ancestor', () => {
      const root = document.createElement('div')
      root.innerHTML = `<div><video></video></div>`
      const video = root.querySelector('video')!
      expect(threadsAdapter.postKeyFromVideoElement?.(video, '/')).toBeNull()
    })

    // Track fixture shape LIVE-VERIFIED 2026-07-05 against
    // https://www.threads.com/@zuck/post/DZ7eGA1G7wU (a real 2-video, 3-photo
    // mixed carousel): a track div carrying an inline `transform: translateX`
    // style, whose DIRECT children are [spacer (no element children), slide
    // wrapper, slide wrapper, ...] — the spacer is distinguishable purely by
    // having zero element children (structural, not class-based: Threads'
    // own wrapper class names are build-obfuscated `x*` atomic classes with
    // no stable semantic hook to select on).
    it('returns the domSlot-0 indexed key (never the bare shortcut) for the FIRST video slide inside a real carousel track', () => {
      // A DOM walk can't tell "single-video post" from "multi-video post
      // whose first mounted slide happens to be a video" — only the store
      // (which knows the real video count) can. Always deriving the indexed
      // form here is what lets the store's own domSlot-0 alias (registered
      // uniformly regardless of video count) resolve correctly either way.
      const root = document.createElement('div')
      root.innerHTML = `
        <div data-pressable-container="true"><a href="/@zuck/post/CODE5">link</a>
          <div style="transform: translateX(0px);">
            <div></div>
            <div><video></video></div>
            <div><img /></div>
          </div>
        </div>`
      const video = root.querySelector('video')!
      expect(threadsAdapter.postKeyFromVideoElement?.(video, '/')).toBe('post:code:CODE5:slot:0')
    })

    it("returns the dom-slot key for the SECOND video slide, counting ALL mounted slides (a photo slide in between shifts the count, matching the store's absolute-index scheme)", () => {
      const root = document.createElement('div')
      root.innerHTML = `
        <div data-pressable-container="true"><a href="/@zuck/post/CODE6">link</a>
          <div style="transform: translateX(-716px);">
            <div></div>
            <div><video></video></div>
            <div><img /></div>
            <div><video></video></div>
          </div>
        </div>`
      const videos = root.querySelectorAll('video')
      expect(threadsAdapter.postKeyFromVideoElement?.(videos[0]!, '/')).toBe(
        'post:code:CODE6:slot:0',
      )
      expect(threadsAdapter.postKeyFromVideoElement?.(videos[1]!, '/')).toBe(
        'post:code:CODE6:slot:2',
      )
      // each video resolves to its OWN distinct key, never swapped
      expect(threadsAdapter.postKeyFromVideoElement?.(videos[0]!, '/')).not.toBe(
        threadsAdapter.postKeyFromVideoElement?.(videos[1]!, '/'),
      )
    })

    it('returns slot:2 for a THIRD video slide, proving the running counter advances past slot 1 too', () => {
      const root = document.createElement('div')
      root.innerHTML = `
        <div data-pressable-container="true"><a href="/@zuck/post/CODE9">link</a>
          <div style="transform: translateX(-1400px);">
            <div></div>
            <div><video></video></div>
            <div><video></video></div>
            <div><video></video></div>
          </div>
        </div>`
      const videos = root.querySelectorAll('video')
      expect(threadsAdapter.postKeyFromVideoElement?.(videos[0]!, '/')).toBe(
        'post:code:CODE9:slot:0',
      )
      expect(threadsAdapter.postKeyFromVideoElement?.(videos[1]!, '/')).toBe(
        'post:code:CODE9:slot:1',
      )
      expect(threadsAdapter.postKeyFromVideoElement?.(videos[2]!, '/')).toBe(
        'post:code:CODE9:slot:2',
      )
    })

    it('treats a <video> with no track ancestor as domSlot 0 (single-media post)', () => {
      const root = document.createElement('div')
      root.innerHTML = `<div data-pressable-container="true"><a href="/@zuck/post/CODE7">link</a><video></video></div>`
      const video = root.querySelector('video')!
      expect(threadsAdapter.postKeyFromVideoElement?.(video, '/')).toBe('post:code:CODE7')
    })

    it('treats a <video> mounted directly under the track (no slide-wrapper div) as domSlot 0, not a throw', () => {
      // Malformed-markup edge case: real Threads markup always wraps a video
      // in its own slide <div>, but a <video> sitting as a DIRECT child of the
      // translateX track itself (no wrapper) has no ancestor-or-self match
      // among track's children other than itself, and `Element.contains` is
      // reflexive (an element contains itself) — still falls back to the
      // index-0 shortcut rather than throwing.
      const root = document.createElement('div')
      root.innerHTML = `
        <div data-pressable-container="true"><a href="/@zuck/post/CODE8">link</a>
          <div style="transform: translateX(0px);">
            <video></video>
          </div>
        </div>`
      const video = root.querySelector('video')!
      expect(threadsAdapter.postKeyFromVideoElement?.(video, '/')).toBe('post:code:CODE8')
    })

    it('ignores the pathname param entirely — Threads never needs the permalink fallback (its own data-pressable-container anchor works on every page)', () => {
      const root = document.createElement('div')
      root.innerHTML = `<div data-pressable-container="true"><a href="/@zuck/post/CODE10">link</a><video></video></div>`
      const video = root.querySelector('video')!
      expect(threadsAdapter.postKeyFromVideoElement?.(video, '/totally/unrelated/path')).toBe(
        'post:code:CODE10',
      )
      expect(threadsAdapter.postKeyFromVideoElement?.(video, '/@zuck/post/CODE10')).toBe(
        'post:code:CODE10',
      )
    })
  })

  describe('extractPostCodes', () => {
    it('delegates to postCodesInResponse', () => {
      const json = { pk: '111', code: 'CODE1', user: { username: 'alice' } }
      expect([...threadsAdapter.extractPostCodes!(json)]).toEqual([['111', 'CODE1']])
    })
  })

  describe('postCodeFromElement', () => {
    it('returns the /@user/post/{code} shortcode of the containing post (a photo)', () => {
      const root = document.createElement('div')
      root.innerHTML = `<div data-pressable-container="true"><a href="/@zuck/post/CODE9">link</a><img src="x.jpg" /></div>`
      const img = root.querySelector('img')!
      expect(threadsAdapter.postCodeFromElement?.(img, '/')).toBe('CODE9')
    })
    it('returns null when not inside a pressable-container', () => {
      const root = document.createElement('div')
      root.innerHTML = `<div><img src="x.jpg" /></div>`
      const img = root.querySelector('img')!
      expect(threadsAdapter.postCodeFromElement?.(img, '/')).toBeNull()
    })
  })

  describe('resolveHoverItem/canResolveHoverItem for a <video> resolved via a post-level key', () => {
    it('resolves via detected when the key is a registered post:{code} string', () => {
      const root = document.createElement('div')
      root.innerHTML = `<div data-pressable-container="true"><a href="/@zuck/post/CODE1">link</a><video></video></div>`
      const video = root.querySelector('video')!
      const key = threadsAdapter.postKeyFromVideoElement!(video, '/')!
      const teedVideo = {
        id: 'BBB',
        platform: 'threads' as const,
        postId: '111',
        author: 'zuck',
        type: 'video' as const,
        url: 'https://cdn.example/v/BBB.mp4',
        ext: 'mp4',
        index: 0,
      }
      const detected = new Map([[key, teedVideo]])
      expect(threadsAdapter.canResolveHoverItem(video, key, detected)).toBe(true)
      expect(threadsAdapter.resolveHoverItem(video, key, detected, '/@zuck/post/CODE1')).toBe(
        teedVideo,
      )
    })

    it('canResolveHoverItem is false for a video whose post-key was never registered (e.g. carousel)', () => {
      const root = document.createElement('div')
      root.innerHTML = `<div data-pressable-container="true"><a href="/@zuck/post/CODE1">link</a><video></video></div>`
      const video = root.querySelector('video')!
      const key = threadsAdapter.postKeyFromVideoElement!(video, '/')!
      expect(threadsAdapter.canResolveHoverItem(video, key, new Map())).toBe(false)
      expect(threadsAdapter.resolveHoverItem(video, key, new Map(), '/@zuck/post/CODE1')).toBeNull()
    })
  })
})
