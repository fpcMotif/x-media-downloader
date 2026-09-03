import { describe, it, expect, vi } from 'vitest'
import type { PlatformAdapter } from '../../core/adapters/types'
import { instagramAdapter } from '../../core/adapters/instagram/adapter'
import { threadsAdapter } from '../../core/adapters/threads/adapter'
import { makeDetectionStore } from '../../core/adapters/detection-store'
import { mediaKeyFromUrl } from '../../core/adapters/x/dom'
import type { MediaItem, JsonObject } from '@/packages/schema'
import {
  fireCurrentPost,
  wholePostItemsFor,
  POST_GRAB_FLASH_MS,
  type GrabUiState,
  type PostGrabDeps,
} from './post-grab'

/** twimg URLs so mediaKeyFromUrl yields a real key (final path segment, no ext). */
const photo = (id: string, key: string, tweetId = 't1'): MediaItem => ({
  id,
  platform: 'x',
  postId: tweetId,
  author: 'alice',
  type: 'photo',
  url: `https://pbs.twimg.com/media/${key}.jpg?name=orig`,
  previewUrl: `https://pbs.twimg.com/media/${key}.jpg`,
  ext: 'jpg',
  index: 0,
})

const adapter = (over: Partial<PlatformAdapter> = {}): PlatformAdapter => ({
  platform: 'x',
  hostMatch: [],
  cdnHosts: [],
  matchesUrl: () => true,
  mediaKeyFromUrl,
  isTrackedResponseUrl: () => false,
  detectFromResponse: () => [],
  detectRenderedMedia: () => [],
  resolveHoverItem: () => null,
  canResolveHoverItem: () => false,
  ...over,
})

const RECT = { top: 1, left: 2, width: 30, height: 40 }

const makeDeps = (over: Partial<PostGrabDeps> = {}) => {
  const store = makeDetectionStore({ mediaKeyFromUrl })
  const sent: MediaItem[][] = []
  const marked: string[] = []
  let ui: GrabUiState | null = null
  const deps: PostGrabDeps = {
    adapter: adapter(),
    store,
    doc: document,
    pathname: () => '/home',
    hovered: () => null,
    focusedArticle: () => null,
    tweetIdFromArticle: () => null,
    send: (items) => {
      sent.push([...items])
      return Promise.resolve(true)
    },
    setUi: (next) => {
      ui = next
    },
    getUi: () => ui,
    markGrabbed: (keys) => {
      for (const key of keys) if (!marked.includes(key)) marked.push(key)
    },
    markWholePostGrabbed: (previewKey, keys) => {
      for (const key of [previewKey, ...keys]) if (!marked.includes(key)) marked.push(key)
    },
    rectOf: () => RECT,
    ...over,
  }
  return { deps, store, sent, marked, ui: () => ui }
}
const makeMetaDeps = (
  platformAdapter: PlatformAdapter,
  over: Partial<PostGrabDeps> = {},
): ReturnType<typeof makeDeps> => {
  const result = makeDeps({
    ...over,
    adapter: platformAdapter,
    store: makeDetectionStore({ mediaKeyFromUrl: platformAdapter.mediaKeyFromUrl }),
  })
  return { ...result, store: result.deps.store }
}

const seedMetaPost = (
  deps: PostGrabDeps,
  platformAdapter: PlatformAdapter,
  responseUrl: string,
  response: JsonObject,
): MediaItem[] => {
  const items = platformAdapter.detectFromResponse(responseUrl, response)
  deps.store.addDetected(items)
  for (const [postId, code] of platformAdapter.extractPostCodes?.(response) ?? []) {
    deps.store.registerPostCode(postId, code)
  }
  return items
}

const articleWithMedia = (): Element => {
  const root = document.createElement('div')
  root.innerHTML = `<article data-testid="tweet"><img src="https://pbs.twimg.com/media/KA.jpg" /></article>`
  return root.querySelector('article')!
}

/** Await one microtask turn so an immediately-resolved send settles. */
const settle = (): Promise<void> => Promise.resolve()

describe('wholePostItemsFor', () => {
  it('resolves the tee’s full post through the DOM shortcode', () => {
    const { deps, store } = makeDeps({
      adapter: adapter({ postCodeFromElement: () => 'CODE1' }),
    })
    const a = photo('a', 'KA', 'pk1')
    const b = photo('b', 'KB', 'pk1')
    store.addDetected([a, b])
    store.registerPostCode('pk1', 'CODE1')
    const hovered = photo('h', 'KH', 'hover-self')
    expect(wholePostItemsFor(deps, document.createElement('img'), hovered)).toEqual([a, b])
  })

  it('falls back to the hovered item unioned with its own post when unlinked', () => {
    const { deps, store } = makeDeps()
    const a = photo('a', 'KA', 't1')
    const b = photo('b', 'KB', 't1')
    store.addDetected([a, b])
    expect(wholePostItemsFor(deps, document.createElement('img'), a).map((i) => i.id)).toEqual([
      'a',
      'b',
    ])
    // Tee saw nothing of the post: at least the hovered item.
    expect(
      wholePostItemsFor(deps, document.createElement('img'), photo('solo', 'KS', 't9')),
    ).toEqual([photo('solo', 'KS', 't9')])
  })

  it('reports which link broke when it falls back, and stays quiet when it does not', () => {
    const onWholePostFallback = vi.fn<(info: { item: MediaItem; code: string | null }) => void>()
    const a = photo('a', 'KA', 'pk1')
    const hovered = photo('h', 'KH', 'hover-self')

    // No shortcode from the DOM at all — the post-anchor selector missed.
    const noCode = makeDeps({ onWholePostFallback })
    wholePostItemsFor(noCode.deps, document.createElement('img'), hovered)
    expect(onWholePostFallback).toHaveBeenCalledWith({ item: hovered, code: null })

    // A shortcode the tee hasn't registered yet — postCodeFromElement raced ahead.
    onWholePostFallback.mockClear()
    const unregistered = makeDeps({
      adapter: adapter({ postCodeFromElement: () => 'CODE1' }),
      onWholePostFallback,
    })
    wholePostItemsFor(unregistered.deps, document.createElement('img'), hovered)
    expect(onWholePostFallback).toHaveBeenCalledWith({ item: hovered, code: 'CODE1' })

    // Chain intact: the whole post resolved, so there is nothing to report.
    onWholePostFallback.mockClear()
    const linked = makeDeps({
      adapter: adapter({ postCodeFromElement: () => 'CODE1' }),
      onWholePostFallback,
    })
    linked.store.addDetected([a])
    linked.store.registerPostCode('pk1', 'CODE1')
    expect(wholePostItemsFor(linked.deps, document.createElement('img'), hovered)).toEqual([a])
    expect(onWholePostFallback).not.toHaveBeenCalled()
  })
})

