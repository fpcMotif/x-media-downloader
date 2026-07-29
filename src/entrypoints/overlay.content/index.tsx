import './style.css'
import { render } from 'preact'
import { allPlatformHostMatch } from '../../core/adapters/catalog'
import { adapterForHostname } from '../../core/adapters/registry'
import type { PlatformAdapter } from '../../core/adapters/types'
import { makeDetectionStore, postGrabItems } from '../../core/adapters/detection-store'
import { harvestTweets } from '../../core/capture/harvest'
import { MAX_CAPTURE_BATCH, MAX_CAPTURE_PENDING } from '../../core/capture/contract'
import type { CaptureEpoch } from '../../core/capture/epoch'
import type { Source } from '../../core/capture/record'
import { parseSyndicationTweet } from '../../core/adapters/x/syndication'
import {
  videoPosterUrl,
  TWEET_ARTICLE_SEL,
  VIDEO_PLAYER_SEL,
  VIDEO_PREVIEW_SECTIONS,
} from '../../core/adapters/x/dom'
import {
  idleQuickGrab,
  pressModifier,
  releaseModifier,
  canGrab,
  markGrabbed,
  isModifierKey,
  syncModifierFromFlags,
  quickGrabDwellMs,
  quickGrabBadgeLabel,
  allAugmentModifier,
  postGrabActive,
  markAllGrabbed,
  type GrabModifier,
  type QuickGrabState,
  type QuickGrabUiPhase,
} from '../../core/quickgrab'
import { startContentSettings } from '../../core/settings/content-client'
import { expectReply, safeSend } from '../../core/messaging'
import { mediaRequestId } from '../../core/download/request-identity'
import { clickSensitiveReveals } from '../../core/adapters/x/reveal'
import {
  CLEARED_STUB_ATTR,
  CLEARED_STUB_CSS,
  collapseClearedStubs,
  isForYouHome,
  tweetIdOfArticle,
} from '../../core/clear/clearer'
import { Option } from 'effect'
import { decodeQueueUpdate, isSavedStatusScope, type HandlerDeps } from './handlers'
import { decodeSavedStatusResponse } from '../../core/schema/saved-status'
import { decodeRecoverTweetMediaResponse } from '../../core/schema/background'
import { decodeCaptureAcceptedAck, makeCaptureBuffer, type CaptureBuffer } from './capture-buffer'
import { makeCaptureEpochRefresh } from './capture-epoch-refresh'
import { makeRenderedMediaLifecycle } from './rendered-media-lifecycle'
import { requestSavedStatusBatches } from './request-batching'
import { makeSavedStatusLifecycle } from './saved-status-lifecycle'
import {
  makeClearExpect,
  sendTrackedBatches,
  type ClearExpect,
  type TrackedStart,
} from './tracked-download'
import { makeDownloadAffordances, type DownloadAffordanceSnapshot } from './download-affordances'
import { installEarlyMediaResponseBridge } from './early-media-response'
import type { MediaResponse } from './media-response-contract'
import {
  makeOverlayRuntimeMessageHandler,
  makeRouteMediaResponseConsumer,
  startOverlayLifecycle,
} from './overlay-lifecycle'
import { makeClearScopeAttempt } from './clear-scope-attempt'
import { inlineDataPayloads } from '../../core/adapters/meta-shared/inline-data'
import {
  decodeCaptureEpochChanged,
  decodeCaptureEpochResult,
  type CaptureEpochRequest,
  type CaptureTweets,
  type MediaItem,
  type ContentSettings,
} from '../../core/schema'
import { isFromExtensionWorker, type MessageSenderLike } from '../../core/sender-guard'

interface Rect {
  readonly top: number
  readonly left: number
  readonly width: number
  readonly height: number
}

type HoverMediaElement = HTMLImageElement | HTMLVideoElement

/** Verbose clear-on-save tracing → the X PAGE console (content-script world).
 *  Open DevTools on the X tab to watch the un-bookmark/un-like decision live.
 *  DEV-only: every call site is guarded by `import.meta.env.DEV`, so neither the
 *  log strings nor `actionTestids(...)` are computed in the shipped build. */
const clearLog = (...args: unknown[]): void => console.info('[XMD clear]', ...args)
const clearScopeAttempt = makeClearScopeAttempt({
  document,
  ...(import.meta.env.DEV ? { trace: clearLog } : {}),
})

// Debounce for the cross-device "Saved" status sweep: a burst of scroll/render
// mutations collapses into one overlay→background round-trip + chip pass.
const SAVED_SWEEP_DEBOUNCE_MS = 500
const CLEAR_VISIBILITY_PULSE_DEBOUNCE_MS = 300
const currentMediaRoute = (): string => `${location.pathname}${location.search}${location.hash}`

/** Ask the background which of these tweetIds are already downloaded (cross-device).
 *  Fail-safe: a context-invalidated / errored / malformed reply yields no marks. */
const requestSavedStatus = async (tweetIds: string[]): Promise<string[]> => {
  return requestSavedStatusBatches(tweetIds, async (batch) => {
    const out = await safeSend(() =>
      browser.runtime.sendMessage({
        _tag: 'SavedStatusRequest',
        tweetIds: batch,
      }),
    )
    return out.status === 'ok' ? decodeSavedStatusResponse(out.reply, batch)?.saved : undefined
  })
}
// Page-level grab-cursor CSS for eligible twimg media previews, built once at
// module load. The video poster sections come from `VIDEO_PREVIEW_SECTIONS` in
// core/adapters/x/dom.ts — the same constant `isGrabbableMediaPreviewUrl` tests —
// so a new poster section is added once and both the predicate and this CSS follow.
// (`/media` photos stay special: img src+srcset, never a video poster.)
const GRAB_CURSOR_CSS = `${[
  'img[src*="pbs.twimg.com/media"]',
  'img[srcset*="pbs.twimg.com/media"]',
  ...VIDEO_PREVIEW_SECTIONS.flatMap((s) => [
    `img[src*="pbs.twimg.com/${s}"]`,
    `video[poster*="pbs.twimg.com/${s}"]`,
  ]),
].join(',')}{cursor:copy}`

const isImageElement = (el: Element): el is HTMLImageElement => el.tagName === 'IMG'
const isVideoElement = (el: Element): el is HTMLVideoElement => el.tagName === 'VIDEO'

