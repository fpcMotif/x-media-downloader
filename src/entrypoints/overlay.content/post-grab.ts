/**
 * Whole-post grab orchestration — the `d d` hotkey's fire path, and the shared
 * whole-post payload resolver the hover all-grab (`fireGrab`) delegates to.
 * Deps-injected named functions in the `handlers.ts` idiom: every effect (DOM,
 * store, send, UI, timer) arrives through {@link PostGrabDeps}, so the module
 * is unit-testable with fakes while `index.tsx` stays thin wiring.
 *
 * One action — "grab every detected media item of the current post" — from any
 * trigger. Target priority: the HOVERED media first (freshest pointer intent,
 * all platforms); else, on X only, the post under X's native j/k cursor.
 */
import type { PlatformAdapter } from '../../core/adapters/types'
import { postGrabItems, type DetectionStore } from '../../core/adapters/detection-store'
import type { MediaItem } from '@/packages/schema'
import type { QuickGrabUiPhase } from '@/packages/overlay/quickgrab'

/** How long the settled ring (`saved`/`failed`) lingers before clearing itself
 *  — a keyboard-fired grab has no pointer-leave to dismiss it. */
export const POST_GRAB_FLASH_MS = 1500

/** The ring state the overlay renders — structurally `index.tsx`'s grabUi. */
export interface GrabUiState {
  readonly key: string
  readonly rect: {
    readonly top: number
    readonly left: number
    readonly width: number
    readonly height: number
  }
  readonly phase: QuickGrabUiPhase
  readonly all?: boolean
  readonly allCount?: number
}

export interface PostGrabDeps {
  readonly adapter: PlatformAdapter
  readonly store: DetectionStore
  readonly doc: Document
  readonly pathname: () => string
  /** Freshest pointer intent: the hovered media + its key, or null. */
  readonly hovered: () => { media: HTMLImageElement | HTMLVideoElement; key: string } | null
  /** X's j/k-focused article (the X-only cursor recipe wired by the caller). */
  readonly focusedArticle: () => Element | null
  /** Map an element inside a tweet article to its tweetId (X-only). */
  readonly tweetIdFromArticle: (el: Element) => string | null
  /** Hand the payload to the download queue; resolves true = started. */
  readonly send: (items: readonly MediaItem[]) => Promise<boolean>
  /** Present/update the Quick Grab ring; null clears. */
  readonly setUi: (ui: GrabUiState | null) => void
  readonly getUi: () => GrabUiState | null
  /** Fold keys into the Quick Grab grabbed-set (markAllGrabbed). */
  readonly markGrabbed: (keys: Iterable<string>) => void
  readonly rectOf: (el: Element) => {
    readonly top: number
    readonly left: number
    readonly width: number
    readonly height: number
  }
}

/**
 * The whole-post payload for a hovered element: resolve the WHOLE post from
 * the DOM post anchor, NOT the hovered media's own url key — an Instagram/
 * Threads photo's rendered `<img>` basename can differ from the tee's captured
 * basename, so the hovered item falls back to a placeholder whose `postId` is
 * its own media key (grouping nothing) — `valuesForTweet` on it would return
 * just itself. The post's DOM shortcode → the tee's real `postId` recovers the
 * whole detected set (all slides, best quality). Falls back to the hovered
 * item unioned with its own post's items when the tee hasn't linked/seen this
 * post yet.
 */
export function wholePostItemsFor(
  deps: Pick<PostGrabDeps, 'adapter' | 'store' | 'pathname'>,
  media: Element,
  item: MediaItem,
): MediaItem[] {
  const code = deps.adapter.postCodeFromElement?.(media, deps.pathname()) ?? null
  const codePostId = code ? deps.store.postIdForCode(code) : undefined
  const teePost = codePostId ? deps.store.valuesForTweet(codePostId) : []
  return teePost.length > 0 ? teePost : postGrabItems(item, deps.store.valuesForTweet(item.postId))
}

/**
 * Fire the whole-post grab for the current post. Silent no-op (no ring, no
 * send) when nothing is targeted or nothing is resolvable — a total miss never
 * fakes a success. On fire: mark every key of the post grabbed (an immediate
 * modifier-hover then reads "Already queued"), show the `queued` ring with the
 * item count, hand off, settle to `saved`/`failed`, and self-clear after
 * {@link POST_GRAB_FLASH_MS} unless a newer grab owns the ring by then.
 */
export function fireCurrentPost(deps: PostGrabDeps): void {
  let uiKey: string
  let rect: GrabUiState['rect']
  let items: MediaItem[]

  const hover = deps.hovered()
  if (hover) {
    const item = deps.adapter.resolveHoverItem(
      hover.media,
      hover.key,
      deps.store.keyIndex(),
      deps.pathname(),
    )
    if (!item) return
    items = wholePostItemsFor(deps, hover.media, item)
    uiKey = `dd:${item.postId}`
    rect = deps.rectOf(hover.media)
  } else if (deps.adapter.platform === 'x') {
    const article = deps.focusedArticle()
    const tweetId = article ? deps.tweetIdFromArticle(article) : null
    if (!article || !tweetId) return
    items = deps.store.valuesForTweet(tweetId)
    if (items.length === 0) {
      // The tee hasn't captured this post (fast scroll): fall back to what the
      // DOM itself proves — rendered photos. A video-only post the tee missed
      // stays a quiet no-op (honest gap, never a fake success).
      deps.store.addDetected(deps.adapter.detectRenderedMedia(article, deps.pathname()))
      items = deps.store.valuesForTweet(tweetId)
    }
    if (items.length === 0) return
    uiKey = `dd:${tweetId}`
    rect = deps.rectOf(article.querySelector('img') ?? article.querySelector('video') ?? article)
  } else {
    return
  }

  deps.markGrabbed(
    [...new Set(items.map((i) => i.postId))].flatMap((id) => deps.store.keysForTweet(id)),
  )
  deps.setUi({ key: uiKey, rect, phase: 'queued', all: true, allCount: items.length })
  void (async () => {
    const ok = await deps.send(items)
    const ui = deps.getUi()
    if (ui === null || ui.key !== uiKey) return
    deps.setUi({ ...ui, phase: ok ? 'saved' : 'failed' })
    setTimeout(() => {
      if (deps.getUi()?.key === uiKey) deps.setUi(null)
    }, POST_GRAB_FLASH_MS)
  })()
}
