// Pure hover/occlusion resolution for the overlay: given a hit-test stack the
// caller reads once per frame (`document.elementsFromPoint(x, y)`), decide which
// media element — if any — the cursor is actually over, and derive its preview
// src and stable key. Every function here is pure over its arguments; the one
// true-external DOM read (`elementsFromPoint`) stays at the call sites.
import type { PlatformAdapter } from './types'
import { videoPosterUrl, VIDEO_PLAYER_SEL } from './x/dom'

export type HoverMediaElement = HTMLImageElement | HTMLVideoElement

export const isImageElement = (el: Element): el is HTMLImageElement => el.tagName === 'IMG'
export const isVideoElement = (el: Element): el is HTMLVideoElement => el.tagName === 'VIDEO'

/**
 * A media element inside `container` that's invisible to `elementsFromPoint`
 * because it's `pointer-events: none` — the real photo/video pixels are still
 * there, just non-interactive. LIVE-VERIFIED 2026-07-05 (Chrome Canary,
 * Threads' multi-column card layout — e.g. the Saved/Liked columns): the
 * rendered `<img>` is `position:absolute; pointer-events:none`, so a hovered
 * point resolves to its plain `<div>` wrapper instead — `elementsFromPoint`
 * excludes `pointer-events:none` elements per spec, so the `<img>` never
 * appeared in the hit-test stack at all, and `mediaAtPoint`'s stack search
 * came up empty on every real Threads card despite the photo being right
 * there (this is what "hover-grab doesn't work on Threads" actually was).
 * Instagram's own single-column feed `<img>` has no such CSS (confirmed the
 * same visit) and is hit-tested normally, so this is a no-op there — a
 * platform DIFFERENCE, not a platform CHECK, same posture as `videoAnchorAt`
 * below (X's hidden `<video>`, reached through its player container instead
 * of the hit-test stack). Only trusts a candidate whose OWN rect covers
 * `(x, y)`, so a large container that merely happens to also hold an
 * unrelated image elsewhere is never mistaken for the hovered one.
 */
export function nonInteractiveMediaAt(
  container: Element,
  x: number,
  y: number,
): HoverMediaElement | null {
  for (const el of container.querySelectorAll('img,video')) {
    /* v8 ignore next -- querySelectorAll('img,video') only yields IMG/VIDEO, so this narrowing guard never continues */
    if (!isImageElement(el) && !isVideoElement(el)) continue
    if (getComputedStyle(el).pointerEvents !== 'none') continue
    if (rectCovers(el, x, y)) return el
  }
  return null
}

/**
 * The topmost hoverable media element in the hit-test `stack`, unless something
 * visually occludes it: this extension's own shadow host (launcher pill / grab
 * ring), or a modal layer the media sits outside of (lightbox backdrop, compose
 * scrim — detected via `[aria-modal="true"], [role="dialog"]`, the same
 * selector `x/reveal.ts`'s `REVEAL_SCOPE_SEL` and this file's own lightbox-badge
 * check already trust as X's canonical "is this actually a modal" signal). X's
 * transparent hit-target divs over their own media pass through. `stack` is
 * the `elementsFromPoint` result for the point; `x`/`y` are that same point,
 * threaded through to {@link nonInteractiveMediaAt}.
 *
 * Deliberately does NOT bail on an ad-hoc "background alpha looks opaque-ish"
 * heuristic (a prior version did, at >= 0.5): LIVE-VERIFIED 2026-07-05 on a
 * real Instagram Reels permalink (instagram.com/reel/DaHL9NxPBWz/) that a
 * legitimate, see-through caption-legibility scrim over the video player is
 * `rgba(0,0,0,0.5)` — exactly the old threshold — which silently blocked
 * hover-grab on every Reel with that (very common) UI treatment, despite the
 * video being fully visible to the user. Real hidden-behind-a-modal cases are
 * already caught by the explicit ARIA check above; a translucent decorative
 * layer sitting on top of clearly-visible media is not equivalent to a real
 * opaque cover and should never veto a resolution by itself.
 */
export function mediaAtPoint(
  stack: readonly Element[],
  x: number,
  y: number,
): HoverMediaElement | null {
  let at = -1
  let media: HoverMediaElement | null = null
  for (const [i, el] of stack.entries()) {
    if (isImageElement(el) || isVideoElement(el)) {
      at = i
      media = el
      break
    }
    const reach = nonInteractiveMediaAt(el, x, y)
    if (reach) {
      at = i
      media = reach
      break
    }
  }
  if (at < 0 || !media) return null
  for (const el of stack.slice(0, at)) {
    if (el.tagName === 'XMD-OVERLAY') return null
    if (el.contains(media)) continue
    const modal = el.closest('[aria-modal="true"], [role="dialog"]')
    if (modal && !modal.contains(media)) return null
  }
  return media
}

/** The `<video>` for the X video player under the cursor, or null. The real
 *  `<video>` is `visibility:hidden`, so it never appears in `mediaAtPoint`; we
 *  reach it through its `VIDEO_PLAYER_SEL` container instead. `stack` is the
 *  shared `elementsFromPoint` result, walked a single time per frame. */
