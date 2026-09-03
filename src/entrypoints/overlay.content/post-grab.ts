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

/** Stable Meta post identity retained between Quick Grab focus and bare `d d`. */
export interface PostGrabFocus {
  readonly postCode: string
}

export interface PostGrabDeps {
  readonly adapter: PlatformAdapter
  readonly store: DetectionStore
  readonly doc: Document
  readonly pathname: () => string
  /** X's modifier-active hover target. */
  readonly hovered: () => { media: HTMLImageElement | HTMLVideoElement; key: string } | null
  /** Fresh media under the pointer for Meta's bare `d d` fallback. */
  readonly cursorHovered?: () => { media: HTMLImageElement | HTMLVideoElement; key: string } | null
  /** Meta post code retained by the all-post Quick Grab gesture, if any. */
  readonly focusedPost?: () => PostGrabFocus | null
  /** Forget a retained Meta focus that no longer matches the live pointer target. */
  readonly clearFocusedPost?: () => void
  /** Called when the DOM-shortcode → tee-postId chain cannot prove a full post.
   *  `code` distinguishes a missing DOM shortcode from one not yet registered
   *  by passive capture. */
  readonly onWholePostFallback?: (info: {
    readonly item: MediaItem
    readonly code: string | null
  }) => void
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
  /** Fold a rendered preview key and every resolved post key into one grab. */
  readonly markWholePostGrabbed: (previewKey: string, postKeys: Iterable<string>) => void
  readonly rectOf: (el: Element) => {
    readonly top: number
    readonly left: number
    readonly width: number
    readonly height: number
  }
}

/**
 * The whole-post payload for a hovered element. Meta Source Adapters prove the
 * group through the DOM post code → tee post id bridge; a DOM-only photo
 * fallback is one preview, never proof of an entire carousel. X has no
 * post-code resolver, so it retains its existing item/post fallback.
 */
export function wholePostItemsFor(
  deps: Pick<PostGrabDeps, 'adapter' | 'store' | 'pathname' | 'onWholePostFallback'>,
  media: Element,
  item: MediaItem,
): MediaItem[] {
  const postCodeFromElement = deps.adapter.postCodeFromElement
  const code = postCodeFromElement?.(media, deps.pathname()) ?? null
  const codePostId = code ? deps.store.postIdForCode(code) : undefined
  const teePost = codePostId ? deps.store.valuesForTweet(codePostId) : []
  if (teePost.length > 0) return teePost
  deps.onWholePostFallback?.({ item, code })
  return postCodeFromElement ? [] : postGrabItems(item, deps.store.valuesForTweet(item.postId))
}

/** Hovered/cursor media target and its resolved key — the shape returned by
 *  {@link PostGrabDeps.hovered} and {@link PostGrabDeps.cursorHovered}. */
type HoverTarget = NonNullable<ReturnType<PostGrabDeps['hovered']>>

/** Where to resolve this fire from: a hover (possibly none) to resolve
 *  further, plus whether a retained Meta post focus was in play for it. */
interface FireHoverProbe {
  readonly hover: HoverTarget | null
  readonly hadFocusedPost: boolean
}

/**
 * Locate the hover target for this fire, honoring a retained Meta post focus
 * over a live hover/cursor read. A retained focus is a post code, never a
 * cached element: re-hit-test the pointer at fire time; a mismatch must not
 * fall through to another post, so the caller aborts entirely on `'abort'`.
 */
function resolveFireHoverTarget(deps: PostGrabDeps): FireHoverProbe | 'abort' {
  const postCodeFromElement = deps.adapter.postCodeFromElement
  const focusedPost = postCodeFromElement ? (deps.focusedPost?.() ?? null) : null
  if (focusedPost) {
    const hover = deps.cursorHovered?.() ?? null
    const liveCode = hover ? (postCodeFromElement?.(hover.media, deps.pathname()) ?? null) : null
    if (liveCode !== focusedPost.postCode) {
      deps.clearFocusedPost?.()
      return 'abort'
    }
    return { hover, hadFocusedPost: true }
  }
  if (deps.adapter.platform === 'x') return { hover: deps.hovered(), hadFocusedPost: false }
  return { hover: deps.cursorHovered?.() ?? null, hadFocusedPost: false }
}

/** A resolved whole-post grab, ready to mark, ring, and send. */
interface PostGrabTarget {
  readonly items: MediaItem[]
  readonly uiKey: string
  readonly rect: GrabUiState['rect']
}

/**
 * Resolve the whole-post payload for a hovered element. Null on any dead end
 * — no item, no post, or a defensive empty first item — which the caller
 * treats as a silent no-op (no ring, no send).
 */
