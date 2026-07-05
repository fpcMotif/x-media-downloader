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
}