export function videoAnchorAt(
  target: Element | null,
  stack: readonly Element[],
): HTMLVideoElement | null {
  const fromTarget = target?.closest(VIDEO_PLAYER_SEL)?.querySelector('video')
  if (fromTarget) return fromTarget
  for (const el of stack) {
    if (el.tagName === 'XMD-OVERLAY') return null
    const video = el.closest(VIDEO_PLAYER_SEL)?.querySelector('video')
    if (video) return video
  }
  return null
}

/** target-first direct hit, else the topmost unoccluded media in `stack`, else the X
 *  hidden-video anchor. `stack` IS `document.elementsFromPoint(x, y)` — the caller does
 *  the one true-external read; everything here is pure over the array. Null on any
 *  ambiguity, never a wrong element. */
export function resolveHoverMedia(
  target: Element | null,
  stack: readonly Element[],
  x: number,
  y: number,
): HoverMediaElement | null {
  const direct = target?.closest('img,video') as HoverMediaElement | null
  if (direct) return direct
  return mediaAtPoint(stack, x, y) ?? videoAnchorAt(target, stack)
}

// Preview src for a hovered media element: a video's poster (X only — no
// platform besides X has a DOM-derivable video identity; Instagram/Threads
// stay tee-map-only for video, see the design's Honest Gaps). Off-X this is
// inert rather than unreachable-by-luck: `VIDEO_PLAYER_SEL`
// (`[data-testid="videoPlayer"]` etc.) never matches Instagram/Threads
// markup, so `video.closest(...)` finds nothing, and `videoPosterUrl`'s own
// `pbs.twimg.com`-gated check independently also rejects any cdninstagram
// poster even if one were found — so calling it unconditionally here is a
// deliberate no-op off-X, not an omission.
export function previewSrcFromMedia(media: HoverMediaElement): string {
  return isVideoElement(media)
    ? (videoPosterUrl(media) ?? (media.poster || media.currentSrc || media.src))
    : media.currentSrc || media.src
}

// Dispatches through the boot-resolved adapter's own `mediaKeyFromUrl` —
// for X this is the same two-step gate (`isGrabbableMediaPreviewUrl` then
// `mediaKeyFromUrl`) this function ran inline before, just relocated so it
// takes `adapter` explicitly (module scope, no closure); for Instagram/Threads
// it resolves a hovered `<img>` to the same basename key the tee derives
// (photos only — a hovered `<video>`'s `blob:`/empty src never passes the
// platform's own grabbability gate, so it falls through to null).
//
// For a video with no URL-derivable key (Instagram/Threads' blob: src, no
// poster), fall back to a DOM-derived post-level key so the hover/badge
// state machine has a non-null, stable `key` to arm on at all — the
// adapter's own resolveHoverItem/canResolveHoverItem then decide whether
// that key ACTUALLY resolves to a tee-detected single-video item (v1
// scope: exactly one video per post — see
// core/adapters/meta-shared/post-anchor.ts's module doc). X is
// unaffected: `previewSrcFromMedia`'s poster-first branch already yields a
// real twimg key for X video, so `mediaKeyFromUrl` never returns null
// there and this fallback never triggers off-X callers reaching it.
export function previewKeyFromMedia(
  adapter: PlatformAdapter,
  media: HoverMediaElement | null,
  pathname: string,
): string | null {
  if (!media) return null
  const urlKey = adapter.mediaKeyFromUrl(previewSrcFromMedia(media))
  if (urlKey) return urlKey
  return isVideoElement(media) ? (adapter.postKeyFromVideoElement?.(media, pathname) ?? null) : null
}

/** Does `el`'s own rect cover the point? The one geometry read shared by the
 *  arm-time reach ({@link nonInteractiveMediaAt}) and the fire-time re-check
 *  ({@link mediaStillUnderPointer}), so both answer "is this pointer-events:none
 *  media under the cursor" the same way. */
function rectCovers(el: Element, x: number, y: number): boolean {
  const r = el.getBoundingClientRect()
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
}

/** Is `media` still under the pointer? A hidden X `<video>` is never in
 *  `elementsFromPoint`, so accept when the cursor is still over its player. A
 *  `pointer-events:none` `<img>` (Threads — see {@link nonInteractiveMediaAt})
 *  is never in the stack either: accept it when a stack element still contains
 *  it and its own rect covers `(x, y)` — the exact condition the arm path
 *  reached it by. Without this, every Threads carousel dwell charged the ring
 *  and then died as `grab-target-stale` (LIVE-VERIFIED 2026-08-23). */
export function mediaStillUnderPointer(
  media: HoverMediaElement,
  stack: readonly Element[],
  x: number,
  y: number,
): boolean {
  if (stack.includes(media)) return true
  if (isVideoElement(media)) {
    const container = media.closest(VIDEO_PLAYER_SEL)
    if (container && stack.some((el) => container.contains(el))) return true
  }
  return (
    getComputedStyle(media).pointerEvents === 'none' &&
    rectCovers(media, x, y) &&
    stack.some((el) => el.contains(media))
  )
}