const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect()
  return { top: r.top, left: r.left, width: r.width, height: r.height }
}

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
const nonInteractiveMediaAt = (
  container: Element,
  x: number,
  y: number,
): HoverMediaElement | null => {
  for (const el of container.querySelectorAll('img,video')) {
    if (!isImageElement(el) && !isVideoElement(el)) continue
    if (getComputedStyle(el).pointerEvents !== 'none') continue
    const r = el.getBoundingClientRect()
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return el
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
const mediaAtPoint = (
  stack: readonly Element[],
  x: number,
  y: number,
): HoverMediaElement | null => {
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
const videoAnchorAt = (
  target: Element | null,
  stack: readonly Element[],
): HTMLVideoElement | null => {
  const fromTarget = target?.closest(VIDEO_PLAYER_SEL)?.querySelector('video')
  if (fromTarget) return fromTarget
  for (const el of stack) {
    if (el.tagName === 'XMD-OVERLAY') return null
    const video = el.closest(VIDEO_PLAYER_SEL)?.querySelector('video')
    if (video) return video
  }
  return null
}

/** A real visible `<img>`/`<video>` under the cursor, else the hovered X video
 *  player. Walks the `elementsFromPoint(x, y)` stack ONCE and threads it to both
 *  `mediaAtPoint` and `videoAnchorAt`. */
const resolveHoverMedia = (
  target: Element | null,
  x: number,
  y: number,
): HoverMediaElement | null => {
  const direct = target?.closest('img,video') as HoverMediaElement | null
  if (direct) return direct
  const stack = document.elementsFromPoint(x, y)
  return mediaAtPoint(stack, x, y) ?? videoAnchorAt(target, stack)
}

// A reloaded/updated extension orphans this content script: the runtime channel
// is dead and every send fails. That is a stale tab, not a download failure —
// tell the user once how to recover instead of failing silently.
let contextLostNotified = false
const notifyContextLost = (): void => {
  if (contextLostNotified) return
  contextLostNotified = true
  console.warn(
    '[XMD] This tab is running a stale copy of the extension (it was reloaded or updated). Refresh the page to keep downloading.',
  )
}

/** Fire-and-forget post (telemetry): never throws; a dead context hints reload once. */
const postEvent = (msg: unknown): void => {
  void (async () => {
    const out = await safeSend(() => browser.runtime.sendMessage(msg))
    if (out.status === 'context-invalidated') notifyContextLost()
  })()
}

type SkipSummary = ReadonlyArray<{
  readonly requestId: string
  readonly reason: string
}>

// Friendly labels for admission-gate skip reasons (mirrors SkipReason).
const SKIP_LABELS: Record<string, string> = {
  'filtered-type': 'filtered',
  'too-small': 'too small',
  'too-big': 'too big',
  'daily-budget': 'daily limit',
}

/** Surface why media was dropped by the gate. The overlay has no toast surface,
 *  so — like notifyContextLost — this goes to the console. */
const reportSkipped = (skipped?: SkipSummary): void => {
  if (!skipped || skipped.length === 0) return
  const totals = new Map<string, number>()
  for (const { reason } of skipped) totals.set(reason, (totals.get(reason) ?? 0) + 1)
  const parts = [...totals].map(([reason, count]) => `${count} ${SKIP_LABELS[reason] ?? reason}`)
  console.info(`[XMD] ${skipped.length} skipped — ${parts.join(', ')}`)
}

/** Surface why a request reached the download strategy but failed to START —
 *  the strategy's own `DownloadError.reason` (a 403/network/CDN failure), NOT
 *  an admission-gate skip (that's `reportSkipped`). Previously this reason only
 *  ever reached the background service worker's own (separately-inspected)
 *  console; this is the same information, in the tab's own console. */
const reportFailures = (failures?: ReadonlyArray<{ requestId: string; reason: string }>): void => {
  if (!failures || failures.length === 0) return
  console.warn(
    `[XMD] ${failures.length} download(s) FAILED to start —`,
    failures.map((f) => `${f.requestId}: ${f.reason}`).join('; '),
  )
}

/** Send one DownloadRequest batch and prove the background accepted its start. */
const sendTrackedBatch = (
  items: ReadonlyArray<MediaItem>,
  clearExpect?: ClearExpect,
): Promise<TrackedStart> =>
  safeSend(() =>
    browser.runtime.sendMessage({
      _tag: 'DownloadRequest',
      items,
      ...(clearExpect ? { clearExpect } : {}),
    }),
  ).then((sent) => {
    const out = expectReply(sent)
    if (out.status === 'context-invalidated') {
      notifyContextLost()
      return { _tag: 'context' }
    }
    if (out.status === 'error') {
      // The send itself rejected (an async failure `safeSend` didn't classify as
      // context-invalidation — most likely an uncaught exception inside
      // background.ts's DownloadRequest handler, before it could even build a
      // reply). Previously silently discarded; log it so "why did this fail?"
      // doesn't require opening the SW's own separate devtools context.
      console.warn('[XMD] DownloadRequest send FAILED —', out.error)
      return { _tag: 'transport' }
    }
    if (out.status === 'unclaimed') return { _tag: 'unclaimed' }
    const r = decodeQueueUpdate(out.reply, items)
    if (r === undefined) return { _tag: 'invalid-reply' }
    reportSkipped(r.skipped)
    reportFailures(r.failures)
    return r.skipped.length === 0 && r.failures.length === 0
      ? { _tag: 'started' }
      : { _tag: 'partial' }
  })

/** Partition producer input before sending each safe DownloadRequest batch. */
const sendTracked = (
  items: ReadonlyArray<MediaItem>,
  clearExpect?: ClearExpect,
): Promise<TrackedStart> => sendTrackedBatches({ items, clearExpect, sendOne: sendTrackedBatch })

const traceDownloadUi =
  (source: 'quickgrab' | 'badge') =>
  (
    stage: string,
    opts: {
      readonly item?: MediaItem
      readonly key?: string
      readonly elapsedMs?: number
      readonly detail?: string
    } = {},
  ): void => {
    // Dev-only: mirror the trace to the page console so "why didn't it grab" is
    // visible live in the x.com DevTools (e.g. `[XMD] quickgrab no-item-for-hover`).
    if (import.meta.env.DEV) {
      const tag = opts.item
        ? `${opts.item.type}#${opts.item.id}`
        : opts.key
          ? `key ${opts.key}`
          : ''
      console.debug(`[XMD] ${source} ${stage}`, tag, opts.detail ?? '')
    }
    postEvent({
      _tag: 'DownloadTraceEvent',
      source,
      stage,
      t: Date.now(),
      ...(opts.item
        ? {
            itemId: mediaRequestId(opts.item),
            tweetId: opts.item.postId,
            type: opts.item.type,
          }
        : {}),
      ...(opts.elapsedMs !== undefined ? { elapsedMs: opts.elapsedMs } : {}),
      ...((opts.detail ?? opts.key) ? { detail: opts.detail ?? `key ${opts.key}` } : {}),
    })
  }

const traceQuickGrab = traceDownloadUi('quickgrab')
const traceBadge = traceDownloadUi('badge')

/** Accessible name for the badge by the one Media Item it downloads. */
const BADGE_ARIA: Record<MediaItem['type'], string> = {
  photo: 'Download photo',
  video: 'Download video',
  gif: 'Download GIF',
}

/** Pill copy per launcher phase; the idle copy doubles as the hover-revealed action label. */
const LAUNCHER_LABEL: Record<DownloadAffordanceSnapshot['launcher'], string> = {
  idle: 'Download all',
  queued: 'Saving…',
  saved: 'Saved',
  failed: 'Retry',
}

/** The stacked phase glyphs (arrow / spinner / check / alert) shared by badge and launcher. */
function PhaseGlyphs({ block }: { readonly block: 'xmd-badge' | 'xmd-launcher' }) {
  const icon = (name: string): string => `${block}__icon ${block}__icon--${name}`
  return (
    <>
      <span class={icon('arrow')} aria-hidden="true">
        <svg viewBox="0 0 20 20" focusable="false">
          <path
            d="M10 3.75v8.5m0 0 3.25-3.25M10 12.25 6.75 9M5 15.75h10"
            fill="none"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="1.9"
          />
        </svg>
      </span>
      <span class={icon('spinner')} aria-hidden="true">
        <svg viewBox="0 0 20 20" focusable="false">
          <circle
            cx="10"
            cy="10"
            r="6.5"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-dasharray="28 13"
          />
        </svg>
      </span>
      <span class={icon('check')} aria-hidden="true">
        <svg viewBox="0 0 20 20" focusable="false">
          <path
            d="M5.5 10.5l3 3L14.5 7"
            fill="none"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2.2"
          />
        </svg>
      </span>
      <span class={icon('alert')} aria-hidden="true">
        <svg viewBox="0 0 20 20" focusable="false">
          <path
            d="M10 4.5v7m0 3.5v.01"
            fill="none"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-width="2.2"
          />
        </svg>
      </span>
    </>
  )
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
const previewSrcFromMedia = (media: HoverMediaElement): string =>
  isVideoElement(media)
    ? (videoPosterUrl(media) ?? (media.poster || media.currentSrc || media.src))
    : media.currentSrc || media.src

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
const previewKeyFromMedia = (
  adapter: PlatformAdapter,
  media: HoverMediaElement | null,
): string | null => {
  if (!media) return null
  const urlKey = adapter.mediaKeyFromUrl(previewSrcFromMedia(media))
  if (urlKey) return urlKey
  return isVideoElement(media)
    ? (adapter.postKeyFromVideoElement?.(media, location.pathname) ?? null)
    : null
}

/** Is `media` still under the pointer? A hidden X `<video>` is never in
 *  `elementsFromPoint`, so accept when the cursor is still over its player. */
const mediaStillUnderPointer = (media: HoverMediaElement, x: number, y: number): boolean => {
  const stack = document.elementsFromPoint(x, y)
  if (stack.includes(media)) return true
  if (!isVideoElement(media)) return false
  const container = media.closest(VIDEO_PLAYER_SEL)
  return !!container && stack.some((el) => container.contains(el))
}

/**
 * ISOLATED content script: detects MediaItems from the MAIN-world tee, then
 * renders a global launcher for bulk downloads and the Quick Grab ring for the
 * precise hover path, in a style-isolated Shadow Root (grounding §e).
 *
 * Quick Grab (the literal hover path): hold the configured modifier and media
 * under the cursor downloads itself at Original quality after a short dwell. A
 * ring + progress charge shows what's about to happen (and a window to bail); the
 * pure `core/quickgrab` state machine fires each media item at most once per press.
 *
 * Note: the hover anchor matches rendered `<img>`/`<video poster>` elements to detected items by
 * twimg media key. Photos can also fall back to a DOM-only resolver; videos/GIFs
 * need the passive GraphQL tee so their poster can map to the MP4 item.
 */
export default defineContentScript({
  matches: [...allPlatformHostMatch()],
  cssInjectionMode: 'ui',
  async main(ctx) {
    // Boot-time adapter selection: resolved ONCE, closed over for the rest of
    // main() — no per-call registry dispatch on the hover/mousemove hot path.
    // Fail closed: an unrecognized host (shouldn't happen given `matches`
    // scoping, but defensive for dev/test contexts) mounts nothing at all —
    // none of the X-only clear/capture/reveal machinery below ever runs.
    const adapter = adapterForHostname(location.hostname)
    if (!adapter) return
    // Whole-post grab (Cmd augment) is Instagram/Threads-only by product decision.
    const platform = adapter.platform
    const postGrabEligible = platform === 'instagram' || platform === 'threads'
    // Boot marker: if you don't see this in the X page console, the content
    // script isn't live on this tab (old build loaded, or the tab predates the
    // extension reload) — reload the extension AND refresh the tab.
    console.info('[XMD] overlay content script loaded @', location.href, platform)

    const store = makeDetectionStore({
      mediaKeyFromUrl: adapter.mediaKeyFromUrl,
    })
    let host: HTMLElement | null = null

    // Quick Grab state. `qgEnabled` fails CLOSED: a user who turned the feature
    // off must never see it fire in the window before stored settings arrive.
    let qgEnabled = false
    let qgModifier: GrabModifier = 'alt'
    let grab: QuickGrabState = idleQuickGrab
    // Whether the Cmd augment is held right now (all-mode). Tracked as a scalar
    // because the dwell fires on a timer with no event in hand.
    let postGrabArmed = false
    let hoverMedia: HoverMediaElement | null = null
    let hoverKey: string | null = null
    // Phases: charging (dwell running) → queued (background handoff pending) →
    // saved | failed; `noted` re-acknowledges an already-grabbed item.
    let grabUi: {
      key: string
      rect: Rect
      phase: QuickGrabUiPhase
      all?: boolean
      allCount?: number
    } | null = null
    let dwell: ReturnType<typeof setTimeout> | null = null
    let cursorStyle: HTMLStyleElement | null = null
    let lastX = 0
    let lastY = 0
    let pointerSeen = false
    let hoverArmedAt = 0
    let scrollHitTestQueued = false

    // Download badge (per-media fast path). `badgeEnabled` fails closed like
    // `qgEnabled`: nothing renders until stored settings arrive.
    let badgeEnabled = false

    // Download-all launcher hand-off feedback; one batch in flight at a time.
    // `dockEnabled` fails closed (like the badge): the dock stays hidden until
    // stored settings arrive, so a user who turned it off never sees a flash.
    // `dockGlass` is cosmetic only (glass lens vs. solid pill), so it defaults on.
    let dockEnabled = false
    let dockGlass = true
    let rescanning = false
    let rescanSpin: ReturnType<typeof setTimeout> | null = null

    // Auto-show sensitive content. `autoRevealEnabled` fails closed: nothing is
    // clicked until stored settings arrive and the user has opted in. The
    // `WeakSet` records every reveal control we've already clicked so the
    // mutation-driven re-scan never re-fires one as the timeline streams.
    let autoRevealEnabled = false
    let revealObserver: MutationObserver | null = null
    let revealQueued = false
    const revealedControls = new WeakSet<Element>()

    const rerender = (): void => {
      if (host) render(<Overlay />, host)
    }
    const renderedMedia = makeRenderedMediaLifecycle({
      clock: {
        requestAnimationFrame: (task) => ctx.requestAnimationFrame(task),
        after: (ms, task) => {
          const timer = setTimeout(task, ms)
          return () => clearTimeout(timer)
        },
      },
      detect: () =>
        store.reconcileDetected(adapter.detectRenderedMedia(document, location.pathname)).changed,
      clear: store.clear,
      recoveryCandidates: () =>
        adapter.findMediaNeedingRecovery?.(document, new Set(store.keyIndex().keys())) ?? [],
      markRecoveryAttempt: store.markAttempted,
      unmarkRecoveryAttempt: store.unmarkAttempted,
      recover: async (tweetId) => {
        const out = await safeSend(() =>
          browser.runtime.sendMessage({
            _tag: 'RecoverTweetMediaRequest',
            tweetId,
          }),
        )
        if (out.status === 'context-invalidated') return { status: 'context-invalidated' as const }
        if (out.status !== 'ok') return { status: 'failed' as const }
        const reply = decodeRecoverTweetMediaResponse(out.reply)
        return reply === undefined
          ? { status: 'failed' as const }
          : { status: 'ok' as const, body: reply.body }
      },
      reconcileRecovered: (body) => {
        try {
          return store.reconcileRecovered(parseSyndicationTweet(JSON.parse(body))).changed
        } catch {
          return false
        }
      },
      onContextInvalidated: notifyContextLost,
      rerender,
    })

    // Reveal sensitive-content covers, coalescing a burst of DOM mutations into a
    // single rAF pass. Each reveal renders new media, which the rendered-media
    // scan then picks up on its own cadence.
    const queueReveal = (): void => {
      if (revealQueued || !autoRevealEnabled) return
      revealQueued = true
      ctx.requestAnimationFrame(() => {
        revealQueued = false
        if (autoRevealEnabled) clickSensitiveReveals(document, revealedControls)
      })
    }

    // Observe the document only while the opt-in is on (zero cost when off). The
    // observer fires on X's constant timeline churn; `queueReveal` debounces it
    // to one querySelectorAll sweep per frame.
    const setAutoReveal = (on: boolean): void => {
      autoRevealEnabled = on
      if (on && revealObserver === null) {
        revealObserver = new MutationObserver(queueReveal)
        revealObserver.observe(document.body, {
          childList: true,
          subtree: true,
        })
        queueReveal()
      } else if (!on && revealObserver !== null) {
        revealObserver.disconnect()
        revealObserver = null
      }
    }

    // Collapse the leftover "Not interested" feedback stub so a cleared For-You post
    // fully vanishes instead of lingering as a "Thanks…/Show fewer/isn't relevant"
    // panel. Page-level CSS (the cell lives in X's DOM, not our Shadow host) hides
    // the stub cell's content; a debounced observer re-marks cells as the timeline
    // churns — content-based, so a virtualized cell recycled to a real post is shown
    // again. On only while the For-You "Not interested" clear is enabled.
    let stubStyle: HTMLStyleElement | null = null
    let stubObserver: MutationObserver | null = null
    let stubScanQueued = false
    const queueStubScan = (): void => {
      if (stubScanQueued || stubObserver === null) return
      stubScanQueued = true
      ctx.requestAnimationFrame(() => {
        stubScanQueued = false
        if (stubObserver !== null) collapseClearedStubs(document)
      })
    }
    const setStubCollapse = (on: boolean): void => {
      if (on && stubObserver === null) {
        stubStyle = document.createElement('style')
        stubStyle.textContent = CLEARED_STUB_CSS
        document.head.appendChild(stubStyle)
        stubObserver = new MutationObserver(queueStubScan)
        stubObserver.observe(document.body, { childList: true, subtree: true })
        collapseClearedStubs(document)
      } else if (!on && stubObserver !== null) {
        stubObserver.disconnect()
        stubObserver = null
        stubStyle?.remove()
        stubStyle = null
        for (const c of document.querySelectorAll(`[${CLEARED_STUB_ATTR}]`))
          c.removeAttribute(CLEARED_STUB_ATTR)
      }
    }

    // Tweet-text harvest gate + breadth flag (§7); applySettings keeps them live.
    let captureEnabled = false
    let captureAllScrolled = false
    let clearVisibilityPulseTimer: ReturnType<typeof setTimeout> | null = null
    let clearVisibilityObserver: MutationObserver | null = null
    const savedStatus = makeSavedStatusLifecycle({
      document,
      debounceMs: SAVED_SWEEP_DEBOUNCE_MS,
      clock: {
        after: (ms, task) => {
          const timer = setTimeout(task, ms)
          return () => clearTimeout(timer)
        },
      },
      inScope: () => isSavedStatusScope(location.pathname),
      requestSavedStatus,
    })

    /** Bounded, debounced wake-up only. The worker decides whether any durable
     * entry is ready; this page's mounted ids grant it no authority. */
    const scheduleClearVisibilityPulse = (): void => {
      if (clearVisibilityPulseTimer !== null) clearTimeout(clearVisibilityPulseTimer)
      clearVisibilityPulseTimer = setTimeout(() => {
        clearVisibilityPulseTimer = null
        const tweetIds = [
          ...new Set(
            [...document.querySelectorAll(TWEET_ARTICLE_SEL)]
              .map((article) => Option.getOrNull(tweetIdOfArticle(article)))
              .filter((tweetId): tweetId is string => tweetId !== null),
          ),
        ].slice(0, 100)
        if (tweetIds.length === 0) return
        void safeSend(() =>
          browser.runtime.sendMessage({
            _tag: 'ClearVisibilityPulse',
            tweetIds,
          }),
        )
      }, CLEAR_VISIBILITY_PULSE_DEBOUNCE_MS)
    }
    if (platform === 'x') {
      clearVisibilityObserver = new MutationObserver(scheduleClearVisibilityPulse)
      clearVisibilityObserver.observe(document.body, {
        childList: true,
        subtree: true,
      })
      scheduleClearVisibilityPulse()
    }

    const clearDwell = (): void => {
      if (dwell !== null) {
        clearTimeout(dwell)
        dwell = null
      }
    }

    /** Toggle a page-level grab cursor on eligible media previews while the modifier is held. */
    const setCursorActive = (on: boolean): void => {
      if (on && !cursorStyle) {
        cursorStyle = document.createElement('style')
        cursorStyle.textContent = GRAB_CURSOR_CSS
        document.head.appendChild(cursorStyle)
      } else if (!on && cursorStyle) {
        cursorStyle.remove()
        cursorStyle = null
      }
    }

    // Whether `m` is still the armed media at fire-time: attached, the same
    // twimg key, and under the pointer. A hidden X `<video>` is matched via its
    // player container by `mediaStillUnderPointer`.
    const holdsKey = (m: HoverMediaElement, key: string): boolean =>
      m.isConnected &&
      previewKeyFromMedia(adapter, m) === key &&
      mediaStillUnderPointer(m, lastX, lastY)

    // The media to grab once the dwell elapses. Prefer the armed node, but X's
    // timeline is virtualized: it can recycle that exact node out from under the
    // pointer mid-dwell. So if the armed node went stale, re-resolve the LIVE media
    // at the pointer once — a fresh node showing the same image at the same spot is
    // still the grab the user asked for — and accept it only if its key still
    // matches. Null ⇒ the media truly moved on; drop the grab.
    const liveGrabTarget = (armed: HoverMediaElement, key: string): HoverMediaElement | null => {
      if (holdsKey(armed, key)) return armed
      const live = resolveHoverMedia(
        document.elementsFromPoint(lastX, lastY)[0] ?? null,
        lastX,
        lastY,
      )
      return live && holdsKey(live, key) ? live : null
    }

    // For You: tag a download with the post's FULL detected media set, so the
    // "Not interested" clear waits for the WHOLE post — a single grabbed photo must
    // never hide a 4-photo post and lose the other three (the clear fires only once
    // every photo is grabbed, or Download-all'd). Null off the feed: there the
    // grabbed subset gates the page's un-bookmark/un-like, unchanged.
    const forYouClearExpect = (items: ReadonlyArray<MediaItem>): ClearExpect | undefined => {
      if (!isForYouHome(location.pathname, document)) return undefined
      return makeClearExpect(items, store.valuesForTweet)
    }

    const affordances = makeDownloadAffordances({
      clock: {
        now: Date.now,
        after: (ms, task) => {
          const timer = setTimeout(task, ms)
          return () => clearTimeout(timer)
        },
      },
      rerender,
      resolveItem: (media, key) =>
        adapter.resolveHoverItem(media, key, store.keyIndex(), location.pathname),
      mediaIsCurrent: (media, key) =>
        media.isConnected && previewKeyFromMedia(adapter, media) === key,
      allItems: store.values,
      clearExpect: forYouClearExpect,
      sendTracked,
      trace: (source, stage, opts) =>
        (source === 'quickgrab' ? traceQuickGrab : traceBadge)(stage, opts),
    })

    const fireGrab = (armed: HoverMediaElement, key: string): void => {
      dwell = null
      const media = liveGrabTarget(armed, key)
      if (media === null) {
        grabUi = null
        rerender()
        return
      }
      const item = adapter.resolveHoverItem(media, key, store.keyIndex(), location.pathname)
      if (!item) {
        traceQuickGrab('no-item-for-hover', { key })
        grabUi = null
        rerender()
        return
      }
      grab = markGrabbed(grab, key)
      const all = postGrabArmed
      let items: MediaItem[] = [item]
      if (all) {
        // Resolve the WHOLE post from the DOM post anchor, NOT the hovered
        // media's own url key: an Instagram/Threads photo's rendered `<img>`
        // basename can differ from the tee's captured basename, so the hovered
        // item falls back to a placeholder whose `postId` is its own media key
        // (grouping nothing) — `valuesForTweet` on it would return just itself.
        // The post's DOM shortcode → the tee's real `postId` recovers the whole
        // detected set (all slides, best quality). Falls back to the hovered
        // item alone when the tee hasn't linked/seen this post yet.
        const code = adapter.postCodeFromElement?.(media, location.pathname) ?? null
        const codePostId = code ? store.postIdForCode(code) : undefined
        const teePost = codePostId ? store.valuesForTweet(codePostId) : []
        items =
          teePost.length > 0 ? teePost : postGrabItems(item, store.valuesForTweet(item.postId))
        // Mark every key of the resolved post so a cursor sweep across sibling
        // slides doesn't re-charge the ring (downstream the gate dedups anyway).
        grab = markAllGrabbed(grab, [
          ...store.keysForTweet(item.postId),
          ...(codePostId ? store.keysForTweet(codePostId) : []),
        ])
      }
      // After the dwell completes, move out of the charge state immediately.
      // The background reply then confirms whether the browser/aria2 handoff started.
      grabUi = all
        ? {
            key,
            rect: rectOf(media),
            phase: 'queued',
            all: true,
            allCount: items.length,
          }
        : { key, rect: rectOf(media), phase: 'queued' }
      rerender()
      affordances.launchQuickGrab({
        items,
        item,
        armedAt: hoverArmedAt,
        isStale: () => grabUi === null || grabUi.key !== key,
        resolve: (ok) => {
          if (grabUi) grabUi = { ...grabUi, phase: ok ? 'saved' : 'failed' }
        },
      })
    }

    /** Begin (or, if already grabbed this press, just acknowledge) a hovered media item. */
    const armHover = (media: HoverMediaElement, key: string): void => {
      if (canGrab(grab, key)) {
        grabUi = {
          key,
          rect: rectOf(media),
          phase: 'charging',
          all: postGrabArmed,
        }
        rerender()
        hoverArmedAt = Date.now()
        traceQuickGrab('armed', { key })
        dwell = setTimeout(() => fireGrab(media, key), quickGrabDwellMs)
      } else {
        grabUi = {
          key,
          rect: rectOf(media),
          phase: 'noted',
          all: postGrabArmed,
        }
        rerender()
      }
    }

    /** Move the hover focus to `media`/`key` (either may be null), re-arming as needed. */
    const focusHover = (media: HoverMediaElement | null, key: string | null): void => {
      if (key === hoverKey && media === hoverMedia) return
      clearDwell()
      hoverMedia = media
      hoverKey = key
      if (grab.active && media && key) {
        armHover(media, key)
      } else {
        grabUi = null
        rerender()
      }
    }

    const releaseAll = (): void => {
      if (!grab.active && grabUi === null) return
      grab = releaseModifier()
      clearDwell()
      setCursorActive(false)
      postGrabArmed = false
      grabUi = null
      rerender()
    }

    // Update all-mode and, if a ring is already up (charging/noted), re-label it
    // live so pressing/releasing Cmd without moving the cursor is reflected.
    const refreshPostGrabArmed = (next: boolean): void => {
      if (next === postGrabArmed) return
      postGrabArmed = next
      if (grabUi && (grabUi.phase === 'charging' || grabUi.phase === 'noted')) {
        grabUi = { ...grabUi, all: next }
        rerender()
      }
    }

    const syncGrabFromPointer = (e: MouseEvent): boolean => {
      const next = syncModifierFromFlags(grab, e, qgModifier)
      if (next === grab) return grab.active
      if (!next.active) {
        releaseAll()
        return false
      }
      grab = next
      setCursorActive(true)
      return true
    }

    const focusBadge = (media: HoverMediaElement | null, key: string | null): void => {
      affordances.apply({
        enabled: badgeEnabled,
        modifierHeld: grab.active,
        media,
        key,
        resolvable:
          media !== null &&
          key !== null &&
          adapter.canResolveHoverItem(media, key, store.keyIndex()),
      })
    }

    const resetBadge = (): void => focusBadge(null, null)

    const onBadgeClick = (e: MouseEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      affordances.onBadgeClick()
    }

    const onLauncherClick = (): void => affordances.launchAll()

    const clearRescanSpin = (): void => {
      if (rescanSpin !== null) {
        clearTimeout(rescanSpin)
        rescanSpin = null
      }
      rescanning = false
    }

    /** The popup's "Find new media", relocated: drop stale picks and rescan in place.
        The work is instant; the glyph spins long enough to read as an action. */
    const onRescanClick = (): void => {
      if (rescanning) return
      clearDwell()
      setCursorActive(false)
      grab = idleQuickGrab
      grabUi = null
      affordances.onRouteChange()
      renderedMedia.rescan()
      rescanning = true
      rerender()
      rescanSpin = setTimeout(() => {
        rescanSpin = null
        rescanning = false
        rerender()
      }, 700)
    }

    // Settings reach open tabs live (popup writes → storage watch). Any change
    // disarms an active grab: a swapped modifier would otherwise never see its
    // keyup, leaving grab mode stuck on.
    const applySettings = (s: ContentSettings): void => {
      qgEnabled = s.quickGrabEnabled
      qgModifier = s.quickGrabModifier
      badgeEnabled = s.downloadBadgeEnabled
      dockEnabled = s.downloadDockEnabled
      dockGlass = s.dockGlassEnabled
      // Sensitive-content auto-reveal + the "Not interested" stub-collapse are both
      // X-only (X-specific data-testid selectors, no Instagram/Threads equivalent):
      // gate their observer setup so no MutationObserver is even constructed there.
      if (platform === 'x') setAutoReveal(s.autoRevealSensitiveEnabled)
      // Hide the cleared-post feedback stub only when the For-You "Not interested"
      // clear is actually active (master + the per-scope toggle on).
      if (platform === 'x') setStubCollapse(s.clearOnSave && s.autoNotInterestedOnSave)
      // Cross-device "Saved" status: gate the sweep on the toggle; a flip re-paints.
      // X-only (SavedIndex/Convex queries + TWEET_ARTICLE_SEL are X-DOM-specific):
      // don't even arm the debounce timer on Instagram/Threads.
      if (platform === 'x') savedStatus.apply(s.showSavedStatus)
      // Tweet-text harvest (§7): default OFF. `captureAllScrolled` widens breadth
      // from media/thread tweets to every scrolled text-only tweet.
      captureEnabled = s.captureEnabled
      captureAllScrolled = s.captureAllScrolled
      // Surface clear-on-save state in the PAGE console (the one you can see here),
      // so "why didn't it un-like?" is answerable without the SW console: if
      // clearOnSave is false, nothing ever clears — turn it on in the popup.
      if (import.meta.env.DEV)
        clearLog(
          `settings · clearOnSave=${s.clearOnSave} unbookmark=${s.autoUnbookmarkOnSave} unlike=${s.autoUnlikeOnSave} strategy=${s.downloadStrategy}`,
        )
      resetBadge()
      releaseAll()
      rerender()
    }
    const settingsSession = startContentSettings(applySettings)
    void settingsSession.initial

    /** The per-media download badge, anchored to the photo's bottom-right corner. */
    function BadgeButton({ media }: { readonly media: HoverMediaElement }) {
      const { badge } = affordances.snapshot()
      const r = rectOf(media)
      const lightbox = media.closest('[aria-modal="true"], [role="dialog"]') !== null
      const inset = lightbox ? 12 : 10
      const type = badge.key ? store.resolve(badge.key)?.type : undefined
      return (
        <button
          type="button"
          class={`xmd-badge xmd-badge--${badge.phase}${lightbox ? ' xmd-badge--lightbox' : ''}`}
          style={{
            top: `${r.top + inset}px`,
            left: `${r.left + inset}px`,
          }}
          aria-label={BADGE_ARIA[type ?? 'photo']}
          aria-busy={badge.phase === 'queued'}
          onClick={onBadgeClick}
        >
          <PhaseGlyphs block="xmd-badge" />
        </button>
      )
    }

    function Overlay() {
      const { badge, badgeMedia, launcher } = affordances.snapshot()
      return (
        <>
          {grabUi && (
            <div
              key={grabUi.key}
              class={`xmd-grab xmd-grab--${grabUi.phase}`}
              style={{
                top: `${grabUi.rect.top}px`,
                left: `${grabUi.rect.left}px`,
                width: `${grabUi.rect.width}px`,
                height: `${grabUi.rect.height}px`,
                '--xmd-dwell': `${quickGrabDwellMs}ms`,
              }}
            >
              <span class="xmd-grab__badge">
                {quickGrabBadgeLabel(
                  grabUi.phase,
                  grabUi.all ? { count: grabUi.allCount ?? 0 } : undefined,
                )}
              </span>
              {grabUi.phase === 'charging' && (
                <span key={`${grabUi.key}:charge`} class="xmd-grab__frame" aria-hidden="true">
                  <span class="xmd-grab__edge xmd-grab__edge--top" />
                  <span class="xmd-grab__edge xmd-grab__edge--right" />
                  <span class="xmd-grab__edge xmd-grab__edge--bottom" />
                  <span class="xmd-grab__edge xmd-grab__edge--left" />
                </span>
              )}
            </div>
          )}
          {badge.phase !== 'hidden' && badgeMedia?.isConnected && (
            <BadgeButton key={badge.key} media={badgeMedia} />
          )}
          {dockEnabled && store.count > 0 && (
            <div
              class={`xmd-launcher xmd-launcher--${launcher}${
                dockGlass ? ' xmd-launcher--glass' : ''
              }${rescanning ? ' xmd-launcher--rescanning' : ''}`}
            >
              <button
                type="button"
                class="xmd-launcher__dl"
                aria-label={`Download all detected media (${store.count})`}
                aria-busy={launcher === 'queued'}
                onClick={onLauncherClick}
              >
                <span class="xmd-launcher__glyph">
                  <PhaseGlyphs block="xmd-launcher" />
                </span>
                <span class="xmd-launcher__count" aria-hidden="true">
                  <span key={store.count} class="xmd-launcher__num">
                    {store.count}
                  </span>
                </span>
                <span class="xmd-launcher__tip" aria-hidden="true">
                  {LAUNCHER_LABEL[launcher]}
                </span>
              </button>
              <span class="xmd-launcher__rule" aria-hidden="true" />
              <button
                type="button"
                class="xmd-launcher__rescan"
                aria-label="Find new media: clear stale picks and rescan"
                onClick={onRescanClick}
              >
                <svg viewBox="0 0 20 20" focusable="false" aria-hidden="true">
                  <path
                    d="M16.25 10a6.25 6.25 0 1 1-1.83-4.42M16.25 3.5v3.25H13"
                    fill="none"
                    stroke="currentColor"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="1.9"
                  />
                </svg>
                <span class="xmd-launcher__tip" aria-hidden="true">
                  Find new media
                </span>
              </button>
            </div>
          )}
        </>
      )
    }

    const ui = await createShadowRootUi(ctx, {
      name: 'xmd-overlay',
      position: 'inline',
      anchor: 'body',
      onMount: (container) => {
        host = container
        rerender()
        renderedMedia.settle()
        return container
      },
      onRemove: (container) => {
        host = null
        if (container) render(null, container)
      },
    })
    ui.mount()

    // Tweet-text harvest producer (§7): the only state is this bounded pending
    // buffer plus one debounce timer — no per-session identity Set. Re-sending a
    // tweet is a cheap no-op at the durable merge (§6.4), which is what lets a
    // later rich TweetDetail sighting upgrade an earlier thin timeline one.
    const CAPTURE_FLUSH_DEBOUNCE_MS = 750
    let captureStateLogged = false
    let captureBuffer: CaptureBuffer | undefined
    const installCaptureEpoch = (epoch: CaptureEpoch): void => {
      if (captureBuffer !== undefined) {
        captureBuffer.advanceEpoch(epoch)
        return
      }
      captureBuffer = makeCaptureBuffer({
        epoch,
        maxBatch: MAX_CAPTURE_BATCH,
        maxPending: MAX_CAPTURE_PENDING,
        debounceMs: CAPTURE_FLUSH_DEBOUNCE_MS,
        retryBaseMs: 1_000,
        retryMaxMs: 30_000,
        clock: {
          after: (ms, task) => {
            const timer = setTimeout(task, ms)
            return () => clearTimeout(timer)
          },
        },
        send: async (records, batchEpoch) => {
          console.info(`[XMD] capture flush → sending ${records.length} record(s)`)
          const out = expectReply(
            await safeSend(() =>
              browser.runtime.sendMessage({
                _tag: 'CaptureTweets',
                epoch: batchEpoch,
                records,
              } satisfies CaptureTweets),
            ),
          )
          if (out.status === 'context-invalidated') notifyContextLost()
          const receipt =
            out.status === 'ok' ? decodeCaptureAcceptedAck(out.reply, records.length) : undefined
          if (receipt?._tag === 'CaptureStored' && receipt.mirror === 'unavailable')
            console.warn('[XMD] Capture stored locally; mirror outbox is full')
          return receipt
        },
      })
    }
    const captureEpochRefresh = makeCaptureEpochRefresh({
      read: async () => {
        const reply = expectReply(
          await safeSend(() =>
            browser.runtime.sendMessage({
              _tag: 'CaptureEpochRequest',
            } satisfies CaptureEpochRequest),
          ),
        )
        if (reply.status === 'context-invalidated') notifyContextLost()
        return reply.status === 'ok' ? decodeCaptureEpochResult(reply.reply)?.epoch : undefined
      },
      beforeRefresh: () => captureBuffer?.invalidateEpoch(),
      accept: installCaptureEpoch,
      clock: {
        after: (ms, task) => {
          const timer = setTimeout(task, ms)
          return () => clearTimeout(timer)
        },
      },
      retryBaseMs: 1_000,
      retryMaxMs: 30_000,
    })
    const handleCaptureEpochChanged = (
      message: unknown,
      sender: MessageSenderLike | undefined,
    ): void => {
      if (
        !isFromExtensionWorker(sender, browser.runtime.id) ||
        decodeCaptureEpochChanged(message) === undefined
      )
        return
      void captureEpochRefresh.refresh()
    }
    // Watch first, then pull. A Clear racing initial mount cannot strand E0.
    browser.runtime.onMessage.addListener(handleCaptureEpochChanged)
    await captureEpochRefresh.refresh()

    const harvestFrom = (json: unknown, path: string): void => {
      if (!captureEnabled) {
        if (!captureStateLogged) {
          console.info(
            '[XMD] capture DISABLED in this tab — toggle "Harvest tweets" ON, then RELOAD the x.com tab',
          )
          captureStateLogged = true
        }
        return
      }
      if (captureBuffer === undefined) {
        if (!captureStateLogged) {
          console.warn('[XMD] capture unavailable: durable erase epoch could not be read')
          captureStateLogged = true
        }
        return
      }
      const source: Source = path.includes('/TweetDetail') ? 'tweetDetail' : 'timeline'
      try {
        const records = harvestTweets(json, {
          source,
          includeTextOnly: captureAllScrolled,
          capturedAt: Date.now(),
        })
        console.info(
          `[XMD] capture harvest path=${path} source=${source} all=${captureAllScrolled} → got ${records.length} record(s)`,
        )
        if (records.length === 0) return
        const queued = captureBuffer.enqueue(records)
        if (queued.tag === 'dropped')
          console.warn(
            `[XMD] capture dropped: accepted=${queued.accepted} capacity=${queued.capacityDiscarded} invalid=${queued.invalidDiscarded} oversize=${queued.oversizeDiscarded}`,
          )
      } catch (err) {
        console.warn('[XMD] capture harvest THREW (not a media failure):', err)
      }
    }

    const ingestMediaResponse = (detail: MediaResponse): void => {
      let json: unknown
      try {
        json = JSON.parse(detail.body)
      } catch {
        return /* non-JSON tee body */
      }
      try {
        if (store.reconcileDetected(adapter.detectFromResponse(detail.path, json)).changed)
          rerender()
        // Instagram/Threads only (X omits extractPostCodes): links the DOM's
        // URL-shortcode to the tee's own postId (which may differ — e.g.
        // Instagram's numeric pk vs its /p/{code}/ shortcode), so a hovered
        // video's DOM-derived post:{code} key (see previewKeyFromMedia above)
        // resolves to the same MediaItem reconciliation indexed by postId.
        const codes = adapter.extractPostCodes?.(json)
        if (codes) for (const [postId, code] of codes) store.registerPostCode(postId, code)
      } catch {
        /* media detection is best-effort */
      }
      // Knowledge Capture is X-only-forever (design spec Non-goals): harvestTweets'
      // tree walker assumes X's tweet-node JSON shape, so never call it off-platform.
      if (platform === 'x') harvestFrom(json, detail.path) // own try/catch — never swallowed by media path
    }
    const consumeMediaResponse = makeRouteMediaResponseConsumer(
      currentMediaRoute,
      ingestMediaResponse,
    )

    // Cold-navigation blind spot: on a direct navigation to a reel/post URL,
    // the MAIN-world XHR/fetch tee above sees nothing for the first item —
    // its data arrives server-embedded in an inline <script>, not over the
    // network. LIVE-VERIFIED 2026-07-06 (real
    // https://www.instagram.com/reels/DaH4la4pRtC/ session): the first reel's
    // data sat in a RelayPrefetchedStreamCache preloader payload inside a
    // <script type="application/json">, and no <a href> or DOM node anywhere
    // in the document carried that reel's own code/pk. Run once at startup,
    // AFTER the listener above is attached, and replay every candidate inline
    // payload through the exact same 'xmd:media-response' event so it goes
    // through the identical, already-tested JSON.parse → detect →
    // registerPostCode path — no separate ingestion code to maintain. SPA
    // route changes after this are already teed live, so this is a one-shot,
    // not a MutationObserver.
    if (postGrabEligible) {
      for (const body of inlineDataPayloads(document.scripts)) {
        document.dispatchEvent(
          new CustomEvent('xmd:media-response', {
            detail: { path: 'inline:document', body, route: currentMediaRoute() },
          }),
        )
      }
    }

    // Don't lose a sub-debounce batch when the tab is navigated away or unloaded.
    ctx.addEventListener(window, 'pagehide', () => captureBuffer?.flush())
    ctx.addEventListener(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') captureBuffer?.flush()
    })

    // Quick Grab hover tracking: hold the configured modifier and hover a real
    // X media image/poster for the dwell window. No competing per-hover buttons.
    ctx.addEventListener(document, 'mousemove', (event) => {
      const e = event as MouseEvent
      lastX = e.clientX
      lastY = e.clientY
      pointerSeen = true
      if (!qgEnabled && !badgeEnabled) return
      // Pointer events are the ground truth. They both self-heal a swallowed
      // keyup and cover the common "hold modifier, then hover media" path where
      // the page never saw the initial keydown.
      const grabbing = qgEnabled && syncGrabFromPointer(e)
      refreshPostGrabArmed(postGrabActive(grab.active, e, qgModifier, postGrabEligible))
      const target = e.target as Element | null
      // Hovering this extension's own UI (the badge) must not read as leaving
      // the media underneath it — the entrance would hide before the click.
      if (target?.tagName === 'XMD-OVERLAY') return
      const media = resolveHoverMedia(target, e.clientX, e.clientY)
      const key = previewKeyFromMedia(adapter, media)
      if (grabbing) focusHover(media, key)
      focusBadge(media, key)
    })

    // The per-scroll hit-test: re-run resolution so the dwell and ring track what
    // is actually under the pointer, and refresh the rect when the same media
    // preview merely shifted. Runs inside a coalesced rAF (see queueScrollHitTest),
    // so it re-evaluates the same early-guard (pointerSeen / grab.active /
    // badge.phase) at fire time — the dwell refresh shifts by at most ~1 frame and
    // reads the freshest lastX/lastY.
    const runScrollHitTest = (): void => {
      const { badge, badgeMedia } = affordances.snapshot()
      if (!pointerSeen || (!grab.active && badge.phase === 'hidden')) return
      // Pointer parked on our own badge: the media underneath didn't change,
      // only its rect did — refresh in place rather than re-hit-testing.
      const top = document.elementsFromPoint(lastX, lastY)[0] as Element | undefined
      if (top?.tagName === 'XMD-OVERLAY') {
        if (badge.phase !== 'hidden') rerender()
        return
      }
      const media = resolveHoverMedia(top ?? null, lastX, lastY)
      const key = previewKeyFromMedia(adapter, media)
      if (media === badgeMedia && key === badge.key) {
        if (badge.phase !== 'hidden') rerender()
      } else if (badge.phase !== 'hidden') {
        focusBadge(media, key)
      }
      if (!grab.active) return
      if (media === hoverMedia && key === hoverKey) {
        if (grabUi !== null && media !== null) {
          grabUi = { ...grabUi, rect: rectOf(media) }
          rerender()
        }
        return
      }
      focusHover(media, key)
    }

    // Coalesce a burst of scroll events into a single hit-test per frame. A fast flick fires
    // scroll far more often than once per frame, so collapsing the elementsFromPoint
    // sweep to one per frame keeps the hot path off every scroll pixel.
    const queueScrollHitTest = (): void => {
      if (scrollHitTestQueued) return
      scrollHitTestQueued = true
      ctx.requestAnimationFrame(() => {
        scrollHitTestQueued = false
        runScrollHitTest()
      })
    }

    // Scroll moves content without firing mousemove. The rendered-media scan and
    // the pointer hit-test are each coalesced into their own rAF.
    ctx.addEventListener(
      document,
      'scroll',
      () => {
        renderedMedia.onScroll()
        queueScrollHitTest()
      },
      { capture: true, passive: true },
    )

    ctx.addEventListener(window, 'keydown', (event) => {
      const e = event as KeyboardEvent
      if (!qgEnabled || !isModifierKey(e.key, qgModifier)) return
      const was = grab.active
      grab = pressModifier(grab)
      postGrabArmed = postGrabActive(grab.active, e, qgModifier, postGrabEligible)
      if (grab.active && !was) {
        setCursorActive(true)
        // One affordance at a time: the ring owns the hover while the modifier is held.
        resetBadge()
        // Arm the media under the cursor — but only if a real pointer position is
        // known (no mousemove yet ⇒ lastX/lastY are still 0,0, not a real hover).
        const media = pointerSeen
          ? resolveHoverMedia(document.elementsFromPoint(lastX, lastY)[0] ?? null, lastX, lastY)
          : null
        const key = previewKeyFromMedia(adapter, media)
        hoverMedia = media
        hoverKey = key
        if (media && key) armHover(media, key)
        else rerender() // keep the page quiet when the press lands off media
      }
    })

    ctx.addEventListener(window, 'keyup', (event) => {
      if (isModifierKey((event as KeyboardEvent).key, qgModifier)) releaseAll()
    })
    ctx.addEventListener(window, 'blur', () => releaseAll())
    // The Cmd augment (grab whole post): update all-mode even without a mousemove
    // and re-label a live ring. `allAugmentModifier(qgModifier)` is read fresh each
    // event because the base modifier can change via settings at runtime.
    ctx.addEventListener(window, 'keydown', (event) => {
      const e = event as KeyboardEvent
      if (!qgEnabled || !postGrabEligible) return
      if (!isModifierKey(e.key, allAugmentModifier(qgModifier))) return
      refreshPostGrabArmed(postGrabActive(grab.active, e, qgModifier, postGrabEligible))
    })
    ctx.addEventListener(window, 'keyup', (event) => {
      const e = event as KeyboardEvent
      if (!postGrabEligible) return
      if (!isModifierKey(e.key, allAugmentModifier(qgModifier))) return
      refreshPostGrabArmed(false)
    })
    ctx.addEventListener(document, 'mouseleave', () => {
      focusHover(null, null)
      focusBadge(null, null)
    })

    ctx.addEventListener(window, 'wxt:locationchange', () => {
      releaseAll()
      affordances.onRouteChange()
      focusHover(null, null)
      renderedMedia.onLocationChange()
      savedStatus.onLocationChange()
      rerender()
    })

    // Runtime delivery reaches the same owned lifecycle as UI clicks.
    const handlerDeps: HandlerDeps = {
      adapter,
      store,
      document,
      location,
      rerender,
      onTransferOutcome: affordances.onTransferOutcome,
      sendTracked,
      notifyContextLost,
      clearLog,
      clearScopeAttempt,
      savedStatusActive: savedStatus.isActive,
    }

    const handleRuntimeMessage = makeOverlayRuntimeMessageHandler(handlerDeps, {
      extensionId: browser.runtime.id,
      popupUrl: browser.runtime.getURL('/popup.html'),
    })
    const overlayLifecycle = startOverlayLifecycle({
      bridge: installEarlyMediaResponseBridge(document),
      consumeMediaResponse,
      runtimeMessages: browser.runtime.onMessage,
      handleRuntimeMessage,
      settings: settingsSession,
    })

    ctx.onInvalidated(() => {
      // The overlay is about to be torn down (WXT removes the shadow host on
      // invalidation). Say why, once, so a stale tab isn't a silent dead end.
      notifyContextLost()
      clearDwell()
      setCursorActive(false)
      grab = idleQuickGrab
      grabUi = null
      affordances.stop()
      clearRescanSpin()
      savedStatus.stop()
      if (clearVisibilityPulseTimer !== null) clearTimeout(clearVisibilityPulseTimer)
      clearVisibilityPulseTimer = null
      clearVisibilityObserver?.disconnect()
      clearVisibilityObserver = null
      captureEpochRefresh.stop()
      captureBuffer?.stop()
      renderedMedia.stop()
      scrollHitTestQueued = false
      revealObserver?.disconnect()
      revealObserver = null
      stubObserver?.disconnect()
      stubObserver = null
      stubStyle?.remove()
      stubStyle = null
      overlayLifecycle.stop()
      // `browser.runtime` is already undefined once the context is invalidated.
      browser.runtime?.onMessage?.removeListener(handleCaptureEpochChanged)
    })
  },
})