function resolveHoveredGrab(
  deps: PostGrabDeps,
  hover: HoverTarget,
  hadFocusedPost: boolean,
): PostGrabTarget | null {
  const item = deps.adapter.resolveHoverItem(
    hover.media,
    hover.key,
    deps.store.keyIndex(),
    deps.pathname(),
  )
  if (!item) {
    if (hadFocusedPost) deps.clearFocusedPost?.()
    if (import.meta.env.DEV)
      console.debug(
        `[XMD] whole-post grab · ABORT · hovered ${hover.media.tagName} key=${hover.key} resolved to no item (silent no-op, no ring)`,
      )
    return null
  }
  const items = wholePostItemsFor(deps, hover.media, item)
  if (items.length === 0) return null
  if (import.meta.env.DEV)
    console.debug(
      `[XMD] whole-post grab · hovered ${hover.media.tagName} key=${hover.key} → item ${item.id} (post ${item.postId}) → whole post = ${items.length} item(s): [${items.map((i) => `${i.type}#${i.id}`).join(', ')}]`,
    )
  const [firstItem] = items
  if (!firstItem) return null
  return { items, uiKey: `dd:${firstItem.postId}`, rect: deps.rectOf(hover.media) }
}

/**
 * Resolve the whole-post payload for X's j/k-focused article — the keyboard
 * cursor fallback used when nothing is hovered. Off X there is no such
 * fallback, so any non-X platform is an immediate silent no-op.
 */
function resolveArticleGrab(deps: PostGrabDeps): PostGrabTarget | null {
  if (deps.adapter.platform !== 'x') {
    if (import.meta.env.DEV)
      console.debug(
        `[XMD] whole-post grab · ABORT · nothing hovered, no media under cursor, and platform=${deps.adapter.platform} has no keyboard cursor fallback (silent no-op, no ring)`,
      )
    return null
  }
  const article = deps.focusedArticle()
  const tweetId = article ? deps.tweetIdFromArticle(article) : null
  if (!article || !tweetId) return null
  let items = deps.store.valuesForTweet(tweetId)
  if (items.length === 0) {
    // The tee hasn't captured this post (fast scroll): fall back to what the
    // DOM itself proves — rendered photos. A video-only post the tee missed
    // stays a quiet no-op (honest gap, never a fake success).
    deps.store.addDetected(deps.adapter.detectRenderedMedia(article, deps.pathname()))
    items = deps.store.valuesForTweet(tweetId)
  }
  if (items.length === 0) return null
  return {
    items,
    uiKey: `dd:${tweetId}`,
    rect: deps.rectOf(article.querySelector('img') ?? article.querySelector('video') ?? article),
  }
}

/** Await the send, then settle the ring to `saved`/`failed` and self-clear —
 *  but only while this grab still owns the ring by the time it resolves. */
async function fireAndSettle(deps: PostGrabDeps, uiKey: string, items: MediaItem[]): Promise<void> {
  const ok = await deps.send(items)
  const ui = deps.getUi()
  if (ui === null || ui.key !== uiKey) return
  deps.setUi({ ...ui, phase: ok ? 'saved' : 'failed' })
  setTimeout(() => {
    if (deps.getUi()?.key === uiKey) deps.setUi(null)
  }, POST_GRAB_FLASH_MS)
}

/**
 * Fire the whole-post grab for the current post. Silent no-op (no ring, no
 * send) when nothing is targeted or nothing is resolvable — a total miss never
 * fakes a success. On fire: mark the rendered preview and every key of the
 * post grabbed (an immediate modifier-hover then reads "Already queued"), show
 * item count, hand off, settle to `saved`/`failed`, and self-clear after
 * {@link POST_GRAB_FLASH_MS} unless a newer grab owns the ring by then.
 */
export function fireCurrentPost(deps: PostGrabDeps): void {
  const probe = resolveFireHoverTarget(deps)
  if (probe === 'abort') return
  const { hover, hadFocusedPost } = probe

  const grab = hover ? resolveHoveredGrab(deps, hover, hadFocusedPost) : resolveArticleGrab(deps)
  if (!grab) return

  const postKeys = [...new Set(grab.items.map((i) => i.postId))].flatMap((id) =>
    deps.store.keysForTweet(id),
  )
  if (hover) deps.markWholePostGrabbed(hover.key, postKeys)
  else deps.markGrabbed(postKeys)
  deps.setUi({
    key: grab.uiKey,
    rect: grab.rect,
    phase: 'queued',
    all: true,
    allCount: grab.items.length,
  })
  void fireAndSettle(deps, grab.uiKey, grab.items)
}