describe('fireCurrentPost — hover target', () => {
  const hoverItem = (item: MediaItem): Pick<PostGrabDeps, 'adapter' | 'hovered'> => ({
    adapter: adapter({ resolveHoverItem: () => item }),
    hovered: () => ({ media: document.createElement('img'), key: 'KA' }),
  })

  it('sends the whole post, shows queued → saved, then self-clears after the flash', async () => {
    vi.useFakeTimers()
    const a = photo('a', 'KA', 't1')
    const b = photo('b', 'KB', 't1')
    const { deps, store, sent, marked, ui } = makeDeps(hoverItem(a))
    store.addDetected([a, b])

    fireCurrentPost(deps)
    expect(sent).toEqual([[a, b]])
    expect(ui()).toEqual({ key: 'dd:t1', rect: RECT, phase: 'queued', all: true, allCount: 2 })
    expect(marked.toSorted()).toEqual(['KA', 'KB'])

    await settle()
    expect(ui()?.phase).toBe('saved')
    vi.advanceTimersByTime(POST_GRAB_FLASH_MS)
    expect(ui()).toBeNull()
    vi.useRealTimers()
  })

  it('marks a distinct rendered preview key with a Meta whole-post payload', () => {
    const media = document.createElement('img')
    const item = { ...photo('original', 'ORIGINAL-A', 'post-a'), platform: 'threads' as const }
    const markWholePostGrabbed = vi.fn<(previewKey: string, postKeys: Iterable<string>) => void>()
    const { deps, marked, sent, store } = makeDeps({
      adapter: adapter({
        platform: 'threads',
        postCodeFromElement: () => 'CODE-A',
        resolveHoverItem: () => item,
      }),
      cursorHovered: () => ({ media, key: 'PREVIEW' }),
    })
    store.addDetected([item])
    store.registerPostCode('post-a', 'CODE-A')
    const depsWithPreviewMark = { ...deps, markWholePostGrabbed }

    fireCurrentPost(depsWithPreviewMark)

    expect(markWholePostGrabbed).toHaveBeenCalledWith('PREVIEW', ['ORIGINAL-A'])
    expect(marked).toEqual([])
    expect(sent).toEqual([[item]])
  })

  it('shows failed and still self-clears when the send fails', async () => {
    vi.useFakeTimers()
    const a = photo('a', 'KA', 't1')
    const { deps, ui } = makeDeps({ ...hoverItem(a), send: () => Promise.resolve(false) })
    fireCurrentPost(deps)
    await settle()
    expect(ui()?.phase).toBe('failed')
    vi.advanceTimersByTime(POST_GRAB_FLASH_MS)
    expect(ui()).toBeNull()
    vi.useRealTimers()
  })

  it('does nothing when the hover resolves to no item', () => {
    const { deps, sent, ui } = makeDeps({
      hovered: () => ({ media: document.createElement('img'), key: 'ghost' }),
    })
    fireCurrentPost(deps)
    expect(sent).toEqual([])
    expect(ui()).toBeNull()
  })

  it('hover wins over the focused article', () => {
    const a = photo('a', 'KA', 't1')
    const tweetIdFromArticle = vi.fn<() => string>(() => 't9')
    const focusedArticle = vi.fn<() => Element>(() => articleWithMedia())
    const { deps, sent } = makeDeps({ ...hoverItem(a), tweetIdFromArticle, focusedArticle })
    fireCurrentPost(deps)
    expect(sent).toEqual([[a]])
    expect(tweetIdFromArticle).not.toHaveBeenCalled()
  })
})

describe('fireCurrentPost — X cursor target', () => {
  const cursorDeps = (over: Partial<PostGrabDeps> = {}): ReturnType<typeof makeDeps> =>
    makeDeps({
      focusedArticle: () => articleWithMedia(),
      tweetIdFromArticle: () => 't1',
      ...over,
    })

  it('sends the store’s items for the focused tweet', () => {
    const a = photo('a', 'KA', 't1')
    const b = photo('b', 'KB', 't1')
    const { deps, store, sent, ui } = cursorDeps()
    store.addDetected([a, b])
    fireCurrentPost(deps)
    expect(sent).toEqual([[a, b]])
    expect(ui()).toMatchObject({ key: 'dd:t1', phase: 'queued', all: true, allCount: 2 })
  })

  it('falls back to an article-scoped DOM scan when the tee missed the post', () => {
    const scanned = photo('dom', 'KD', 't1')
    const detectRenderedMedia = vi.fn<() => MediaItem[]>(() => [scanned])
    const { deps, sent } = cursorDeps({ adapter: adapter({ detectRenderedMedia }) })
    fireCurrentPost(deps)
    expect(detectRenderedMedia).toHaveBeenCalledWith(expect.any(Element), '/home')
    expect(sent).toEqual([[scanned]])
  })

  it('a video-only tee miss is a quiet no-op: no scan rescue, no send, no ring', () => {
    const { deps, sent, ui } = cursorDeps()
    fireCurrentPost(deps) // store empty, detectRenderedMedia default [] — nothing provable.
    expect(sent).toEqual([])
    expect(ui()).toBeNull()
  })

  it('no focused article or no tweet id means no-op', () => {
    const noArticle = makeDeps({ focusedArticle: () => null, tweetIdFromArticle: () => 't1' })
    fireCurrentPost(noArticle.deps)
    expect(noArticle.sent).toEqual([])
    const noId = makeDeps()
    fireCurrentPost(noId.deps)
    expect(noId.sent).toEqual([])
  })

  it('never consults the cursor path off X', () => {
    const focusedArticle = vi.fn<() => Element>(() => articleWithMedia())
    const { deps, sent, ui } = makeDeps({
      adapter: adapter({ platform: 'instagram' }),
      focusedArticle,
    })
    fireCurrentPost(deps)
    expect(focusedArticle).not.toHaveBeenCalled()
    expect(sent).toEqual([])
    expect(ui()).toBeNull()
  })
})

