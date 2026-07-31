import { describe, it, expect, vi } from 'vitest'
import type { PlatformAdapter } from '../../core/adapters/types'
import { makeDetectionStore } from '../../core/adapters/detection-store'
import { mediaKeyFromUrl } from '../../core/adapters/x/dom'
import type { MediaItem } from '@/packages/schema'
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
      marked.push(...keys)
    },
    rectOf: () => RECT,
    ...over,
  }
  return { deps, store, sent, marked, ui: () => ui }
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

describe('fireCurrentPost — staleness', () => {
  it('a settle arriving after a newer grab owns the ring is ignored', async () => {
    vi.useFakeTimers()
    const a = photo('a', 'KA', 't1')
    const gate: { resolve?: (ok: boolean) => void } = {}
    const send = vi.fn<() => Promise<boolean>>(
      () =>
        new Promise<boolean>((res) => {
          gate.resolve = res
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
    gate.resolve?.(true)
    await settle()
    expect(ui()).toMatchObject({ key: 'dd:newer', phase: 'queued' })
    // …and no flash was armed against the stale key.
    vi.advanceTimersByTime(POST_GRAB_FLASH_MS * 2)
    expect(ui()).toMatchObject({ key: 'dd:newer', phase: 'queued' })
    vi.useRealTimers()
  })
})
