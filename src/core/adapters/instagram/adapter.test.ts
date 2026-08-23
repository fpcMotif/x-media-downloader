import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  instagramAdapter,
  INSTAGRAM_HOST_MATCH,
  isInstagramUrl,
  isTrackedInstagramResponseUrl,
  postCodeFromPathname,
  visibleAreaInViewport,
} from './adapter'
import { META_CDN_HOSTS } from '../meta-shared/cdn'
import { resolveMetaImageElement } from '../meta-shared/dom'

/** A stubbed `getBoundingClientRect` — happy-dom computes no layout, so every
 *  viewport-dominance assertion has to hand the adapter its own geometry. */
const rect = (top: number, left: number, width: number, height: number) => () =>
  ({ top, left, right: left + width, bottom: top + height, width, height }) as DOMRect

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

  it('reports the shared Meta CDN hosts', () => {
    expect(instagramAdapter.cdnHosts).toBe(META_CDN_HOSTS)
    expect(instagramAdapter.cdnHosts).toEqual([
      { host: 'cdninstagram.com', includeSubdomains: true },
    ])
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

    // Unknown key, grabbable <img> — DOM fallback routes through the shared
    // resolver, tagged 'instagram'. Full placeholder shape is asserted in
    // meta-shared/dom.test.ts; here we only prove the routing + platform tag.
    expect(instagramAdapter.canResolveHoverItem(img, key, new Map())).toBe(true)
    const resolved = instagramAdapter.resolveHoverItem(img, key, new Map(), '/p/CODE1/')
    expect(resolved).toMatchObject({ id: key, platform: 'instagram', postId: key })

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
    expect(instagramAdapter.resolveHoverItem(img, key, new Map(), '/')).toMatchObject({
      id: key,
      platform: 'instagram',
      postId: key,
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

      describe('Reels immersive player: viewport-dominance gate on the multi-video branch', () => {
        // LIVE-VERIFIED 2026-07-05: Instagram's Reels immersive player
        // (/reels/{code}/) mounts several sibling <video> elements
        // simultaneously (2 observed 2026-07-05, 6-11 observed 2026-07-06),
        // off-screen ones included, with NO <article>/<li> ancestor for any
        // of them — and `location.pathname` reflects only whichever reel is
        // currently scrolled into view. A naive "no <article> -> trust the
        // pathname" fallback resolves EVERY mounted sibling to the SAME post
        // code (the original bug: two distinct sibling videos returned the
        // identical key) — but always refusing the fallback whenever 2+
        // videos are mounted regressed the real reels player entirely, since
        // it ALWAYS has 2+ mounted videos: hover never resolved there at all
        // (the user-reported bug, https://www.instagram.com/reels/DaH4la4pRtC/).
        //
        // The fix: trust the pathname for the multi-video case too, but ONLY
        // for the video that is the viewport-dominant one — strictly the
        // largest on-screen area among every mounted video, with a non-zero
        // area required. `location.pathname` always reflects the reel
        // scrolled into view, so the dominant video is the one the pathname
        // actually describes; an off-screen (zero-area) sibling, or a
        // smaller-area sibling mid-transition, must NOT also claim that same
        // code. An exact area tie is treated as "don't know which one is
        // active" and resolves to null on both sides, rather than guessing.

        it('dominant hovered video (fills the 1024x768 viewport) resolves to post:code:{pathnameCode}, and postCodeFromElement returns the raw code', () => {
          const root = document.createElement('div')
          root.innerHTML = `
            <div><video></video></div>
            <div><video></video></div>`
          const [dominant, offscreen] = [...root.querySelectorAll('video')]
          dominant!.getBoundingClientRect = rect(0, 0, 1024, 768) // full viewport: area 786432
          offscreen!.getBoundingClientRect = rect(-500, -500, 100, 100) // fully off-screen: area 0
          expect(instagramAdapter.postKeyFromVideoElement?.(dominant!, '/reels/CODE_A/')).toBe(
            'post:code:CODE_A',
          )
          expect(instagramAdapter.postCodeFromElement?.(dominant!, '/reels/CODE_A/')).toBe('CODE_A')
        })

        it('non-dominant (smaller-area) sibling resolves to null even though pathname matches', () => {
          const root = document.createElement('div')
          root.innerHTML = `
            <div><video></video></div>
            <div><video></video></div>`
          const [dominant, smaller] = [...root.querySelectorAll('video')]
          dominant!.getBoundingClientRect = rect(0, 0, 1024, 768)
          smaller!.getBoundingClientRect = rect(0, 0, 200, 200) // area 40000, less than dominant
          expect(instagramAdapter.postKeyFromVideoElement?.(smaller!, '/reels/CODE_A/')).toBeNull()
        })

        it('fully off-screen sibling (zero visible area) resolves to null', () => {
          const root = document.createElement('div')
          root.innerHTML = `
            <div><video></video></div>
            <div><video></video></div>`
          const [dominant, offscreen] = [...root.querySelectorAll('video')]
          dominant!.getBoundingClientRect = rect(0, 0, 1024, 768)
          offscreen!.getBoundingClientRect = rect(1000, 1000, 50, 50) // entirely past the 1024x768 viewport
          expect(
            instagramAdapter.postKeyFromVideoElement?.(offscreen!, '/reels/CODE_A/'),
          ).toBeNull()
        })

        it('exact-tie visible areas resolve to null for BOTH videos (mid-transition, cannot tell which is active)', () => {
          const root = document.createElement('div')
          root.innerHTML = `
            <div><video></video></div>
            <div><video></video></div>`
          const [video1, video2] = [...root.querySelectorAll('video')]
          video1!.getBoundingClientRect = rect(0, 0, 500, 500)
          video2!.getBoundingClientRect = rect(0, 0, 500, 500) // identical area — a tie
          expect(instagramAdapter.postKeyFromVideoElement?.(video1!, '/reels/CODE_A/')).toBeNull()
          expect(instagramAdapter.postKeyFromVideoElement?.(video2!, '/reels/CODE_A/')).toBeNull()
        })

        it('happy-dom default (unstubbed) rects are all-zero for every video, so hover resolves to null deterministically', () => {
          // Covers the real getBoundingClientRect wiring (no stubbing at all):
          // happy-dom computes no layout, so every video's rect area is 0,
          // which correctly fails the "> 0" dominance requirement.
          const root = document.createElement('div')
          root.innerHTML = `
            <div><video></video></div>
            <div><video></video></div>`
          const [video1, video2] = [...root.querySelectorAll('video')]
          expect(instagramAdapter.postKeyFromVideoElement?.(video1!, '/reels/CODE_A/')).toBeNull()
          expect(instagramAdapter.postKeyFromVideoElement?.(video2!, '/reels/CODE_A/')).toBeNull()
        })

        it('3+ mounted videos: only the single strictly-largest one is dominant', () => {
          const root = document.createElement('div')
          root.innerHTML = `
            <div><video></video></div>
            <div><video></video></div>
            <div><video></video></div>`
          const [v1, v2, v3] = [...root.querySelectorAll('video')]
          v1!.getBoundingClientRect = rect(0, 0, 100, 100) // area 10000
          v2!.getBoundingClientRect = rect(0, 0, 1024, 768) // area 786432 — dominant
          v3!.getBoundingClientRect = rect(0, 0, 300, 300) // area 90000
          expect(instagramAdapter.postKeyFromVideoElement?.(v1!, '/reels/CODE_B/')).toBeNull()
          expect(instagramAdapter.postKeyFromVideoElement?.(v2!, '/reels/CODE_B/')).toBe(
            'post:code:CODE_B',
          )
          expect(instagramAdapter.postKeyFromVideoElement?.(v3!, '/reels/CODE_B/')).toBeNull()
        })
      })
    })
  })

  describe('permalink page (no <article>): hero content vs suggested-content thumbnails', () => {
    // LIVE-VERIFIED 2026-08-23 (logged-in Chrome, CDP) against two real
    // permalink pages, instagram.com/p/DcGBaq9AKSa/ (photo carousel) and
    // instagram.com/p/DcXoDCCMd6H/ (single video). A permalink page has ZERO
    // <article> elements, so `postIdFromDom` falls past its container branch.
    // Two facts observed on both pages:
    //
    //   1. Every "More posts from {author}" thumbnail is an <img> wrapped in
    //      its OWN post's link, in the profile-prefixed form
    //      `/{username}/p/{code}/` (or `/{username}/reel/{code}/`) — a shape
    //      INSTAGRAM_POST_LINK_PATTERN's `^/p/` anchor does not match.
    //   2. The page's own hero media carries NO ancestor post link at all.
    //
    // Those two facts are what separates "this element belongs to the page's
    // own post" from "this element is a different post rendered on the page",
    // and the pathname fallback must respect the distinction.
    it('a suggested thumbnail resolves to ITS OWN post code, never the page pathname (6/6 mis-attributed live, hero code returned for other posts)', () => {
      // Before the fix, with exactly one <video> mounted (an everyday
      // single-video permalink) this returned the PAGE's code, so a whole-post
      // grab on a suggested thumbnail queued the hero post's media instead —
      // a silent wrong-content download, worse than doing nothing.
      const root = document.createElement('div')
      root.innerHTML = `
        <div><video></video></div>
        <a href="/code.architects/p/OTHERCODE/"><img src="https://scontent.cdninstagram.com/v/t51.82787-15/thumb.jpg" /></a>`
      const img = root.querySelector('img')!
      expect(instagramAdapter.postCodeFromElement?.(img, '/p/PAGECODE/')).toBe('OTHERCODE')
    })

    it('a suggested REEL thumbnail resolves to its own reel code', () => {
      const root = document.createElement('div')
      root.innerHTML = `
        <div><video></video></div>
        <a href="/code.architects/reel/REELCODE/"><img src="https://scontent.cdninstagram.com/v/t51.82787-15/thumb.jpg" /></a>`
      const img = root.querySelector('img')!
      expect(instagramAdapter.postCodeFromElement?.(img, '/p/PAGECODE/')).toBe('REELCODE')
    })

    it('a suggested thumbnail is still attributed to its own post when NO video is mounted', () => {
      const root = document.createElement('div')
      root.innerHTML = `<a href="/code.architects/p/OTHERCODE/"><img src="https://scontent.cdninstagram.com/v/t51.82787-15/thumb.jpg" /></a>`
      const img = root.querySelector('img')!
      expect(instagramAdapter.postCodeFromElement?.(img, '/p/PAGECODE/')).toBe('OTHERCODE')
    })

    it('an /reels/audio/{id}/ ancestor link is not read as a post code (same reserved segment postCodeFromPathname rejects)', () => {
      const root = document.createElement('div')
      root.innerHTML = `<a href="/reels/audio/27270650159276600/"><img src="https://scontent.cdninstagram.com/v/t51.82787-15/thumb.jpg" /></a>`
      const img = root.querySelector('img')!
      // No own post link ⇒ falls through to the page's own pathname, which is
      // the correct answer for hero content, never the bogus code "audio".
      expect(instagramAdapter.postCodeFromElement?.(img, '/p/PAGECODE/')).toBe('PAGECODE')
    })

    it('an ancestor link that is NOT a post link (an author-profile link) does not block the pathname fallback', () => {
      // Hero media is commonly wrapped in the author's own profile link. That
      // names no post, so it must not be mistaken for an own-post link and must
      // not suppress the permalink pathname the hero legitimately belongs to.
      const root = document.createElement('div')
      root.innerHTML = `<a href="/code.architects/"><img src="https://scontent.cdninstagram.com/v/t51.82787-15/hero.jpg" /></a>`
      const img = root.querySelector('img')!
      expect(instagramAdapter.postCodeFromElement?.(img, '/p/PAGECODE/')).toBe('PAGECODE')
    })

    it('a hero photo with NO videos mounted resolves to the pathname code (the reported "Alt works, Cmd+Alt does nothing" case)', () => {
      // LIVE-VERIFIED 2026-08-23: 7/7 photos on instagram.com/p/DcGBaq9AKSa/
      // resolved to no post code at all, so single-item Quick Grab downloaded
      // the photo while whole-post grab returned an empty payload and silently
      // did nothing. A photo has nothing to disambiguate — the permalink
      // pathname names its post unambiguously.
      const root = document.createElement('div')
      root.innerHTML = `<div><img src="https://scontent.cdninstagram.com/v/t51.82787-15/hero.jpg" /></div>`
      const img = root.querySelector('img')!
      expect(instagramAdapter.postCodeFromElement?.(img, '/p/PAGECODE/')).toBe('PAGECODE')
    })

    it('a hero photo resolves to the pathname code regardless of how many videos are mounted', () => {
      // The video-count gate exists to disambiguate WHICH of several mounted
      // videos the reels player is showing. It has no meaning for a photo, and
      // gating a photo on it made whole-post grab depend on an unrelated
      // element: live, injecting one empty off-screen <video> flipped a
      // carousel from 0 resolved items to all 8, and a second broke it again.
      for (const videos of [0, 1, 2, 5]) {
        const root = document.createElement('div')
        root.innerHTML = `${'<div><video></video></div>'.repeat(videos)}<div><img src="https://scontent.cdninstagram.com/v/t51.82787-15/hero.jpg" /></div>`
        const img = root.querySelector('img')!
        expect(instagramAdapter.postCodeFromElement?.(img, '/p/PAGECODE/')).toBe('PAGECODE')
      }
    })

    it('a hero photo on a non-permalink pathname still resolves to null', () => {
      const root = document.createElement('div')
      root.innerHTML = `<div><img src="https://scontent.cdninstagram.com/v/t51.82787-15/hero.jpg" /></div>`
      const img = root.querySelector('img')!
      expect(instagramAdapter.postCodeFromElement?.(img, '/')).toBeNull()
    })

    it('an <article> ancestor still wins over both the own-link and the pathname (feed behaviour unchanged)', () => {
      const root = document.createElement('div')
      root.innerHTML = `<article><a href="/p/ARTICLECODE/">link</a><a href="/someone/p/OTHERCODE/"><img src="https://scontent.cdninstagram.com/v/t51.82787-15/x.jpg" /></a></article>`
      const img = root.querySelector('img')!
      expect(instagramAdapter.postCodeFromElement?.(img, '/p/PAGECODE/')).toBe('ARTICLECODE')
    })

    it('a hero VIDEO keeps the viewport-dominance gate (multi-video reels player unchanged)', () => {
      const root = document.createElement('div')
      root.innerHTML = `
        <div><video></video></div>
        <div><video></video></div>`
      const [dominant, smaller] = [...root.querySelectorAll('video')]
      dominant!.getBoundingClientRect = rect(0, 0, 1024, 768)
      smaller!.getBoundingClientRect = rect(0, 0, 200, 200)
      expect(instagramAdapter.postCodeFromElement?.(dominant!, '/reels/CODE_A/')).toBe('CODE_A')
      expect(instagramAdapter.postCodeFromElement?.(smaller!, '/reels/CODE_A/')).toBeNull()
    })
  })

  describe('postCodeFromPathname: /reels/audio/ hardening', () => {
    // LIVE-OBSERVED: instagram.com/reels/audio/{id}/ is a real, distinct page
    // (an audio-track's own reels listing) whose pathname shape otherwise
    // matches INSTAGRAM_PERMALINK_PATTERN, which would wrongly capture the
    // reserved literal segment "audio" as if it were a post code.
    it('returns null for a /reels/audio/{id}/ pathname instead of the bogus code "audio"', () => {
      expect(postCodeFromPathname('/reels/audio/27720128614248805/')).toBeNull()
    })

    it('still resolves a real reel code that is not the reserved "audio" segment', () => {
      expect(postCodeFromPathname('/reels/DaH4la4pRtC/')).toBe('DaH4la4pRtC')
    })
  })

  describe('visibleAreaInViewport', () => {
    it('returns the full rect area when the rect is entirely inside the viewport', () => {
      expect(
        visibleAreaInViewport(
          { top: 0, left: 0, right: 100, bottom: 50 },
          { width: 1024, height: 768 },
        ),
      ).toBe(5000)
    })

    it('clips a rect that overflows the viewport on the right/bottom', () => {
      expect(
        visibleAreaInViewport(
          { top: 700, left: 1000, right: 1100, bottom: 800 },
          { width: 1024, height: 768 },
        ),
      ).toBe(24 * 68) // clipped to [1000,1024) x [700,768)
    })

    it('returns 0 for a rect entirely off-screen to the top/left (negative coordinates)', () => {
      expect(
        visibleAreaInViewport(
          { top: -100, left: -100, right: -10, bottom: -10 },
          { width: 1024, height: 768 },
        ),
      ).toBe(0)
    })

    it('returns 0 for a rect entirely past the viewport bounds', () => {
      expect(
        visibleAreaInViewport(
          { top: 1000, left: 1000, right: 1100, bottom: 1100 },
          { width: 1024, height: 768 },
        ),
      ).toBe(0)
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

const makeInstagramNavPost = (inner: string): HTMLElement => {
  const el = document.createElement('article')
  el.innerHTML = inner
  return el
}

describe('instagramAdapter.nav descriptor', () => {
  it('exposes the platform post selector', () => {
    expect(instagramAdapter.nav?.postSelector).toBe('article')
  })

  it('permalinkOf returns the /p/ permalink anchor, or null', () => {
    const post = makeInstagramNavPost('<a href="/p/ABC123/">2h</a>')
    expect(instagramAdapter.nav?.permalinkOf(post)?.getAttribute('href')).toBe('/p/ABC123/')
    expect(
      instagramAdapter.nav?.permalinkOf(makeInstagramNavPost('<a href="/explore">x</a>')),
    ).toBeNull()
  })

  it('actionControl finds like/comment/repost controls by aria-label', () => {
    const post = makeInstagramNavPost(
      '<span aria-label="Like"></span><span aria-label="Comment"></span><span aria-label="Repost"></span>',
    )
    expect(instagramAdapter.nav?.actionControl(post, 'like')?.getAttribute('aria-label')).toBe(
      'Like',
    )
    expect(instagramAdapter.nav?.actionControl(post, 'reply')?.getAttribute('aria-label')).toBe(
      'Comment',
    )
    expect(instagramAdapter.nav?.actionControl(post, 'repost')?.getAttribute('aria-label')).toBe(
      'Repost',
    )
    expect(instagramAdapter.nav?.actionControl(makeInstagramNavPost(''), 'reply')).toBeNull()
  })

  it('actionFlipped confirms like via Unlike and repost via Remove repost', () => {
    const nav = instagramAdapter.nav!
    expect(
      nav.actionFlipped(makeInstagramNavPost('<span aria-label="Unlike"></span>'), 'like'),
    ).toBe(true)
    expect(nav.actionFlipped(makeInstagramNavPost('<span aria-label="Like"></span>'), 'like')).toBe(
      false,
    )
    expect(
      nav.actionFlipped(makeInstagramNavPost('<span aria-label="Remove repost"></span>'), 'repost'),
    ).toBe(true)
    expect(
      nav.actionFlipped(makeInstagramNavPost('<span aria-label="Repost"></span>'), 'repost'),
    ).toBe(false)
  })

  it('replyComposerOpen detects the dialog composer', () => {
    document.body.innerHTML = ''
    expect(instagramAdapter.nav?.replyComposerOpen()).toBe(false)
    document.body.innerHTML = '<div role="dialog"><div contenteditable="true"></div></div>'
    expect(instagramAdapter.nav?.replyComposerOpen()).toBe(true)
    document.body.innerHTML = ''
  })

  it('carouselControls resolves prev/next buttons when present', () => {
    const post = makeInstagramNavPost(
      '<button aria-label="Go back"></button><button aria-label="Next"></button>',
    )
    expect(instagramAdapter.nav?.carouselControls?.(post).prev?.getAttribute('aria-label')).toBe(
      'Go back',
    )
    expect(instagramAdapter.nav?.carouselControls?.(makeInstagramNavPost('')).prev).toBeNull()
  })
})

describe('instagramAdapter — production build (DEV logging compiled out)', () => {
  // Same shape as the Threads adapter: the debug logging lives inside the
  // resolvers, so DEV is a live branch in each. Vitest runs DEV=true, leaving
  // the shipped arm unexercised — these pin that turning it off changes
  // nothing but the console.
  beforeEach(() => vi.stubEnv('DEV', false))
  afterEach(() => vi.unstubAllEnvs())

  const item = {
    id: 'k1',
    platform: 'instagram' as const,
    postId: '1',
    author: 'a',
    type: 'photo' as const,
    url: 'https://cdn.example/k1.jpg',
    ext: 'jpg',
    index: 0,
  }

  it('resolveHoverItem returns the same tee hit / DOM fallback / miss', () => {
    const detected = new Map([['k1', item]])
    expect(
      instagramAdapter.resolveHoverItem(document.createElement('div'), 'k1', detected, '/'),
    ).toEqual(item)

    const img = document.createElement('img')
    img.src = 'https://scontent.cdninstagram.com/v/t51.2885-15/x.jpg'
    expect(instagramAdapter.resolveHoverItem(img, 'miss', new Map(), '/')).toEqual(
      resolveMetaImageElement(img, 'instagram'),
    )
    expect(
      instagramAdapter.resolveHoverItem(document.createElement('div'), 'miss', new Map(), '/'),
    ).toBeNull()
  })

  it('postKeyFromVideoElement returns the same null / single-media / carousel keys', () => {
    const bare = document.createElement('div')
    bare.innerHTML = `<div><video></video></div>`
    expect(instagramAdapter.postKeyFromVideoElement?.(bare.querySelector('video')!, '/')).toBeNull()

    const single = document.createElement('div')
    single.innerHTML = `<article><a href="/p/CODE1/">link</a><div><video></video></div></article>`
    expect(instagramAdapter.postKeyFromVideoElement?.(single.querySelector('video')!, '/')).toBe(
      'post:code:CODE1',
    )

    const carousel = document.createElement('div')
    carousel.innerHTML = `
      <article><a href="/p/CODE2/">link</a>
        <ul>
          <li><video></video></li>
          <li><img /></li>
          <li></li>
        </ul>
      </article>`
    expect(instagramAdapter.postKeyFromVideoElement?.(carousel.querySelector('video')!, '/')).toBe(
      'post:code:CODE2:0',
    )
  })
})
