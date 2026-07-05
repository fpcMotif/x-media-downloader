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

  it('mediaKeyFromUrl delegates to mediaKeyFromMetaCombinedUrl (photo path)', () => {
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

  it('mediaKeyFromUrl also resolves a real (non-blob:) inline video url via the combined key path', () => {
    // LIVE-VERIFIED 2026-07-05: a real Instagram /p/{code}/ inline video post
    // (instagram.com/p/DaSs_DTmWdw/) served a direct, resolvable `tN`-shaped
    // url for its <video> — not blob: — so it resolves here with zero
    // DOM-anchor/index machinery needed for that case at all.
    expect(
      instagramAdapter.mediaKeyFromUrl(
        'https://scontent-lga3-1.cdninstagram.com/o1/v/t16/f2/m84/AQM-abc123.mp4?efg=1',
      ),
    ).toBe('AQM-abc123')
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
      expect(instagramAdapter.postKeyFromVideoElement?.(video, '/')).toBe('post:code:CODE1')
    })

    it('returns null when the <video> has no <article> ancestor', () => {
      const root = document.createElement('div')
      root.innerHTML = `<div><video></video></div>`
      const video = root.querySelector('video')!
      expect(instagramAdapter.postKeyFromVideoElement?.(video, '/')).toBeNull()
    })

    it('returns null when the <article> has no matching post link', () => {
      const root = document.createElement('div')
      root.innerHTML = `<article><a href="/explore/">link</a><video></video></article>`
      const video = root.querySelector('video')!
      expect(instagramAdapter.postKeyFromVideoElement?.(video, '/')).toBeNull()
    })

    it('returns the indexed key (never the bare shortcut) for a <video> at carousel slide 0', () => {
      // A DOM walk can't tell "single-video post" from "multi-video post
      // whose first slide happens to be a video" — only the store (which
      // knows the real video count) can. Always deriving the indexed form
      // here is what lets the store's own index-0 alias (registered
      // uniformly regardless of video count) resolve correctly either way.
      const root = document.createElement('div')
      root.innerHTML = `
        <article><a href="/p/CODE2/">link</a>
          <ul>
            <li><video></video></li>
            <li><img /></li>
            <li></li>
          </ul>
        </article>`
      const video = root.querySelector('video')!
      expect(instagramAdapter.postKeyFromVideoElement?.(video, '/')).toBe('post:code:CODE2:0')
    })

    it('returns the indexed key for a <video> at a non-zero carousel slide, excluding the empty trailing sentinel <li>', () => {
      const root = document.createElement('div')
      root.innerHTML = `
        <article><a href="/p/CODE3/">link</a>
          <ul>
            <li><img /></li>
            <li><video></video></li>
            <li></li>
          </ul>
        </article>`
      const video = root.querySelector('video')!
      expect(instagramAdapter.postKeyFromVideoElement?.(video, '/')).toBe('post:code:CODE3:1')
    })

    it('treats a <video> with no <ul> ancestor as slide 0 (single-media post)', () => {
      const root = document.createElement('div')
      root.innerHTML = `<article><a href="/p/CODE4/">link</a><div><video></video></div></article>`
      const video = root.querySelector('video')!
      expect(instagramAdapter.postKeyFromVideoElement?.(video, '/')).toBe('post:code:CODE4')
    })

    describe('standalone permalink-page fallback (no <article> anywhere on the page)', () => {
      // LIVE-VERIFIED 2026-07-05 (Chrome Canary): a standalone Instagram
      // permalink page (instagram.com/p/DaSs_DTmWdw/) has ZERO <article>
      // elements at all (document.querySelector('article') === null on the
      // real page) — the normal DOM-anchor walk in postIdFromDom always
      // returns null there, so video hover-grab was completely broken on
      // permalink pages even though the URL itself already carries the
      // post's own code.

      it('falls back to the pathname´s own /p/{code}/ code when no <article> ancestor exists', () => {
        const root = document.createElement('div')
        root.innerHTML = `<div><video></video></div>` // no <article> anywhere
        const video = root.querySelector('video')!
        expect(instagramAdapter.postKeyFromVideoElement?.(video, '/p/PERMACODE/')).toBe(
          'post:code:PERMACODE',
        )
      })

      it('falls back to the pathname´s own /reel/{code}/ code (singular form)', () => {
        const root = document.createElement('div')
        root.innerHTML = `<div><video></video></div>`
        const video = root.querySelector('video')!
        expect(instagramAdapter.postKeyFromVideoElement?.(video, '/reel/REELCODE/')).toBe(
          'post:code:REELCODE',
        )
      })

      it('falls back to the pathname´s own /reels/{code}/ code (plural form)', () => {
        const root = document.createElement('div')
        root.innerHTML = `<div><video></video></div>`
        const video = root.querySelector('video')!
        expect(instagramAdapter.postKeyFromVideoElement?.(video, '/reels/REELSCODE/')).toBe(
          'post:code:REELSCODE',
        )
      })

      it('handles a share-link query suffix on the pathname is irrelevant — pathname never carries a query string, but a trailing share segment in the path itself still resolves', () => {
        // location.pathname never includes the query string (?utm_source=...
        // lives in location.search), so no special query-stripping is needed
        // here at all — this test simply documents that fact for the exact
        // share-link shape the user was reproducing with.
        const root = document.createElement('div')
        root.innerHTML = `<div><video></video></div>`
        const video = root.querySelector('video')!
        expect(instagramAdapter.postKeyFromVideoElement?.(video, '/reel/DaZ1rHWDjCN/')).toBe(
          'post:code:DaZ1rHWDjCN',
        )
      })

      it('the pathname fallback still derives the indexed key for a carousel slide, keyed off a <ul> ancestor even without an <article>', () => {
        // A permalink page's carousel still has slide <li> markup (only the
        // outer <article> boundary is missing) — the existing slideIndexFromDom
        // logic keeps working once postIdFromDom's <article>-walk is merely
        // ONE of two ways to learn the code, not the only way.
        const root = document.createElement('div')
        root.innerHTML = `
          <ul>
            <li><video></video></li>
            <li><img /></li>
            <li></li>
          </ul>`
        const video = root.querySelector('video')!
        expect(instagramAdapter.postKeyFromVideoElement?.(video, '/p/CAROUSELCODE/')).toBe(
          'post:code:CAROUSELCODE:0',
        )
      })

      it('returns null when neither an <article> ancestor NOR a permalink-shaped pathname exists (e.g. the home feed root url)', () => {
        const root = document.createElement('div')
        root.innerHTML = `<div><video></video></div>`
        const video = root.querySelector('video')!
        expect(instagramAdapter.postKeyFromVideoElement?.(video, '/')).toBeNull()
      })

      it('prefers the real <article> DOM anchor over the pathname fallback when both are present and disagree (e.g. a suggested-post video, if one ever exists)', () => {
        // The permalink page's OWN code lives in the pathname; a DIFFERENT
        // post's <article> (if one were ever found containing a video, which
        // live research found NOT to happen for suggested-content sections)
        // must still win over the page-wide pathname fallback — the fallback
        // is last-resort only, never a first choice once a real DOM anchor is
        // found.
        const root = document.createElement('div')
        root.innerHTML = `<article><a href="/p/OTHERCODE/">link</a><video></video></article>`
        const video = root.querySelector('video')!
        expect(instagramAdapter.postKeyFromVideoElement?.(video, '/p/PAGECODE/')).toBe(
          'post:code:OTHERCODE',
        )
      })

      it('does NOT apply the pathname fallback when multiple sibling <video>s with no <article> ancestor are mounted at once (Reels immersive player)', () => {
        // LIVE-VERIFIED 2026-07-05: Instagram's Reels immersive player
        // (/reels/{code}/) mounts many sibling <video> elements simultaneously
        // (6-11 observed live, off-screen ones included) with NO <article>/<li>
        // ancestor for any of them, and `location.pathname` reflects only
        // whichever reel is currently scrolled into view. A naive "no
        // <article> -> trust the pathname" fallback would resolve EVERY
        // mounted sibling to the SAME post code — reproduced directly against
        // the pre-fix code, where two distinct sibling videos returned the
        // identical key. The permalink-page case this fallback exists for
        // (`/p/{code}/`, `/reel(s)/{code}/` landed on directly) always has
        // exactly ONE <video> mounted (also live-verified) — so gating the
        // fallback on "exactly one <video> in the whole document" cleanly
        // distinguishes the two cases without any viewport/geometry check
        // (which happy-dom can't compute anyway).
        const root = document.createElement('div')
        root.innerHTML = `
          <div><video></video></div>
          <div><video></video></div>`
        const [video1, video2] = [...root.querySelectorAll('video')]
        expect(instagramAdapter.postKeyFromVideoElement?.(video1!, '/reels/CODE_A/')).toBeNull()
        expect(instagramAdapter.postKeyFromVideoElement?.(video2!, '/reels/CODE_A/')).toBeNull()
      })
    })
  })

  describe('extractPostCodes', () => {
    it('delegates to postCodesInResponse', () => {
      const json = { pk: '111', code: 'CODE1', user: { username: 'alice' } }
      expect([...instagramAdapter.extractPostCodes!(json)]).toEqual([['111', 'CODE1']])
    })
  })

  describe('postCodeFromElement', () => {
    it('returns the /p/{code}/ shortcode of the post containing any element (a photo)', () => {
      const root = document.createElement('div')
      root.innerHTML = `<article><a href="/p/CODE9/">link</a><img src="x.jpg" /></article>`
      const img = root.querySelector('img')!
      expect(instagramAdapter.postCodeFromElement?.(img, '/')).toBe('CODE9')
    })
    it('returns null when the element is not inside a post', () => {
      const root = document.createElement('div')
      root.innerHTML = `<div><img src="x.jpg" /></div>`
      const img = root.querySelector('img')!
      expect(instagramAdapter.postCodeFromElement?.(img, '/explore/')).toBeNull()
    })
  })

  describe('resolveHoverItem/canResolveHoverItem for a <video> resolved via a post-level key', () => {
    it('resolves via detected when the key is a registered post:{code} string', () => {
      const root = document.createElement('div')
      root.innerHTML = `<article><a href="/p/CODE1/">link</a><video></video></article>`
      const video = root.querySelector('video')!
      const key = instagramAdapter.postKeyFromVideoElement!(video, '/')!
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
      const key = instagramAdapter.postKeyFromVideoElement!(video, '/')!
      expect(instagramAdapter.canResolveHoverItem(video, key, new Map())).toBe(false)
      expect(instagramAdapter.resolveHoverItem(video, key, new Map(), '/p/CODE1/')).toBeNull()
    })
  })
})
