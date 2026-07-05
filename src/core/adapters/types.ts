import type { MediaItem, Platform } from '../schema'

/**
 * The contract every platform (X, Instagram, Threads) implements — the seam
 * that keeps the popup/options UI, download queue, admission gate, cloud
 * upload, and Convex sync entirely platform-agnostic while each platform's
 * detection/DOM logic differs completely underneath.
 * See docs/superpowers/specs/2026-07-04-multi-platform-adapter-design.md.
 */
export interface PlatformAdapter {
  readonly platform: Platform

  /** Manifest content-script match patterns AND the `browser.tabs.query`
   *  filter — single source of truth (mirrors X_HOST_MATCH's role today). */
  readonly hostMatch: readonly string[]

  /** Whether `url` is a page on this platform. */
  matchesUrl(url: string): boolean

  /**
   * The stable media key `url` resolves to on THIS platform, or `null` if
   * `url` isn't a grabbable media preview here. A rendered DOM element
   * pointing at the same asset resolves to the identical key a tee-derived
   * `MediaItem.id`/key does — that's the whole contract. Already gated: it
   * is the ONLY key-derivation entry point an adapter needs, combining what
   * X historically split into two functions (a raw key extractor plus a
   * separate "is this actually grabbable" predicate) into one self-gated
   * call, so non-X adapters implement exactly one thing, not two.
   */
  mediaKeyFromUrl(url: string): string | null

  /**
   * Network layer (the "tee"): does this response carry media-bearing data
   * worth parsing? `requestHeaders` is optional — X's implementation ignores
   * it (URL-string filtering is enough); Instagram/Threads lean on request
   * headers (e.g. `x-fb-friendly-name`) that a URL string alone can't carry.
   */
  isTrackedResponseUrl(url: string, requestHeaders?: Readonly<Record<string, string>>): boolean

  /** Parse a tracked response body into MediaItems. */
  detectFromResponse(url: string, json: unknown): MediaItem[]

  /** DOM layer: media already rendered in a timeline/list, for the initial
   *  paint before any network capture lands. */
  detectRenderedMedia(root: ParentNode, pathname: string): MediaItem[]

  /** Overlay hot paths: hover resolution for Quick Grab / per-item badge. */
  resolveHoverItem(
    el: Element,
    key: string,
    detected: ReadonlyMap<string, MediaItem>,
    pathname: string,
  ): MediaItem | null

  /** Cheap predicate `resolveHoverItem` is gated on (runs on every hover). */
  canResolveHoverItem(el: Element, key: string, detected: ReadonlyMap<string, MediaItem>): boolean

  /**
   * Optional: a public/unauthenticated recovery pass for media the passive
   * tee missed (X's `syndication.ts` role). Instagram and Threads both lack
   * any no-auth public fallback (their oEmbed endpoints are Meta-app-
   * registration-gated), so neither implements this — confirmed by research,
   * not merely left unbuilt.
   */
  findMediaNeedingRecovery?(root: ParentNode, detectedKeys: ReadonlySet<string>): string[]

  /**
   * Optional: per-post `postId` <-> URL-shortcode linkage extracted from a
   * tracked response, for platforms whose hover-DOM can only recover the URL
   * shortcode (not the tee's own `postId`, which may differ — e.g.
   * Instagram's numeric `pk` vs its `/p/{code}/` shortcode). X has no such
   * split (its tweetId IS its DOM-derivable id), so it omits this.
   */
  extractPostCodes?(json: unknown): ReadonlyMap<string, string>

  /**
   * Optional: a DOM-derived, STABLE (across repeated calls on the same
   * element) hover key for a `<video>` whose URL carries no identity at all
   * (Instagram/Threads' `blob:` src) — purely so the overlay's hover/badge
   * state machine has a non-null key to arm on. Does NOT need to already
   * resolve to a real MediaItem (that's `resolveHoverItem`'s job, given the
   * SAME key) — only needs to be non-null while hovering a real post-video
   * and change when the hovered post changes. X omits this: its video always
   * has a URL-derivable key via `mediaKeyFromUrl` already.
   *
   * `pathname` is the CURRENT page's `location.pathname` — needed for the
   * standalone-permalink-page fallback (a `/p/{code}/`, `/reel/{code}/`, or
   * `/reels/{code}/` page has zero `<article>` ancestors to walk at all, so
   * the normal DOM-anchor walk finds no container; the permalink URL itself
   * already carries the post's own code). Instagram's implementation uses it;
   * Threads' accepts-and-ignores it (its own post-boundary DOM anchor
   * — `data-pressable-container` — is present on both feed and permalink
   * pages, so it never needs this fallback).
   */
  postKeyFromVideoElement?(video: HTMLVideoElement, pathname: string): string | null

  /**
   * Optional: the URL shortcode of the post CONTAINING `el` (any element — a
   * photo `<img>`, a `<video>`, or a wrapper), via this platform's DOM post
   * anchor — or null if `el` isn't inside a recognizable post. The overlay maps
   * this shortcode back to the tee's own `postId` (via
   * `DetectionStore.postIdForCode`) to grab the WHOLE post under the cursor,
   * even when the hovered media's own url key never matched a tee item
   * (Instagram/Threads photos, whose rendered `<img>` basename can differ from
   * the tee's captured basename, so they resolve to a placeholder whose postId
   * groups nothing). `pathname` is the current page path, for the
   * standalone-permalink fallback — same role and platform split as
   * {@link postKeyFromVideoElement}. X omits this: its `/status/{id}` anchor is
   * already the identity, with no code→postId indirection.
   */
  postCodeFromElement?(el: Element, pathname: string): string | null
}