describe('fireCurrentPost — Threads/IG cursor fallback', () => {
  const cursorItem = (item: MediaItem): Partial<PostGrabDeps> => ({
    adapter: adapter({ platform: 'threads', resolveHoverItem: () => item }),
    hovered: () => null, // no Quick Grab modifier held
    cursorHovered: () => ({ media: document.createElement('img'), key: 'KH' }),
  })

  it('resolves the whole post via cursorHovered when no modifier is held', async () => {
    vi.useFakeTimers()
    const a = photo('a', 'KA', 't1')
    const b = photo('b', 'KB', 't1')
    const { deps, store, sent, marked, ui } = makeDeps(cursorItem(a))
    store.addDetected([a, b])

    fireCurrentPost(deps)
    expect(sent).toEqual([[a, b]])
    expect(ui()).toEqual({ key: 'dd:t1', rect: RECT, phase: 'queued', all: true, allCount: 2 })
    expect(marked.toSorted()).toEqual(['KA', 'KB', 'KH'])

    await settle()
    expect(ui()?.phase).toBe('saved')
    vi.advanceTimersByTime(POST_GRAB_FLASH_MS)
    expect(ui()).toBeNull()
    vi.useRealTimers()
  })

  it.each(['instagram', 'threads'] as const)(
    'does not queue a lone DOM fallback when the %s post code is unregistered',
    (platform) => {
      const item = { ...photo('fallback', 'KH', 'placeholder'), platform }
      const onWholePostFallback = vi.fn<(info: { item: MediaItem; code: string | null }) => void>()
      const { deps, marked, sent, ui } = makeDeps({
        adapter: adapter({
          platform,
          postCodeFromElement: () => 'CODE-A',
          resolveHoverItem: () => item,
        }),
        cursorHovered: () => ({ media: document.createElement('img'), key: 'KH' }),
        onWholePostFallback,
      })

      fireCurrentPost(deps)

      expect(onWholePostFallback).toHaveBeenCalledWith({ item, code: 'CODE-A' })
      expect(sent).toEqual([])
      expect(marked).toEqual([])
      expect(ui()).toBeNull()
    },
  )

  it('invalidates a recycled retained focus before allowing a later fresh pointer fallback', () => {
    const media = document.createElement('img')
    media.dataset.postCode = 'CODE-B'
    const item = { ...photo('b', 'KB', 'post-b'), platform: 'threads' as const }
    const cursorHovered = vi.fn<() => { media: HTMLImageElement; key: string }>(() => ({
      media,
      key: 'KB',
    }))
    let focusedPost: { postCode: string } | null = { postCode: 'CODE-A' }
    const clearFocusedPost = vi.fn<() => void>(() => {
      focusedPost = null
    })
    const { deps, store, sent, marked, ui } = makeDeps({
      adapter: adapter({
        platform: 'threads',
        postCodeFromElement: (el) => el.getAttribute('data-post-code'),
        resolveHoverItem: () => item,
      }),
      hovered: () => ({ media, key: 'KB' }),
      cursorHovered,
    })
    store.addDetected([item])
    store.registerPostCode('post-b', 'CODE-B')
    const depsWithRetainedFocus = {
      ...deps,
      focusedPost: () => focusedPost,
      clearFocusedPost,
    }

    fireCurrentPost(depsWithRetainedFocus)

    expect(cursorHovered).toHaveBeenCalledOnce()
    expect(clearFocusedPost).toHaveBeenCalledOnce()
    expect(sent).toEqual([])
    expect(marked).toEqual([])
    expect(ui()).toBeNull()

    fireCurrentPost(depsWithRetainedFocus)

    expect(cursorHovered).toHaveBeenCalledTimes(2)
    expect(sent).toEqual([[item]])
    expect(marked).toEqual(['KB'])
    expect(ui()).toMatchObject({ key: 'dd:post-b', phase: 'queued', allCount: 1 })
  })
  it.each(['instagram', 'threads'] as const)(
    'clears an unresolved retained %s focus before a later fresh pointer fallback',
    (platform) => {
      const mediaA = document.createElement('img')
      mediaA.dataset.postCode = 'CODE-A'
      const mediaB = document.createElement('img')
      mediaB.dataset.postCode = 'CODE-B'
      const itemB = { ...photo('b', 'KB', 'post-b'), platform }
      let cursor = { media: mediaA, key: 'KA' } satisfies { media: HTMLImageElement; key: string }
      const cursorHovered = vi.fn<() => { media: HTMLImageElement; key: string }>(() => cursor)
      let focusedPost: { postCode: string } | null = { postCode: 'CODE-A' }
      const clearFocusedPost = vi.fn<() => void>(() => {
        focusedPost = null
      })
      const { deps, store, sent, marked, ui } = makeDeps({
        adapter: adapter({
          platform,
          postCodeFromElement: (el) => el.getAttribute('data-post-code'),
          resolveHoverItem: (_media, key) => (key === 'KB' ? itemB : null),
        }),
        hovered: () => null,
        cursorHovered,
      })
      store.addDetected([itemB])
      store.registerPostCode('post-b', 'CODE-B')
      const depsWithRetainedFocus = {
        ...deps,
        focusedPost: () => focusedPost,
        clearFocusedPost,
      }

      fireCurrentPost(depsWithRetainedFocus)

      expect(sent).toEqual([])
      expect(ui()).toBeNull()
      expect(marked).toEqual([])
      expect(clearFocusedPost).toHaveBeenCalledTimes(1)

      cursor = { media: mediaB, key: 'KB' } satisfies { media: HTMLImageElement; key: string }
      fireCurrentPost(depsWithRetainedFocus)

      expect(sent).toEqual([[itemB]])
      expect(marked).toEqual(['KB'])
      expect(ui()).toMatchObject({
        key: 'dd:post-b',
        phase: 'queued',
        all: true,
        allCount: 1,
      })
      expect(clearFocusedPost).toHaveBeenCalledTimes(1)
    },
  )

  it.each(['instagram', 'threads'] as const)(
    'uses the revalidated %s focus instead of a cached hover target',
    (platform) => {
      const focusedMedia = document.createElement('img')
      focusedMedia.dataset.postCode = 'CODE-A'
      const cachedMedia = document.createElement('img')
      cachedMedia.dataset.postCode = 'CODE-B'
      const a = { ...photo('a', 'KA', 'post-a'), platform }
      const a2 = { ...photo('a2', 'KA2', 'post-a'), platform }
      const b = { ...photo('b', 'KB', 'post-b'), platform }
      const hovered = vi.fn<() => { media: HTMLImageElement; key: string }>(() => ({
        media: cachedMedia,
        key: 'KB',
      }))
      const cursorHovered = vi.fn<() => { media: HTMLImageElement; key: string }>(() => ({
        media: focusedMedia,
        key: 'KA',
      }))
      const { deps, store, sent, ui } = makeDeps({
        adapter: adapter({
          platform,
          postCodeFromElement: (el) => el.getAttribute('data-post-code'),
          resolveHoverItem: (_media, key) => (key === 'KA' ? a : b),
        }),
        hovered,
        cursorHovered,
      })
      store.addDetected([a, a2, b])
      store.registerPostCode('post-a', 'CODE-A')
      store.registerPostCode('post-b', 'CODE-B')
      const depsWithRetainedFocus = {
        ...deps,
        focusedPost: () => ({ postCode: 'CODE-A' }),
      }

      fireCurrentPost(depsWithRetainedFocus)

      expect(cursorHovered).toHaveBeenCalledOnce()
      expect(hovered).not.toHaveBeenCalled()
      expect(sent).toEqual([[a, a2]])
      expect(ui()).toMatchObject({ key: 'dd:post-a', phase: 'queued', allCount: 2 })
    },
  )

  it('is a quiet no-op when cursorHovered also returns null', () => {
    const { deps, sent, ui } = makeDeps({
      adapter: adapter({ platform: 'threads' }),
      hovered: () => null,
      cursorHovered: () => null,
    })
    fireCurrentPost(deps)
    expect(sent).toEqual([])
    expect(ui()).toBeNull()
  })

  it('is a quiet no-op when cursorHovered resolves to no item', () => {
    const { deps, sent, ui } = makeDeps({
      adapter: adapter({ platform: 'threads', resolveHoverItem: () => null }),
      hovered: () => null,
      cursorHovered: () => ({ media: document.createElement('img'), key: 'ghost' }),
    })
    fireCurrentPost(deps)
    expect(sent).toEqual([])
    expect(ui()).toBeNull()
  })

  it('does not consult cursorHovered on X (j/k fallback owns that path)', () => {
    const cursorHovered = vi.fn<() => { media: HTMLImageElement; key: string }>(() => ({
      media: document.createElement('img'),
      key: 'KH',
    }))
    const focusedArticle = vi.fn<() => Element>(() => articleWithMedia())
    const { deps } = makeDeps({
      adapter: adapter({ platform: 'x' }),
      hovered: () => null,
      cursorHovered,
      focusedArticle,
      tweetIdFromArticle: () => 't1',
    })
    fireCurrentPost(deps)
    expect(cursorHovered).not.toHaveBeenCalled()
  })
  const instagramPreviewA =
    'https://scontent-lga3-2.cdninstagram.com/v/t51.82787-15/IG_A_preview_n.jpg?stp=dst-jpg_e35_p320x320'
  const instagramOriginalA =
    'https://scontent-lga3-2.cdninstagram.com/v/t51.82787-15/IG_A_n.jpg?stp=dst-jpg_e35_p1080x1080'
  const instagramOriginalB =
    'https://scontent-lga3-2.cdninstagram.com/v/t51.82787-15/IG_B_n.jpg?stp=dst-jpg_e35_p1080x1350'
  const threadsPreviewA =
    'https://scontent.cdninstagram.com/v/t51.82787-15/TH_A_preview_n.jpg?stp=dst-jpg_e35_p320x320'
  const threadsOriginalA =
    'https://scontent.cdninstagram.com/v/t51.82787-15/TH_A_n.jpg?stp=dst-jpg_e35_p1080x1080'
  const threadsOriginalB =
    'https://scontent.cdninstagram.com/v/t51.82787-15/TH_B_n.jpg?stp=dst-jpg_e35_p1080x1350'

  const realMetaPhotoFixtures = [
    [
      'Instagram',
      {
        adapter: instagramAdapter,
        responseUrl: 'https://www.instagram.com/api/graphql',
        pathname: '/explore/',
        postId: 'ig-post-1',
        postCode: 'IG-CODE',
        previewUrl: instagramPreviewA,
        originalUrls: [instagramOriginalA, instagramOriginalB],
        response: {
          pk: 'ig-post-1',
          code: 'IG-CODE',
          user: { username: 'alice' },
          carousel_media: [
            {
              image_versions2: {
                candidates: [{ url: instagramOriginalA, width: 1080, height: 1080 }],
              },
            },
            {
              image_versions2: {
                candidates: [{ url: instagramOriginalB, width: 1080, height: 1350 }],
              },
            },
          ],
        },
        html: `
          <article>
            <a href="/p/IG-CODE/"><span>alice</span></a>
            <ul>
              <li><img src="${instagramPreviewA}" /></li>
              <li><img src="${instagramOriginalB}" /></li>
            </ul>
          </article>
        `,
      },
    ],
    [
      'Threads',
      {
        adapter: threadsAdapter,
        responseUrl: 'https://www.threads.net/api/graphql',
        pathname: '/home',
        postId: 'threads-post-1',
        postCode: 'THREADS-CODE',
        previewUrl: threadsPreviewA,
        originalUrls: [threadsOriginalA, threadsOriginalB],
        response: {
          pk: 'threads-post-1',
          code: 'THREADS-CODE',
          user: { username: 'alice' },
          carousel_media: [
            {
              image_versions2: {
                candidates: [{ url: threadsOriginalA, width: 1080, height: 1080 }],
              },
            },
            {
              image_versions2: {
                candidates: [{ url: threadsOriginalB, width: 1080, height: 1350 }],
              },
            },
          ],
        },
        html: `
          <div data-pressable-container="true">
            <a href="/@alice/post/THREADS-CODE"><span>alice</span></a>
            <div style="transform: translateX(0px)">
              <div></div>
              <div><img src="${threadsPreviewA}" /></div>
              <div><img src="${threadsOriginalB}" /></div>
            </div>
          </div>
        `,
      },
    ],
  ] as const

  it.each(realMetaPhotoFixtures)(
    'grabs the full detected Original-quality post through the real %s adapter record',
    async (_label, fixture) => {
      const root = document.createElement('div')
      root.innerHTML = fixture.html
      const media = root.querySelector<HTMLImageElement>('img')
      expect(media).not.toBeNull()
      if (!media) return
      expect(media.src).toBe(fixture.previewUrl)
      const key = fixture.adapter.mediaKeyFromUrl(media.src)
      expect(key).not.toBeNull()
      if (!key) return
      expect(key).not.toBe(fixture.adapter.mediaKeyFromUrl(fixture.originalUrls[0]))

      const { deps, sent, ui } = makeMetaDeps(fixture.adapter, {
        pathname: () => fixture.pathname,
        hovered: () => null,
        cursorHovered: () => ({ media, key }),
      })
      const detected = seedMetaPost(deps, fixture.adapter, fixture.responseUrl, fixture.response)
      const expected = deps.store.valuesForTweet(fixture.postId)
      expect(expected).toEqual(detected)
      expect(expected).toHaveLength(2)
      expect(deps.store.keyIndex().has(key)).toBe(false)
      expect(deps.store.postIdForCode(fixture.postCode)).toBe(fixture.postId)
      const livePostCode = fixture.adapter.postCodeFromElement?.(media, fixture.pathname)
      expect(livePostCode).toBe(fixture.postCode)
      if (!livePostCode) return
      const depsWithRetainedFocus = {
        ...deps,
        focusedPost: () => ({ postCode: livePostCode }),
      }

      vi.useFakeTimers()
      try {
        fireCurrentPost(depsWithRetainedFocus)

        expect(sent).toEqual([expected])
        expect(expected.map((item) => item.url)).toEqual(fixture.originalUrls)
        expect(sent[0]!.map((item) => item.url)).toEqual(expected.map((item) => item.url))
        expect(sent[0]!.map((item) => item.index)).toEqual(expected.map((item) => item.index))
        expect(ui()).toEqual({
          key: `dd:${fixture.postId}`,
          rect: RECT,
          phase: 'queued',
          all: true,
          allCount: 2,
        })

        await settle()
        expect(ui()?.phase).toBe('saved')
        vi.advanceTimersByTime(POST_GRAB_FLASH_MS)
        expect(ui()).toBeNull()
      } finally {
        vi.useRealTimers()
      }
    },
  )

  it.each(realMetaPhotoFixtures)(
    'retains a matching real %s focus across a bridge miss and retries the complete post',
    (_label, fixture) => {
      const root = document.createElement('div')
      root.innerHTML = fixture.html
      const media = root.querySelector<HTMLImageElement>('img')
      expect(media).not.toBeNull()
      if (!media) return
      const key = fixture.adapter.mediaKeyFromUrl(media.src)
      expect(media.src).toBe(fixture.previewUrl)
      if (!key) return
      expect(key).not.toBe(fixture.adapter.mediaKeyFromUrl(fixture.originalUrls[0]))
      const livePostCode = fixture.adapter.postCodeFromElement?.(media, fixture.pathname)
      expect(livePostCode).toBe(fixture.postCode)
      if (!livePostCode) return
      const clearFocusedPost = vi.fn<() => void>()
      const focusedPost = { postCode: livePostCode }
      const { deps, sent, marked, ui } = makeMetaDeps(fixture.adapter, {
        pathname: () => fixture.pathname,
        hovered: () => null,
        cursorHovered: () => ({ media, key }),
        focusedPost: () => focusedPost,
        clearFocusedPost,
      })
      const store = deps.store
      const detected = fixture.adapter.detectFromResponse(fixture.responseUrl, fixture.response)
      store.addDetected(detected)
      const expected = store.valuesForTweet(fixture.postId)
      expect(expected).toEqual(detected)
      expect(expected).toHaveLength(2)
      expect(store.postIdForCode(livePostCode)).toBeUndefined()

      vi.useFakeTimers()
      try {
        fireCurrentPost(deps)

        expect(sent).toEqual([])
        expect(ui()).toBeNull()
        expect(marked).toEqual([])
        expect(clearFocusedPost).not.toHaveBeenCalled()
        expect(focusedPost).toEqual({ postCode: livePostCode })

        const firstDetected = detected[0]
        expect(firstDetected).toBeDefined()
        if (!firstDetected) return
        expect(firstDetected.postId).toBe(fixture.postId)
        store.registerPostCode(firstDetected.postId, livePostCode)

        fireCurrentPost(deps)

        expect(sent).toEqual([expected])
        expect(sent[0]!.map((item) => item.url)).toEqual(expected.map((item) => item.url))
        expect(sent[0]!.map((item) => item.index)).toEqual(expected.map((item) => item.index))
        expect(marked).toEqual([
          key,
          ...new Set(detected.flatMap((item) => store.keysForTweet(item.postId))),
        ])
        expect(ui()).toMatchObject({
          key: `dd:${firstDetected.postId}`,
          phase: 'queued',
          all: true,
          allCount: detected.length,
        })
        expect(clearFocusedPost).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    },
  )
})
describe('fireCurrentPost — real adapter video targets', () => {
  it('queues a retained Instagram standalone /reel video through the live pathname code', async () => {
    const pathname = '/reel/IG-REEL-CODE/'
    const previewUrl =
      'https://scontent-lga3-2.cdninstagram.com/o1/v/t16/f1/m86/IG_REEL_PREVIEW.mp4?stp=dst-mp4'
    const originalUrl =
      'https://scontent-lga3-2.cdninstagram.com/o1/v/t16/f1/m86/IG_REEL_ORIGINAL.mp4?stp=dst-mp4'
    const root = document.createElement('div')
    root.innerHTML = `<div><video src="${previewUrl}"></video></div>`
    const video = root.querySelector<HTMLVideoElement>('video')
    expect(video).not.toBeNull()
    if (!video) return

    const liveCode = instagramAdapter.postCodeFromElement!(video, pathname)
    const cursorKey = instagramAdapter.postKeyFromVideoElement!(video, pathname)
    expect(liveCode).toBe('IG-REEL-CODE')
    expect(cursorKey).toBe('post:code:IG-REEL-CODE')
    if (!liveCode || !cursorKey) return

    const { deps, store, sent, marked, ui } = makeMetaDeps(instagramAdapter, {
      pathname: () => pathname,
      hovered: () => null,
      cursorHovered: () => ({ media: video, key: cursorKey }),
      focusedPost: () => ({ postCode: liveCode }),
    })
    const detected = seedMetaPost(deps, instagramAdapter, 'https://www.instagram.com/api/graphql', {
      pk: 'ig-reel-post',
      code: 'IG-REEL-CODE',
      user: { username: 'alice' },
      video_versions: [
        { url: previewUrl, width: 360, height: 640 },
        { url: originalUrl, width: 1080, height: 1920 },
      ],
    })
    const expected = store.valuesForTweet('ig-reel-post')
    expect(expected).toEqual(detected)
    expect(expected.map((item) => item.url)).toEqual([originalUrl])
    expect(expected.map((item) => item.index)).toEqual([0])
    expect(instagramAdapter.mediaKeyFromUrl(previewUrl)).not.toBe(expected[0]?.id)

    vi.useFakeTimers()
    try {
      fireCurrentPost(deps)

      expect(sent).toEqual([expected])
      expect(sent[0]!.map((item) => item.url)).toEqual(expected.map((item) => item.url))
      expect(sent[0]!.map((item) => item.index)).toEqual(expected.map((item) => item.index))
      expect(marked).toContain(cursorKey)
      expect(ui()).toMatchObject({
        key: 'dd:ig-reel-post',
        rect: RECT,
        phase: 'queued',
        all: true,
        allCount: expected.length,
      })

      await settle()
      expect(ui()?.phase).toBe('saved')
      vi.advanceTimersByTime(POST_GRAB_FLASH_MS)
      expect(ui()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
  it('queues a retained Instagram non-zero carousel video through its indexed DOM slide key', async () => {
    const pathname = '/explore/'
    const previewPhotoA =
      'https://scontent-lga3-2.cdninstagram.com/v/t51.82787-15/IG_CAROUSEL_PHOTO_A_PREVIEW.jpg?stp=dst-jpg'
    const originalPhotoA =
      'https://scontent-lga3-2.cdninstagram.com/v/t51.82787-15/IG_CAROUSEL_PHOTO_A_ORIGINAL.jpg?stp=dst-jpg'
    const previewVideo =
      'https://scontent-lga3-2.cdninstagram.com/o1/v/t16/f1/m86/IG_CAROUSEL_VIDEO_PREVIEW.mp4?stp=dst-mp4'
    const originalVideo =
      'https://scontent-lga3-2.cdninstagram.com/o1/v/t16/f1/m86/IG_CAROUSEL_VIDEO_ORIGINAL.mp4?stp=dst-mp4'
    const previewPhotoB =
      'https://scontent-lga3-2.cdninstagram.com/v/t51.82787-15/IG_CAROUSEL_PHOTO_B_PREVIEW.jpg?stp=dst-jpg'
    const originalPhotoB =
      'https://scontent-lga3-2.cdninstagram.com/v/t51.82787-15/IG_CAROUSEL_PHOTO_B_ORIGINAL.jpg?stp=dst-jpg'
    const root = document.createElement('div')
    root.innerHTML = `
      <article>
        <a href="/p/IG-CAROUSEL-CODE/"><span>alice</span></a>
        <ul>
          <li><div><img src="${previewPhotoA}" /></div></li>
          <li><div><video src="${previewVideo}"></video></div></li>
          <li><div><img src="${previewPhotoB}" /></div></li>
          <li></li>
        </ul>
      </article>
    `
    const video = root.querySelector<HTMLVideoElement>('video')
    expect(video).not.toBeNull()
    if (!video) return

    const liveCode = instagramAdapter.postCodeFromElement!(video, pathname)
    const cursorKey = instagramAdapter.postKeyFromVideoElement!(video, pathname)
    expect(liveCode).toBe('IG-CAROUSEL-CODE')
    expect(cursorKey).toBe('post:code:IG-CAROUSEL-CODE:1')
    if (!liveCode || !cursorKey) return

    const { deps, store, sent, marked, ui } = makeMetaDeps(instagramAdapter, {
      pathname: () => pathname,
      hovered: () => null,
      cursorHovered: () => ({ media: video, key: cursorKey }),
      focusedPost: () => ({ postCode: liveCode }),
    })
    const detected = seedMetaPost(deps, instagramAdapter, 'https://www.instagram.com/api/graphql', {
      pk: 'ig-carousel-post',
      code: 'IG-CAROUSEL-CODE',
      user: { username: 'alice' },
      carousel_media: [
        {
          image_versions2: {
            candidates: [
              { url: previewPhotoA, width: 360, height: 360 },
              { url: originalPhotoA, width: 1080, height: 1080 },
            ],
          },
        },
        {
          video_versions: [
            { url: previewVideo, width: 360, height: 640 },
            { url: originalVideo, width: 1080, height: 1920 },
          ],
        },
        {
          image_versions2: {
            candidates: [
              { url: previewPhotoB, width: 360, height: 360 },
              { url: originalPhotoB, width: 1080, height: 1080 },
            ],
          },
        },
      ],
    })
    const expected = store.valuesForTweet('ig-carousel-post')
    expect(expected).toEqual(detected)
    expect(expected.map((item) => item.url)).toEqual([
      originalPhotoA,
      originalVideo,
      originalPhotoB,
    ])
    expect(expected.map((item) => item.index)).toEqual([0, 1, 2])
    expect(instagramAdapter.mediaKeyFromUrl(previewVideo)).not.toBe(expected[1]?.id)

    vi.useFakeTimers()
    try {
      fireCurrentPost(deps)

      expect(sent).toEqual([expected])
      expect(sent[0]!.map((item) => item.url)).toEqual(expected.map((item) => item.url))
      expect(sent[0]!.map((item) => item.index)).toEqual(expected.map((item) => item.index))
      expect(marked).toContain(cursorKey)
      expect(ui()).toMatchObject({
        key: 'dd:ig-carousel-post',
        rect: RECT,
        phase: 'queued',
        all: true,
        allCount: expected.length,
      })

      await settle()
      expect(ui()?.phase).toBe('saved')
      vi.advanceTimersByTime(POST_GRAB_FLASH_MS)
      expect(ui()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('queues a retained Threads carousel video through its real DOM-slot key', async () => {
    const pathname = '/home'
    const previewVideoUrl =
      'https://scontent.cdninstagram.com/o1/v/t16/f1/m86/THREADS_VIDEO_PREVIEW.mp4?stp=dst-mp4'
    const originalVideoUrl =
      'https://scontent.cdninstagram.com/o1/v/t16/f1/m86/THREADS_VIDEO_ORIGINAL.mp4?stp=dst-mp4'
    const previewPhotoUrl =
      'https://scontent.cdninstagram.com/v/t51.82787-15/THREADS_PHOTO_PREVIEW_n.jpg?stp=dst-jpg'
    const originalPhotoUrl =
      'https://scontent.cdninstagram.com/v/t51.82787-15/THREADS_PHOTO_ORIGINAL_n.jpg?stp=dst-jpg'
    const root = document.createElement('div')
    root.innerHTML = `
      <div data-pressable-container="true">
        <a href="/@alice/post/THREADS-CODE/media"><span>alice</span></a>
        <div style="transform: translateX(0px)">
          <div></div>
          <div><video src="${previewVideoUrl}"></video></div>
          <div><img src="${previewPhotoUrl}" /></div>
        </div>
      </div>
    `
    const video = root.querySelector<HTMLVideoElement>('video')
    expect(video).not.toBeNull()
    if (!video) return

    const liveCode = threadsAdapter.postCodeFromElement!(video, pathname)
    const cursorKey = threadsAdapter.postKeyFromVideoElement!(video, pathname)
    expect(liveCode).toBe('THREADS-CODE')
    expect(cursorKey).toBe('post:code:THREADS-CODE:slot:0')
    if (!liveCode || !cursorKey) return

    const { deps, store, sent, marked, ui } = makeMetaDeps(threadsAdapter, {
      pathname: () => pathname,
      hovered: () => null,
      cursorHovered: () => ({ media: video, key: cursorKey }),
      focusedPost: () => ({ postCode: liveCode }),
    })
    const detected = seedMetaPost(deps, threadsAdapter, 'https://www.threads.net/api/graphql', {
      pk: 'threads-post',
      code: 'THREADS-CODE',
      user: { username: 'alice' },
      carousel_media: [
        {
          video_versions: [
            { url: previewVideoUrl, width: 360, height: 640 },
            { url: originalVideoUrl, width: 1080, height: 1920 },
          ],
        },
        {
          image_versions2: {
            candidates: [{ url: originalPhotoUrl, width: 1080, height: 1080 }],
          },
        },
      ],
    })
    const expected = store.valuesForTweet('threads-post')
    expect(expected).toEqual(detected)
    expect(expected.map((item) => item.url)).toEqual([originalVideoUrl, originalPhotoUrl])
    expect(expected.map((item) => item.index)).toEqual([0, 1])
    expect(threadsAdapter.mediaKeyFromUrl(previewVideoUrl)).not.toBe(expected[0]?.id)

    vi.useFakeTimers()
    try {
      fireCurrentPost(deps)

      expect(sent).toEqual([expected])
      expect(sent[0]!.map((item) => item.url)).toEqual(expected.map((item) => item.url))
      expect(sent[0]!.map((item) => item.index)).toEqual(expected.map((item) => item.index))
      expect(marked).toContain(cursorKey)
      expect(ui()).toMatchObject({
        key: 'dd:threads-post',
        rect: RECT,
        phase: 'queued',
        all: true,
        allCount: expected.length,
      })

      await settle()
      expect(ui()?.phase).toBe('saved')
      vi.advanceTimersByTime(POST_GRAB_FLASH_MS)
      expect(ui()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('fireCurrentPost — staleness', () => {
  it('a settle arriving after a newer grab owns the ring is ignored', async () => {
    vi.useFakeTimers()
    const a = photo('a', 'KA', 't1')
    let resolveGate: ((ok: boolean) => void) | undefined
    const send = vi.fn<() => Promise<boolean>>(
      () =>
        new Promise<boolean>((res) => {
          resolveGate = res
        }),
    )
    const { deps, ui } = makeDeps({
      adapter: adapter({ resolveHoverItem: () => a }),
      hovered: () => ({ media: document.createElement('img'), key: 'KA' }),
      send,
    })
    fireCurrentPost(deps)
    // A newer grab takes the ring before the first send settles.
    deps.setUi({ key: 'dd:newer', rect: RECT, phase: 'queued', all: true, allCount: 1 })
    resolveGate?.(true)
    await settle()
    expect(ui()).toMatchObject({ key: 'dd:newer', phase: 'queued' })
    // …and no flash was armed against the stale key.
    vi.advanceTimersByTime(POST_GRAB_FLASH_MS * 2)
    expect(ui()).toMatchObject({ key: 'dd:newer', phase: 'queued' })
    vi.useRealTimers()
  })
})
describe('fireCurrentPost — real adapter fail-closed targets', () => {
  const realMetaFailClosedFixtures = [
    [
      'Instagram',
      {
        adapter: instagramAdapter,
        pathname: '/explore/',
        responseUrl: 'https://www.instagram.com/api/graphql',
        postCode: 'IG-FAIL-CLOSED',
        detectedPostId: 'ig-detected-post',
        detectedCode: 'IG-DETECTED-CODE',
        emptyPostId: 'ig-empty-post',
        previewUrl:
          'https://scontent-lga3-2.cdninstagram.com/v/t51.82787-15/IG_FAIL_CLOSED_PREVIEW.jpg?stp=dst-jpg',
        avatarUrl:
          'https://scontent-lga3-2.cdninstagram.com/v/t51.82787-19/IG_FAIL_CLOSED_AVATAR.jpg?stp=dst-jpg',
        noCodeHtml: `
          <article>
            <img src="https://scontent-lga3-2.cdninstagram.com/v/t51.82787-15/IG_FAIL_CLOSED_PREVIEW.jpg?stp=dst-jpg" />
          </article>
        `,
        codeHtml: `
          <article>
            <a href="/p/IG-FAIL-CLOSED/"><span>alice</span></a>
            <img src="https://scontent-lga3-2.cdninstagram.com/v/t51.82787-15/IG_FAIL_CLOSED_PREVIEW.jpg?stp=dst-jpg" />
          </article>
        `,
        noKeyHtml: `
          <article>
            <a href="/p/IG-FAIL-CLOSED/"><span>alice</span></a>
            <img src="https://scontent-lga3-2.cdninstagram.com/v/t51.82787-19/IG_FAIL_CLOSED_AVATAR.jpg?stp=dst-jpg" />
          </article>
        `,
      },
    ],
    [
      'Threads',
      {
        adapter: threadsAdapter,
        pathname: '/home',
        responseUrl: 'https://www.threads.net/api/graphql',
        postCode: 'THREADS-FAIL-CLOSED',
        detectedPostId: 'threads-detected-post',
        detectedCode: 'THREADS-DETECTED-CODE',
        emptyPostId: 'threads-empty-post',
        previewUrl:
          'https://scontent.cdninstagram.com/v/t51.82787-15/THREADS_FAIL_CLOSED_PREVIEW.jpg?stp=dst-jpg',
        avatarUrl:
          'https://scontent.cdninstagram.com/v/t51.82787-19/THREADS_FAIL_CLOSED_AVATAR.jpg?stp=dst-jpg',
        noCodeHtml: `
          <div data-pressable-container="true">
            <img src="https://scontent.cdninstagram.com/v/t51.82787-15/THREADS_FAIL_CLOSED_PREVIEW.jpg?stp=dst-jpg" />
          </div>
        `,
        codeHtml: `
          <div data-pressable-container="true">
            <a href="/@alice/post/THREADS-FAIL-CLOSED/media"><span>alice</span></a>
            <img src="https://scontent.cdninstagram.com/v/t51.82787-15/THREADS_FAIL_CLOSED_PREVIEW.jpg?stp=dst-jpg" />
          </div>
        `,
        noKeyHtml: `
          <div data-pressable-container="true">
            <a href="/@alice/post/THREADS-FAIL-CLOSED/media"><span>alice</span></a>
            <img src="https://scontent.cdninstagram.com/v/t51.82787-19/THREADS_FAIL_CLOSED_AVATAR.jpg?stp=dst-jpg" />
          </div>
        `,
      },
    ],
  ] as const

  it.each(realMetaFailClosedFixtures)(
    'fails closed when real %s DOM has no post code',
    (_label, fixture) => {
      const root = document.createElement('div')
      root.innerHTML = fixture.noCodeHtml
      const media = root.querySelector<HTMLImageElement>('img')
      expect(media).not.toBeNull()
      if (!media) return

      const key = fixture.adapter.mediaKeyFromUrl(media.src)
      expect(key).not.toBeNull()
      if (!key) return

      const { deps, sent, marked, ui } = makeMetaDeps(fixture.adapter, {
        pathname: () => fixture.pathname,
        hovered: () => null,
        cursorHovered: () => ({ media, key }),
      })
      const detected = seedMetaPost(deps, fixture.adapter, fixture.responseUrl, {
        pk: fixture.detectedPostId,
        code: fixture.detectedCode,
        user: { username: 'alice' },
        image_versions2: {
          candidates: [{ url: fixture.previewUrl, width: 1080, height: 1080 }],
        },
      })
      expect(detected).toHaveLength(1)
      expect(detected[0]?.id).toBe(key)
      expect(fixture.adapter.postCodeFromElement?.(media, fixture.pathname)).toBeNull()
      expect(deps.store.postIdForCode(fixture.detectedCode)).toBe(fixture.detectedPostId)

      fireCurrentPost(deps)

      expect(sent).toEqual([])
      expect(ui()).toBeNull()
      expect(marked).toEqual([])
    },
  )

  it.each(realMetaFailClosedFixtures)(
    'fails closed when real %s post code maps to an empty detected group',
    (_label, fixture) => {
      const root = document.createElement('div')
      root.innerHTML = fixture.codeHtml
      const media = root.querySelector<HTMLImageElement>('img')
      expect(media).not.toBeNull()
      if (!media) return

      const key = fixture.adapter.mediaKeyFromUrl(media.src)
      expect(key).not.toBeNull()
      if (!key) return

      const { deps, sent, marked, ui } = makeMetaDeps(fixture.adapter, {
        pathname: () => fixture.pathname,
        hovered: () => null,
        cursorHovered: () => ({ media, key }),
      })
      const detected = seedMetaPost(deps, fixture.adapter, fixture.responseUrl, {
        pk: fixture.detectedPostId,
        code: fixture.detectedCode,
        user: { username: 'alice' },
        image_versions2: {
          candidates: [{ url: fixture.previewUrl, width: 1080, height: 1080 }],
        },
      })
      expect(detected).toHaveLength(1)
      expect(detected[0]?.id).toBe(key)
      expect(fixture.adapter.postCodeFromElement?.(media, fixture.pathname)).toBe(fixture.postCode)

      deps.store.registerPostCode(fixture.emptyPostId, fixture.postCode)
      expect(deps.store.postIdForCode(fixture.postCode)).toBe(fixture.emptyPostId)
      expect(deps.store.valuesForTweet(fixture.emptyPostId)).toEqual([])
      expect(deps.store.valuesForTweet(fixture.detectedPostId)).toHaveLength(1)

      fireCurrentPost(deps)

      expect(sent).toEqual([])
      expect(ui()).toBeNull()
      expect(marked).toEqual([])
    },
  )

  it.each(realMetaFailClosedFixtures)(
    'fails closed when real %s media has no usable key',
    (_label, fixture) => {
      const root = document.createElement('div')
      root.innerHTML = fixture.noKeyHtml
      const media = root.querySelector<HTMLImageElement>('img')
      expect(media).not.toBeNull()
      if (!media) return

      const key = fixture.adapter.mediaKeyFromUrl(media.src)
      expect(key).toBeNull()
      expect(fixture.adapter.postCodeFromElement?.(media, fixture.pathname)).toBe(fixture.postCode)

      const cursorHovered = vi.fn<
        () => { media: HTMLImageElement | HTMLVideoElement; key: string } | null
      >(() => {
        const mediaKey = fixture.adapter.mediaKeyFromUrl(media.src)
        return mediaKey ? { media, key: mediaKey } : null
      })
      const { deps, sent, marked, ui } = makeMetaDeps(fixture.adapter, {
        pathname: () => fixture.pathname,
        hovered: () => null,
        cursorHovered,
      })

      fireCurrentPost(deps)

      expect(cursorHovered).toHaveBeenCalledOnce()
      expect(sent).toEqual([])
      expect(ui()).toBeNull()
      expect(marked).toEqual([])
    },
  )
})
