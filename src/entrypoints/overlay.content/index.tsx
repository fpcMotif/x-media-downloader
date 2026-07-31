import './style.css'
import { render } from 'preact'
import { adapterForHostname, ALL_ADAPTERS } from '../../core/adapters/registry'
import { makeDetectionStore, postGrabItems } from '../../core/adapters/detection-store'
import { harvestTweets } from '../../core/capture/harvest'
import type { Source, TweetRecord } from '../../core/capture/record'
import { parseSyndicationTweet } from '../../core/adapters/x/syndication'
import { VIDEO_PREVIEW_SECTIONS } from '../../core/adapters/x/dom'
import {
  mediaStillUnderPointer,
  previewKeyFromMedia,
  resolveHoverMedia,
  type HoverMediaElement,
} from '../../core/adapters/hover-resolve'
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
  type ModifierFlags,
  type QuickGrabState,
  type QuickGrabUiPhase,
} from '../../core/quickgrab'
import { makeLatestFrameTask } from '../../core/latest-frame'
import {
  badgeNudgeDelayMs,
  badgeSavedRevertMs,
  badgeAriaLabel,
  badgeStatusMessage,
  beginSave,
  enterMedia,
  hiddenBadge,
  leaveMedia,
  nudgeBadge,
  resolveSave,
  type BadgeState,
} from '../../core/badge'
import {
  beginSendAll,
  launcherAriaLabel,
  launcherStatusMessage,
  launcherFailedRevertMs,
  launcherSavedRevertMs,
  resolveSendAll,
  settleLauncher,
  type LauncherPhase,
} from '../../core/launcher'
import { getSettings, watchSettings } from '../../core/settings'
import { safeSend } from '../../core/messaging'
import { clickSensitiveReveals } from '../../core/adapters/x/reveal'
import {
  CLEARED_STUB_ATTR,
  CLEARED_STUB_CSS,
  collapseClearedStubs,
  isForYouHome,
  tweetIdOfArticle,
  TWEET_ARTICLE_SEL,
} from '../../core/clear/clearer'
import { Option } from 'effect'
import {
  clearMountedTweet,
  dispatchOverlayMessage,
  sweepSavedStatus,
  savedStatusVisible,
  type HandlerDeps,
} from './handlers'
import { makeScrollDrain } from '../../core/clear/scroll-drain'
import { makeSavedStatusLifecycle } from './saved-status-lifecycle'
import { partitionAllowedMediaItems } from '../../core/sync/url-guard'
import { makeTweetClearer } from '../../core/clear/tweet-clear'
import { inlineDataPayloads } from '../../core/adapters/meta-shared/inline-data'
import type {
  CaptureTweets,
  MediaItem,
  QueueUpdate,
  RecoverTweetMediaResponse,
  Settings,
  SavedStatusResponse,
} from '../../core/schema'

interface Rect {
  readonly top: number
  readonly left: number
  readonly width: number
  readonly height: number
}

/** Verbose clear-on-save tracing → the X PAGE console (content-script world).
 *  Open DevTools on the X tab to watch the un-bookmark/un-like decision live.
 *  DEV-only: every call site is guarded by `import.meta.env.DEV`, so neither the
 *  log strings nor `actionTestids(...)` are computed in the shipped build. */
const clearLog = (...args: unknown[]): void => console.info('[XMD clear]', ...args)

// The click → poll → confirm machinery for the irreversible un-bookmark/un-like/
// "Not interested" lives in `core/clear/tweet-clear`; here we inject the live
// document + timer port and (DEV-only) the page-console trace sink.
const { clearScope } = makeTweetClearer({
  document,
  clock: { sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
  ...(import.meta.env.DEV ? { log: clearLog } : {}),
})

// ── Auto-scroll drain for not-mounted clears ──
// The bounded scroll-pass loop lives in `core/clear/scroll-drain`; this entrypoint
// wires the live window/document/timer ports + the real clear and trace sinks into it
// (see `scrollDrain` below).
// Debounce for the cross-device "Saved" status sweep: a burst of scroll/render
// mutations collapses into one overlay→background round-trip + chip pass.
const SAVED_SWEEP_DEBOUNCE_MS = 500

/** Trailing debounce for the X video-recovery scan after scrolling idles —
 *  keeps the full player scan off every scroll frame. */
const VIDEO_RECOVERY_SCROLL_IDLE_MS = 250

/** Type-only narrowing (no runtime decode) — pins an `unknown` reply to the
 *  schema type that already describes it, in place of an `as` assertion. */
const isSavedStatusResponse = (reply: unknown): reply is SavedStatusResponse =>
  reply !== null && typeof reply === 'object' && 'saved' in reply

/** Ask the background which of these tweetIds are already downloaded (cross-device).
 *  Fail-safe: a context-invalidated / errored / malformed reply yields no marks. */
const requestSavedStatus = async (tweetIds: string[]): Promise<string[]> => {
  const out = await safeSend(() =>
    browser.runtime.sendMessage({ _tag: 'SavedStatusRequest', tweetIds }),
  )
  if (out.status !== 'ok') return []
  return isSavedStatusResponse(out.reply) ? [...out.reply.saved] : []
}
/** Numeric tweetIds of every tweet article mounted right now. */
const mountedTweetIds = (): string[] => {
  const out: string[] = []
  for (const a of document.querySelectorAll(TWEET_ARTICLE_SEL)) {
    const id = tweetIdOfArticle(a)
    if (Option.isSome(id)) out.push(id.value)
  }
  return out
}

const drainDeps = (): Pick<HandlerDeps, 'document' | 'location' | 'clearScope' | 'clearLog'> => ({
  document,
  location,
  clearScope,
  clearLog,
})

/** One-line drain trace to the BACKGROUND console (production-visible — `clearLog` is
 *  DEV-only and goes to the X PAGE console). Renders as `[XMD] clear <stage> …`. */
const reportClear = (stage: string, detail: string, tweetId?: string): void => {
  void safeSend(() =>
    browser.runtime.sendMessage({
      _tag: 'DownloadTraceEvent',
      source: 'clear',
      stage,
      t: Date.now(),
      ...(tweetId !== undefined ? { itemId: tweetId } : {}),
      detail,
    }),
  )
}

// The bounded scroll-pass loop is `core/clear/scroll-drain`; here we inject the live
// window/document/timer ports + the real clear and trace sinks.
const scrollDrain = makeScrollDrain({
  scroll: {
    position: () => window.scrollY,
    to: (y) => window.scrollTo(0, y),
    by: (dy) => window.scrollBy(0, dy),
    viewport: () => window.innerHeight,
  },
  clock: {
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    after: (ms, fn) => {
      const h = setTimeout(fn, ms)
      return () => clearTimeout(h)
    },
  },
  path: () => location.pathname,
  liveMountedIds: mountedTweetIds,
  clearMounted: (id, scopes, allLists) => clearMountedTweet(drainDeps(), id, scopes, allLists),
  report: reportClear,
})
const runDrain = scrollDrain.run

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

const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect()
  return { top: r.top, left: r.left, width: r.width, height: r.height }
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

/** The full media set per tweet, threaded to the For You clear gate so a partial
 *  grab never hides the whole post (1 of 4 photos must not "Not interested" it). */
type ClearExpect = ReadonlyArray<{ readonly tweetId: string; readonly ids: ReadonlyArray<string> }>

type SkipSummary = ReadonlyArray<{ readonly reason: string; readonly count: number }>

// Friendly labels for admission-gate skip reasons (mirrors SkipReason).
const SKIP_LABELS: Record<string, string> = {
  duplicate: 'already saved',
  'filtered-type': 'filtered',
  'too-small': 'too small',
  'too-big': 'too big',
  'daily-budget': 'daily limit',
}

/** Surface why media was dropped by the gate. The overlay has no toast surface,
 *  so — like notifyContextLost — this goes to the console. */
const reportSkipped = (skipped?: SkipSummary): void => {
  if (!skipped || skipped.length === 0) return
  const total = skipped.reduce((n, s) => n + s.count, 0)
  const parts = skipped.map((s) => `${s.count} ${SKIP_LABELS[s.reason] ?? s.reason}`)
  console.info(`[XMD] ${total} skipped — ${parts.join(', ')}`)
}

/** Surface why a request reached the download strategy but failed to START —
 *  the strategy's own `DownloadError.reason` (a 403/network/CDN failure), NOT
 *  an admission-gate skip (that's `reportSkipped`). Previously this reason only
 *  ever reached the background service worker's own (separately-inspected)
 *  console; this is the same information, in the tab's own console. */
const reportFailures = (failures?: ReadonlyArray<{ itemId: string; reason: string }>): void => {
  if (!failures || failures.length === 0) return
  console.warn(
    `[XMD] ${failures.length} download(s) FAILED to start —`,
    failures.map((f) => `${f.itemId}: ${f.reason}`).join('; '),
  )
}

/** Send one tracked request; false on a background start failure OR a dead
 *  channel (a stale tab — the user is told to reload rather than failing mutely).
 *  `clearExpect` (For You only) widens the clear gate to the whole post. */
const sendTracked = (
  items: ReadonlyArray<MediaItem>,
  clearExpect?: ClearExpect,
): Promise<boolean> =>
  safeSend(() =>
    browser.runtime.sendMessage({
      _tag: 'DownloadRequest',
      items,
      ...(clearExpect ? { clearExpect } : {}),
    }),
  ).then((out) => {
    if (out.status === 'context-invalidated') {
      notifyContextLost()
      return false
    }
    if (out.status === 'error') {
      // The send itself rejected (an async failure `safeSend` didn't classify as
      // context-invalidation — most likely an uncaught exception inside
      // background.ts's DownloadRequest handler, before it could even build a
      // reply). Previously silently discarded; log it so "why did this fail?"
      // doesn't require opening the SW's own separate devtools context.
      console.warn('[XMD] DownloadRequest send FAILED —', out.error)
      return false
    }
    const r = out.reply as QueueUpdate | undefined
    reportSkipped(r?.skipped)
    reportFailures(r?.failures)
    return r?.completed !== undefined && r.completed === r.total
  })

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
        ? { itemId: opts.item.id, tweetId: opts.item.postId, type: opts.item.type }
        : {}),
      ...(opts.elapsedMs !== undefined ? { elapsedMs: opts.elapsedMs } : {}),
      ...((opts.detail ?? opts.key) ? { detail: opts.detail ?? `key ${opts.key}` } : {}),
    })
  }

const traceQuickGrab = traceDownloadUi('quickgrab')
const traceBadge = traceDownloadUi('badge')

/** A source-bound `(stage, opts) => void` trace emitter (grab or badge). */
type TraceFn = ReturnType<typeof traceDownloadUi>

/** Pill copy per launcher phase; the idle copy doubles as the hover-revealed action label. */
const LAUNCHER_LABEL: Record<LauncherPhase, string> = {
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
  matches: [...new Set(ALL_ADAPTERS.flatMap((a) => a.hostMatch))],
  cssInjectionMode: 'ui',
  async main(ctx) {
    // Boot-time adapter selection: resolved ONCE, closed over for the rest of
    // main() — no per-call registry dispatch on the hover/mousemove hot path.
    // Fail closed: an unrecognized host (shouldn't happen given `matches`
    // scoping, but defensive for dev/test contexts) mounts nothing at all —
    // none of the X-only clear/capture/reveal machinery below ever runs.
    const adapter = adapterForHostname(location.hostname)
    if (!adapter) return
    // Whole-post grab (Cmd augment): only platforms that can resolve a whole post from a
    // DOM element (IG/Threads via postCodeFromElement; X deliberately omits it — product
    // decision, not an accident of capability).
    const postGrabEligible = adapter.postCodeFromElement !== undefined
    // Boot marker: if you don't see this in the X page console, the content
    // script isn't live on this tab (old build loaded, or the tab predates the
    // extension reload) — reload the extension AND refresh the tab.
    console.info('[XMD] overlay content script loaded @', location.href, adapter.platform)

    const store = makeDetectionStore({
      mediaKeyFromUrl: adapter.mediaKeyFromUrl,
      ...(adapter.findMediaNeedingRecovery
        ? { findMediaNeedingRecovery: adapter.findMediaNeedingRecovery }
        : {}),
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
    let renderedScanQueued = false
    let renderedScanNeedsRecovery = false
    // Trailing scroll-idle video recovery timer (X only) — see
    // scheduleScrollVideoRecovery.
    let scrollRecoveryTimer: ReturnType<typeof setTimeout> | null = null
    let scrollHitTestQueued = false

    // Download badge (per-media fast path). `badgeEnabled` fails closed like
    // `qgEnabled`: nothing renders until stored settings arrive.
    let badgeEnabled = false
    let badge: BadgeState = hiddenBadge
    let badgeMedia: HoverMediaElement | null = null
    let badgeNudge: ReturnType<typeof setTimeout> | null = null
    let badgeRevert: ReturnType<typeof setTimeout> | null = null
    // The request the current badge entrance fired, so a LATE `TransferOutcome`
    // (bytes landed / 403, seconds after the optimistic save) maps back to it.
    let badgeRequestId: string | null = null
    let badgeRequestKey: string | null = null
    // Dedup key for `focusBadge`'s 'media-no-key' trace: `enterMedia`/`leaveMedia`
    // already no-op (return the same `badge` reference) across repeat frames over
    // an unchanged hover, but a "media resolved, no key" element always maps to
    // the SAME `hiddenBadge` singleton as "nothing hovered" — that no-op alone
    // can't tell "still the same broken element" from "a different one, still
    // broken". Tracked independently so the trace only fires once per distinct
    // element, not once per mousemove frame while it's under the cursor.
    let badgeNoKeyMedia: HoverMediaElement | null = null

    // Download-all launcher hand-off feedback; one batch in flight at a time.
    // `dockEnabled` fails closed (like the badge): the dock stays hidden until
    // stored settings arrive, so a user who turned it off never sees a flash.
    // `dockGlass` is cosmetic only (glass lens vs. solid pill), so it defaults on.
    let dockEnabled = false
    let dockGlass = true
    let launcher: LauncherPhase = 'idle'
    let launcherRevert: ReturnType<typeof setTimeout> | null = null
    // Request ids in the batch currently in flight, so a late per-item failure can
    // downgrade the pill even after the optimistic save (any item that never lands).
    let launcherBatchIds = new Set<string>()
    let rescanning = false
    let rescanSpin: ReturnType<typeof setTimeout> | null = null
    // The two deferred re-scans settleRenderedScan schedules, tracked so they can
    // be cleared on teardown (like every other timer here) and never outlive the
    // context or stack across repeated settles.
    let settleTimers: ReturnType<typeof setTimeout>[] = []

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

    // For every rendered video player whose MP4 the passive tee never captured,
    // fetch the tweet's media from X's syndication endpoint (via the background,
    // which holds the host permission) and fold the recovered video into the
    // detected set. One attempt per tweet id; a transient send error re-arms it.
    // Capability-driven: an adapter without a public recovery pass
    // (`findMediaNeedingRecovery` — only X supplies one, its syndication endpoint;
    // IG/Threads have no no-auth equivalent, design spec Non-goals) makes
    // `store.needsRecovery` a constant `[]` and never walks the DOM, so skip the
    // whole scan on those platforms.
    const recoverMissingVideos = (): void => {
      if (!adapter.findMediaNeedingRecovery) return
      for (const tweetId of store.needsRecovery(document)) {
        if (!store.markAttempted(tweetId)) continue
        void (async () => {
          const out = await safeSend(() =>
            browser.runtime.sendMessage({ _tag: 'RecoverTweetMediaRequest', tweetId }),
          )
          if (out.status === 'context-invalidated') {
            notifyContextLost()
            return
          }
          if (out.status !== 'ok') {
            store.unmarkAttempted(tweetId)
            return
          }
          const body = (out.reply as RecoverTweetMediaResponse | undefined)?.body
          if (body === undefined) return
          try {
            if (store.addRecovered(parseSyndicationTweet(JSON.parse(body))).length > 0) rerender()
          } catch {
            /* ignore non-JSON / unexpected shapes */
          }
        })()
      }
    }

    const scanRenderedMedia = (): void => {
      if (store.addDetected(adapter.detectRenderedMedia(document, location.pathname)).length > 0) {
        rerender()
      }
    }

    // Recovery (the X-specific full player scan + syndication fetch) is requested
    // EXPLICITLY: startup/settle/manual paths pass `true`; per-frame scroll scans
    // stay detection-only and let scheduleScrollVideoRecovery fire one trailing
    // full scan after the scroll idles.
    const queueRenderedMediaScan = (recoverVideos = false): void => {
      renderedScanNeedsRecovery ||= recoverVideos
      if (renderedScanQueued) return
      renderedScanQueued = true
      ctx.requestAnimationFrame(() => {
        renderedScanQueued = false
        const recover = renderedScanNeedsRecovery
        renderedScanNeedsRecovery = false
        scanRenderedMedia()
        if (recover) recoverMissingVideos()
      })
    }

    // One trailing recovery after scrolling stops: each scroll frame re-arms the
    // debounce, so the costly player scan runs once per burst, not per frame.
    // Capability-gated like recoverMissingVideos: no recovery pass, no timer.
    const scheduleScrollVideoRecovery = (): void => {
      if (!adapter.findMediaNeedingRecovery) return
      if (scrollRecoveryTimer !== null) {
        clearTimeout(scrollRecoveryTimer)
        scrollRecoveryTimer = null
      }
      scrollRecoveryTimer = setTimeout(() => {
        scrollRecoveryTimer = null
        queueRenderedMediaScan(true)
      }, VIDEO_RECOVERY_SCROLL_IDLE_MS)
    }

    // X mounts a video player asynchronously after a navigation / cache render, so
    // a single scan right after mount or locationchange can miss it. Re-scan at a
    // couple of short delays so a tee-missed video is recovered without the user
    // having to scroll. Bounded (two timers), no persistent observer; a late timer
    // after invalidation is a safe no-op (`recoverMissingVideos` rides `safeSend`,
    // `rerender` no-ops once the host is gone).
    const clearSettleTimers = (): void => {
      for (const t of settleTimers) clearTimeout(t)
      settleTimers = []
    }
    const settleRenderedScan = (): void => {
      clearSettleTimers()
      // A settle (startup / SPA navigation) supersedes any pending trailing
      // scroll recovery — the full scans below cover it.
      if (scrollRecoveryTimer !== null) {
        clearTimeout(scrollRecoveryTimer)
        scrollRecoveryTimer = null
      }
      queueRenderedMediaScan(true)
      settleTimers = [
        setTimeout(() => queueRenderedMediaScan(true), 700),
        setTimeout(() => queueRenderedMediaScan(true), 2000),
      ]
    }

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
        revealObserver.observe(document.body, { childList: true, subtree: true })
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

    // Cross-device "Saved ✓" status: a debounced observer paints a chip on
    // already-downloaded posts as the timeline churns / on SPA navigation. The
    // request is network-bounded (overlay → background → maybe Convex), so it is
    // debounced; the chip is injected idempotently and only on a positive reply.
    // Scope-gated to the home + List timelines, and gated on the `showSavedStatus`
    // setting (applySettings keeps `savedStatusOn` live). The lifecycle controller
    // owns the observer/timer/sweep — X-only (SavedIndex/Convex queries +
    // TWEET_ARTICLE_SEL/tweetIdOfArticle are X-DOM-specific), so `isActive`
    // includes the platform gate and the observer is never constructed off-X.
    let savedStatusOn = false
    // Tweet-text harvest gate + breadth flag (§7); applySettings keeps them live.
    let captureEnabled = false
    let captureAllScrolled = false
    let savedStatusAlive = true
    const savedStatusIsActive = (): boolean =>
      savedStatusAlive &&
      adapter.platform === 'x' &&
      savedStatusVisible(location.pathname, savedStatusOn)
    const savedStatusLifecycle = makeSavedStatusLifecycle({
      isActive: savedStatusIsActive,
      root: document.body,
      delayMs: SAVED_SWEEP_DEBOUNCE_MS,
      makeObserver: (notify) => new MutationObserver(notify),
      clock: {
        after: (ms, run) => {
          const t = setTimeout(run, ms)
          return () => clearTimeout(t)
        },
      },
      sweep: () =>
        sweepSavedStatus({
          document,
          inScope: savedStatusIsActive,
          requestSavedStatus,
        }),
    })

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
      previewKeyFromMedia(adapter, m, location.pathname) === key &&
      mediaStillUnderPointer(m, document.elementsFromPoint(lastX, lastY))

    // The media to grab once the dwell elapses. Prefer the armed node, but X's
    // timeline is virtualized: it can recycle that exact node out from under the
    // pointer mid-dwell. So if the armed node went stale, re-resolve the LIVE media
    // at the pointer once — a fresh node showing the same image at the same spot is
    // still the grab the user asked for — and accept it only if its key still
    // matches. Null ⇒ the media truly moved on; drop the grab.
    const liveGrabTarget = (armed: HoverMediaElement, key: string): HoverMediaElement | null => {
      if (holdsKey(armed, key)) return armed
      const stack = document.elementsFromPoint(lastX, lastY)
      const live = resolveHoverMedia(stack[0] ?? null, stack, lastX, lastY)
      return live && holdsKey(live, key) ? live : null
    }

    // For You: tag a download with the post's FULL detected media set, so the
    // "Not interested" clear waits for the WHOLE post — a single grabbed photo must
    // never hide a 4-photo post and lose the other three (the clear fires only once
    // every photo is grabbed, or Download-all'd). Null off the feed: there the
    // grabbed subset gates the page's un-bookmark/un-like, unchanged.
    const forYouClearExpect = (items: ReadonlyArray<MediaItem>): ClearExpect | undefined => {
      if (!isForYouHome(location.pathname, document)) return undefined
      const tweetIds = [...new Set(items.map((i) => i.postId))]
      return tweetIds.map((tweetId) => ({
        tweetId,
        ids: store.valuesForTweet(tweetId).map((m) => m.id),
      }))
    }

    // The shared "queued → send → resolve → rerender" skeleton behind grab/badge/
    // launcher hand-offs. It owns ONLY what is universal: capture the send start,
    // optionally trace queued/ack/failed (launcher passes no trace), await the
    // tracked send, bail if the affordance moved on (`isStale`), apply the caller's
    // pure resolver, then re-render. The DIVERGENT revert behavior stays at the
    // call sites via `onSettled(ok)` — badge arms a fixed delay only on 'saved',
    // launcher a ternary delay always, grab none — and grab's `hoverArmedAt` queued
    // baseline is threaded in as `trace.armedAt` rather than hard-wired here.
    const runHandoff = (opts: {
      readonly items: ReadonlyArray<MediaItem>
      readonly trace?: { readonly fn: TraceFn; readonly item: MediaItem; readonly armedAt?: number }
      readonly isStale: () => boolean
      readonly resolve: (ok: boolean) => void
      readonly onSettled?: (ok: boolean) => void
    }): void => {
      const { items, trace, isStale, resolve, onSettled } = opts
      void (async () => {
        const sendStartedAt = Date.now()
        if (trace)
          trace.fn('queued', {
            item: trace.item,
            ...(trace.armedAt !== undefined ? { elapsedMs: sendStartedAt - trace.armedAt } : {}),
          })
        const ok = await sendTracked(items, forYouClearExpect(items))
        if (trace)
          trace.fn(ok ? 'start-ack' : 'start-failed', {
            item: trace.item,
            elapsedMs: Date.now() - sendStartedAt,
          })
        if (isStale()) return
        resolve(ok)
        rerender()
        onSettled?.(ok)
      })()
    }

    const fireGrab = (armed: HoverMediaElement, key: string): void => {
      dwell = null
      const media = liveGrabTarget(armed, key)
      if (media === null) {
        // The dwell completed but the armed node went stale AND the re-resolved
        // live media at the pointer either doesn't exist or no longer carries the
        // same key — the single "hold, wait, nothing happens" shape this dwell
        // window exists to protect against. `liveGrabTarget`'s own doc names
        // Threads' virtualized timeline as the confirmed cause (a mounted node
        // recycled to different content mid-dwell); previously silent.
        traceQuickGrab('grab-target-stale', { key })
        grabUi = null
        rerender()
        return
      }
      const item = adapter.resolveHoverItem(media, key, store.keyIndex(), location.pathname)
      if (!item) {
        // detail distinguishes the two ways this can happen: the tee HAS this key
        // (resolveHoverItem's own detected.get(key) branch) yet still returned
        // null — shouldn't happen, worth knowing if it ever does — vs. the tee
        // never saw this key at all, so it fell to the adapter's DOM-only
        // fallback (photo-only; a hovered video with no teed key can never
        // resolve). The single highest-value signal for "why did Quick Grab do
        // nothing" on Threads/Instagram, where DOM↔tee key matching is the
        // documented weak point (see meta-shared/dom.ts's own caveats).
        traceQuickGrab('no-item-for-hover', {
          key,
          detail: `${store.keyIndex().has(key) ? 'teed' : 'not-teed'} ${media.tagName.toLowerCase()}`,
        })
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
        if (teePost.length === 0) {
          // Whole-post grab (Cmd augment) is Threads/Instagram-only — silently
          // falling back to just the hovered item (instead of the whole
          // carousel) is exactly the "grabbed 1 of 4 photos" bug shape. detail
          // says which link in the chain came up empty: no DOM shortcode at
          // all (post-anchor selector miss), or a shortcode the tee hasn't
          // registered yet (postCodeFromElement raced ahead of the network tee).
          traceQuickGrab('whole-post-fallback', {
            item,
            detail: code ? `code ${code} not yet registered` : 'no post code from DOM',
          })
        }
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
        ? { key, rect: rectOf(media), phase: 'queued', all: true, allCount: items.length }
        : { key, rect: rectOf(media), phase: 'queued' }
      rerender()
      runHandoff({
        items,
        trace: { fn: traceQuickGrab, item, armedAt: hoverArmedAt },
        isStale: () => grabUi === null || grabUi.key !== key,
        resolve: (ok) => {
          if (grabUi) grabUi = { ...grabUi, phase: ok ? 'saved' : 'failed' }
        },
      })
    }

    /** Begin (or, if already grabbed this press, just acknowledge) a hovered media item. */
    const armHover = (media: HoverMediaElement, key: string): void => {
      if (canGrab(grab, key)) {
        grabUi = { key, rect: rectOf(media), phase: 'charging', all: postGrabArmed }
        rerender()
        hoverArmedAt = Date.now()
        traceQuickGrab('armed', { key })
        dwell = setTimeout(() => fireGrab(media, key), quickGrabDwellMs)
      } else {
        grabUi = { key, rect: rectOf(media), phase: 'noted', all: postGrabArmed }
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
        // A real media element resolved under the cursor (`resolveHoverMedia`
        // found an img/video) but `previewKeyFromMedia` couldn't derive a key
        // for it at all — no ring ever arms, with nothing else downstream to
        // report it (fireGrab never runs). On Threads/Instagram this means
        // `mediaKeyFromMetaCombinedUrl` rejected the element's own
        // src/currentSrc (e.g. an avatar path family, or a CDN host outside
        // cdninstagram.com) AND, for a hovered video, `postKeyFromVideoElement`'s
        // DOM post-anchor also came up empty.
        if (grab.active && media)
          traceQuickGrab('media-no-key', { detail: media.tagName.toLowerCase() })
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

    const syncGrabFromPointer = (flags: ModifierFlags): boolean => {
      const next = syncModifierFromFlags(grab, flags, qgModifier)
      if (next === grab) return grab.active
      if (!next.active) {
        releaseAll()
        return false
      }
      grab = next
      setCursorActive(true)
      return true
    }

    const clearBadgeTimers = (): void => {
      if (badgeNudge !== null) {
        clearTimeout(badgeNudge)
        badgeNudge = null
      }
      if (badgeRevert !== null) {
        clearTimeout(badgeRevert)
        badgeRevert = null
      }
    }

    const resetBadge = (): void => {
      clearBadgeTimers()
      badge = hiddenBadge
      badgeMedia = null
    }

    const badgeInput = (media: HoverMediaElement | null, key: string | null) => ({
      enabled: badgeEnabled,
      resolvable:
        media !== null && key !== null && adapter.canResolveHoverItem(media, key, store.keyIndex()),
      modifierHeld: grab.active,
    })

    /** Move the badge entrance to the hovered media (either may be null). */
    const focusBadge = (media: HoverMediaElement | null, key: string | null): void => {
      // Unlike Quick Grab's 'media-no-key' (focusHover, grab.active-gated only),
      // the badge is the DEFAULT no-modifier affordance — this is the more
      // commonly hit "hover real media, nothing appears at all" report on
      // Threads/Instagram. See badgeNoKeyMedia's own doc for the dedup rationale.
      if (media && !key) {
        if (media !== badgeNoKeyMedia) {
          badgeNoKeyMedia = media
          traceBadge('media-no-key', { detail: media.tagName.toLowerCase() })
        }
      } else {
        badgeNoKeyMedia = null
      }
      const next = media && key ? enterMedia(badge, key, badgeInput(media, key)) : leaveMedia(badge)
      if (next === badge) return
      clearBadgeTimers()
      badge = next
      badgeMedia = next.phase === 'hidden' ? null : media
      if (next.phase === 'shown') {
        traceBadge('shown', next.key ? { key: next.key } : {})
        badgeNudge = setTimeout(() => {
          badgeNudge = null
          const nudged = nudgeBadge(badge)
          if (nudged === badge) return
          badge = nudged
          traceBadge('nudged', badge.key ? { key: badge.key } : {})
          rerender()
        }, badgeNudgeDelayMs)
      }
      rerender()
    }

    /** Hand the badge's one Media Item to the queue; failed retries, in-flight doesn't re-fire. */
    const onBadgeClick = (e: MouseEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      const media = badgeMedia
      const key = badge.key
      const next = beginSave(badge)
      if (!media || !key || next === badge) return
      // The node may have been recycled or detached during the entrance (X's
      // timeline is virtualized, and Threads' pressable-container carousels are
      // independently documented doing the same — see threads/adapter.ts's
      // postIdFromDom doc) — bail unless it is still the same media.
      if (!media.isConnected || previewKeyFromMedia(adapter, media, location.pathname) !== key) {
        traceBadge('badge-target-stale', {
          key,
          detail: media.isConnected ? 'key-changed' : 'detached',
        })
        resetBadge()
        rerender()
        return
      }
      const item = adapter.resolveHoverItem(media, key, store.keyIndex(), location.pathname)
      if (!item) {
        // Same detail shape as fireGrab's own 'no-item-for-hover' — see that
        // call site's comment. The badge showed at all (so `canResolveHoverItem`
        // said yes at entrance-time) yet the click-time `resolveHoverItem`
        // still failed — this can only happen if the tee's detected set changed
        // between the badge's entrance and the click (e.g. a virtualized
        // Threads container recycled this node to different content mid-hover).
        traceBadge('no-item-for-hover', {
          key,
          detail: `${store.keyIndex().has(key) ? 'teed' : 'not-teed'} ${media.tagName.toLowerCase()}`,
        })
        resetBadge()
        rerender()
        return
      }
      clearBadgeTimers()
      badge = next
      badgeRequestId = item.id
      badgeRequestKey = key
      rerender()
      runHandoff({
        items: [item],
        trace: { fn: traceBadge, item },
        isStale: () => badge.key !== key || badge.phase !== 'queued',
        resolve: (ok) => {
          badge = resolveSave(badge, ok)
        },
        // Revert timer is badge-specific: linger only after a confirmed 'saved'.
        onSettled: () => {
          if (badge.phase !== 'saved') return
          badgeRevert = setTimeout(() => {
            badgeRevert = null
            if (badge.phase !== 'saved' || badge.key !== key) return
            // Linger, then revert to the idle arrow without a second nudge.
            badge = { phase: 'shown', key }
            rerender()
          }, badgeSavedRevertMs)
        },
      })
    }

    const clearLauncherRevert = (): void => {
      if (launcherRevert !== null) {
        clearTimeout(launcherRevert)
        launcherRevert = null
      }
    }

    /** Hand the whole detected set to the queue; the pill reports the hand-off result. */
    const onLauncherClick = (): void => {
      const next = beginSendAll(launcher)
      if (next === launcher) return
      clearLauncherRevert()
      launcher = next
      const batch = store.values()
      launcherBatchIds = new Set(batch.map((i) => i.id))
      rerender()
      runHandoff({
        items: batch,
        // Launcher passes no trace (no per-item download-UI telemetry on the bulk pill).
        isStale: () => launcher !== 'queued',
        resolve: (ok) => {
          launcher = resolveSendAll(launcher, ok)
        },
        // Revert timer is launcher-specific: always armed, delay depends on outcome.
        onSettled: (ok) => {
          launcherRevert = setTimeout(
            () => {
              launcherRevert = null
              const settled = settleLauncher(launcher)
              if (settled === launcher) return
              launcher = settled
              rerender()
            },
            ok ? launcherSavedRevertMs : launcherFailedRevertMs,
          )
        },
      })
    }

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
      resetBadge()
      clearLauncherRevert()
      launcher = 'idle'
      store.clear()
      store.addDetected(adapter.detectRenderedMedia(document, location.pathname))
      recoverMissingVideos()
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
    const applySettings = (s: Settings): void => {
      qgEnabled = s.quickGrabEnabled
      qgModifier = s.quickGrabModifier
      badgeEnabled = s.downloadBadgeEnabled
      dockEnabled = s.downloadDockEnabled
      dockGlass = s.dockGlassEnabled
      // Sensitive-content auto-reveal + the "Not interested" stub-collapse are both
      // X-only (X-specific data-testid selectors, no Instagram/Threads equivalent):
      // gate their observer setup so no MutationObserver is even constructed there.
      if (adapter.platform === 'x') setAutoReveal(s.autoRevealSensitiveEnabled)
      // Hide the cleared-post feedback stub only when the For-You "Not interested"
      // clear is actually active (master + the per-scope toggle on).
      if (adapter.platform === 'x') setStubCollapse(s.clearOnSave && s.autoNotInterestedOnSave)
      // Cross-device "Saved" status: gate the sweep on the toggle; a flip re-paints.
      // X-only (SavedIndex/Convex queries + TWEET_ARTICLE_SEL are X-DOM-specific):
      // don't even arm the debounce timer on Instagram/Threads.
      savedStatusOn = s.showSavedStatus
      savedStatusLifecycle.sync()
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
    void getSettings()
      .then(applySettings)
      .catch(() => {})
    // On invalidation `wxt/storage` is already torn down and its unwatch throws —
    // swallow it so the reload path stays quiet (the real hint is logged below).
    const unwatchSettings = watchSettings(applySettings)
    ctx.onInvalidated(() => {
      try {
        unwatchSettings()
      } catch {
        /* context already gone */
      }
    })

    /** The per-media download badge, anchored to the photo's bottom-right corner. */
    function BadgeButton({ media }: { readonly media: HoverMediaElement }) {
      const r = rectOf(media)
      const lightbox = media.closest('[aria-modal="true"], [role="dialog"]') !== null
      const inset = lightbox ? 12 : 10
      const type = badge.key ? store.resolve(badge.key)?.type : undefined
      const mediaType = type ?? 'photo'
      return (
        <>
          <button
            type="button"
            class={`xmd-badge xmd-badge--${badge.phase}${lightbox ? ' xmd-badge--lightbox' : ''}`}
            style={{
              top: `${r.top + inset}px`,
              left: `${r.left + inset}px`,
            }}
            aria-label={badgeAriaLabel(badge.phase, mediaType)}
            aria-busy={badge.phase === 'queued'}
            onClick={onBadgeClick}
          >
            <PhaseGlyphs block="xmd-badge" />
          </button>
          <output class="xmd-sr-only" aria-live="polite" aria-atomic="true">
            {badgeStatusMessage(badge.phase, mediaType)}
          </output>
        </>
      )
    }

    function Overlay() {
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
                aria-label={launcherAriaLabel(launcher, store.count)}
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
              <output class="xmd-sr-only" aria-live="polite" aria-atomic="true">
                {launcherStatusMessage(launcher, store.count)}
              </output>
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
        settleRenderedScan()
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
    const MAX_CAPTURE_BATCH = 64
    const CAPTURE_FLUSH_DEBOUNCE_MS = 750
    let captureBuffer: TweetRecord[] = []
    let captureFlushTimer: ReturnType<typeof setTimeout> | null = null
    let captureStateLogged = false

    // Ship the pending buffer in CaptureTweets messages capped at MAX_CAPTURE_BATCH
    // records each, draining fully so nothing is dropped. Fire-and-forget via
    // safeSend: a stale context is a refresh hint, not a harvest failure.
    const flushCaptures = (): void => {
      if (captureFlushTimer !== null) {
        clearTimeout(captureFlushTimer)
        captureFlushTimer = null
      }
      while (captureBuffer.length > 0) {
        const records = captureBuffer.slice(0, MAX_CAPTURE_BATCH)
        captureBuffer = captureBuffer.slice(MAX_CAPTURE_BATCH)
        console.info(`[XMD] capture flush → sending ${records.length} record(s)`)
        void safeSend(() =>
          browser.runtime.sendMessage({ _tag: 'CaptureTweets', records } satisfies CaptureTweets),
        )
      }
    }

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
        captureBuffer.push(...records)
        if (captureBuffer.length >= MAX_CAPTURE_BATCH) {
          flushCaptures()
          return
        }
        if (captureFlushTimer !== null) clearTimeout(captureFlushTimer)
        captureFlushTimer = setTimeout(flushCaptures, CAPTURE_FLUSH_DEBOUNCE_MS)
      } catch (err) {
        console.warn('[XMD] capture harvest THREW (not a media failure):', err)
      }
    }

    // Named so invalidation can remove it — a stale tab must not retain
    // duplicate response callbacks (body unchanged apart from 001's URL filter).
    const handleMediaResponse = (event: Event): void => {
      const detail = (event as CustomEvent<{ path: string; body: string }>).detail
      let json: unknown
      try {
        json = JSON.parse(detail.body)
      } catch {
        return /* non-JSON tee body */
      }
      try {
        // Fail-closed trust boundary: page scripts can forge 'xmd:media-response'
        // events, so only CDN-allow-listed items ever reach the store.
        const checked = partitionAllowedMediaItems(adapter.detectFromResponse(detail.path, json))
        if (checked.rejected.length > 0) {
          console.warn(`[XMD] dropped ${checked.rejected.length} media item(s) with unsafe URLs`)
        }
        const added = store.addDetected(checked.allowed)
        // Dev-only per-response detect trace: Instagram/Threads' walker is a
        // reverse-engineered, "not independently verified against a live
        // response" shape match (see meta-shared/detect.ts's module doc) — this
        // is the live evidence for "is the tee even firing/parsing on this
        // platform" without needing 12 rounds of adding console.logs by hand.
        if (import.meta.env.DEV && checked.allowed.length > 0) {
          console.debug(
            `[XMD] detect ${adapter.platform} path=${detail.path} → ${checked.allowed.length} item(s), ${added.length} new`,
          )
        }
        if (added.length > 0) rerender()
        // Instagram/Threads only (X omits extractPostCodes): links the DOM's
        // URL-shortcode to the tee's own postId (which may differ — e.g.
        // Instagram's numeric pk vs its /p/{code}/ shortcode), so a hovered
        // video's DOM-derived post:{code} key (see previewKeyFromMedia above)
        // resolves to the same MediaItem addDetected just indexed by postId.
        const codes = adapter.extractPostCodes?.(json)
        if (codes) for (const [postId, code] of codes) store.registerPostCode(postId, code)
      } catch (err) {
        // Previously fully silent ("media detection is best-effort"). A shape-drift
        // throw here — Meta's response schema shifting under the reverse-engineered
        // walker — meant zero items were EVER detected for that response with no
        // visible signal at all: the single hardest case to diagnose live, because
        // nothing downstream (hover, badge, grab) had anything to even report as
        // missing. Mirrors the capture-harvest catch immediately below, which
        // already logs its own throws.
        console.warn(
          `[XMD] media detection THREW on ${adapter.platform} path=${detail.path} —`,
          err,
        )
      }
      // Knowledge Capture is X-only-forever (design spec Non-goals): harvestTweets'
      // tree walker assumes X's tweet-node JSON shape, so never call it off-platform.
      if (adapter.platform === 'x') harvestFrom(json, detail.path) // own try/catch — never swallowed by media path
    }
    document.addEventListener('xmd:media-response', handleMediaResponse)

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
          new CustomEvent('xmd:media-response', { detail: { path: 'inline:document', body } }),
        )
      }
    }

    // Don't lose a sub-debounce batch when the tab is navigated away or unloaded.
    ctx.addEventListener(window, 'pagehide', flushCaptures)
    ctx.addEventListener(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushCaptures()
    })

    // Quick Grab hover tracking: hold the configured modifier and hover a real
    // X media image/poster for the dwell window. No competing per-hover buttons.
    // A mousemove sample carries ONLY value data — never the event object or a
    // resolved DOM node — so nothing stale survives across frames.
    interface MouseMoveSample extends ModifierFlags {
      readonly target: Element | null
      readonly clientX: number
      readonly clientY: number
    }
    // The costly part of mousemove (hit-test → state → maybe render), run at
    // most once per frame via the latest-sample scheduler below. Branch order
    // is exactly the old raw listener's.
    const runMouseHitTest = (sample: MouseMoveSample): void => {
      if (!qgEnabled && !badgeEnabled) return
      // Pointer events are the ground truth. They both self-heal a swallowed
      // keyup and cover the common "hold modifier, then hover media" path where
      // the page never saw the initial keydown.
      const grabbing = qgEnabled && syncGrabFromPointer(sample)
      refreshPostGrabArmed(postGrabActive(grab.active, sample, qgModifier, postGrabEligible))
      const target = sample.target
      // Hovering this extension's own UI (the badge) must not read as leaving
      // the media underneath it — the entrance would hide before the click.
      if (target?.tagName === 'XMD-OVERLAY') return
      const stack = document.elementsFromPoint(sample.clientX, sample.clientY)
      const media = resolveHoverMedia(target, stack, sample.clientX, sample.clientY)
      const key = previewKeyFromMedia(adapter, media, location.pathname)
      if (grabbing) focusHover(media, key)
      focusBadge(media, key)
    }
    // Coalesce a burst of mousemove events into ONE hit-test per frame, keeping
    // only the newest pointer sample (same cadence as queueScrollHitTest).
    const mouseHitTest = makeLatestFrameTask<MouseMoveSample>(
      (run) => ctx.requestAnimationFrame(run),
      runMouseHitTest,
    )
    ctx.addEventListener(
      document,
      'mousemove',
      (event) => {
        const e = event as MouseEvent
        lastX = e.clientX
        lastY = e.clientY
        pointerSeen = true
        if (!qgEnabled && !badgeEnabled) return
        mouseHitTest.push({
          target: e.target as Element | null,
          clientX: e.clientX,
          clientY: e.clientY,
          altKey: e.altKey,
          shiftKey: e.shiftKey,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
        })
      },
      { passive: true },
    )

    // The per-scroll hit-test: re-run resolution so the dwell and ring track what
    // is actually under the pointer, and refresh the rect when the same media
    // preview merely shifted. Runs inside a coalesced rAF (see queueScrollHitTest),
    // so it re-evaluates the same early-guard (pointerSeen / grab.active /
    // badge.phase) at fire time — the dwell refresh shifts by at most ~1 frame and
    // reads the freshest lastX/lastY.
    const runScrollHitTest = (): void => {
      if (!pointerSeen || (!grab.active && badge.phase === 'hidden')) return
      // Pointer parked on our own badge: the media underneath didn't change,
      // only its rect did — refresh in place rather than re-hit-testing.
      const stack = document.elementsFromPoint(lastX, lastY)
      const top = stack[0] as Element | undefined
      if (top?.tagName === 'XMD-OVERLAY') {
        if (badge.phase !== 'hidden') rerender()
        return
      }
      const media = resolveHoverMedia(top ?? null, stack, lastX, lastY)
      const key = previewKeyFromMedia(adapter, media, location.pathname)
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

    // Coalesce a burst of scroll events into a single hit-test per frame (same
    // renderedScanQueued/rAF pattern as queueRenderedMediaScan): a fast flick fires
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
        queueRenderedMediaScan()
        scheduleScrollVideoRecovery()
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
        let media: HoverMediaElement | null = null
        if (pointerSeen) {
          const stack = document.elementsFromPoint(lastX, lastY)
          media = resolveHoverMedia(stack[0] ?? null, stack, lastX, lastY)
        }
        const key = previewKeyFromMedia(adapter, media, location.pathname)
        hoverMedia = media
        hoverKey = key
        if (media && key) armHover(media, key)
        else rerender() // keep the page quiet when the press lands off media
      }
    })

    ctx.addEventListener(window, 'keyup', (event) => {
      // Drop any queued-but-unrun pointer sample alongside the grab: a stale
      // altKey sample must not re-arm (or fire) after the modifier is gone.
      if (isModifierKey((event as KeyboardEvent).key, qgModifier)) {
        mouseHitTest.clear()
        releaseAll()
      }
    })
    ctx.addEventListener(window, 'blur', () => {
      mouseHitTest.clear()
      releaseAll()
    })
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
      mouseHitTest.clear()
      focusHover(null, null)
      focusBadge(null, null)
    })

    ctx.addEventListener(window, 'wxt:locationchange', () => {
      // A pre-navigation sample must not re-arm UI against detached DOM.
      mouseHitTest.clear()
      releaseAll()
      resetBadge()
      focusHover(null, null)
      settleRenderedScan()
      savedStatusLifecycle.sync()
      rerender()
    })

    // LIVE handles on the closed-over state + helpers above. Scalars are threaded
    // as getter/setter pairs so each handler reads the current value and writes
    // back into THIS closure variable (never a copy) — the badge/launcher
    // correction in TransferOutcome and the store.clear()/grab reset in
    // ClearDetectedMediaRequest mutate the same live state they did when inlined.
    const handlerDeps: HandlerDeps = {
      adapter,
      store,
      document,
      location,
      rerender,
      getBadge: () => badge,
      setBadge: (b) => {
        badge = b
      },
      getBadgeMedia: () => badgeMedia,
      getBadgeRequestId: () => badgeRequestId,
      getBadgeRequestKey: () => badgeRequestKey,
      clearBadgeTimers,
      resetBadge,
      previewKeyFromMedia: (media) => previewKeyFromMedia(adapter, media, location.pathname),
      getLauncher: () => launcher,
      setLauncher: (p) => {
        launcher = p
      },
      getLauncherBatchIds: () => launcherBatchIds,
      clearLauncherRevert,
      clearDwell,
      setCursorActive,
      resetGrab: () => {
        grab = idleQuickGrab
        grabUi = null
      },
      clearRescanSpin,
      sendTracked,
      recoverMissingVideos,
      notifyContextLost,
      clearLog,
      clearScope,
      runDrain,
      savedStatusActive: () => savedStatusVisible(location.pathname, savedStatusOn),
    }

    const handleRuntimeMessage = (
      message: unknown,
      _sender: unknown,
      sendResponse: (r: unknown) => void,
    ): boolean | void => dispatchOverlayMessage(message, handlerDeps, sendResponse)
    browser.runtime.onMessage.addListener(handleRuntimeMessage)

    ctx.onInvalidated(() => {
      // The overlay is about to be torn down (WXT removes the shadow host on
      // invalidation). Say why, once, so a stale tab isn't a silent dead end.
      notifyContextLost()
      mouseHitTest.clear()
      clearDwell()
      setCursorActive(false)
      grab = idleQuickGrab
      grabUi = null
      resetBadge()
      clearLauncherRevert()
      clearRescanSpin()
      clearSettleTimers()
      if (scrollRecoveryTimer !== null) {
        clearTimeout(scrollRecoveryTimer)
        scrollRecoveryTimer = null
      }
      launcher = 'idle'
      renderedScanQueued = false
      renderedScanNeedsRecovery = false
      scrollHitTestQueued = false
      revealObserver?.disconnect()
      revealObserver = null
      stubObserver?.disconnect()
      stubObserver = null
      stubStyle?.remove()
      stubStyle = null
      // Saved-status lifecycle dies first: no sweep may paint or rearm after this.
      savedStatusAlive = false
      savedStatusLifecycle.dispose()
      // Don't flush — the runtime is already dead; just drop the pending batch.
      if (captureFlushTimer !== null) {
        clearTimeout(captureFlushTimer)
        captureFlushTimer = null
      }
      captureBuffer = []
      // `browser.runtime` is already undefined once the context is invalidated.
      browser.runtime?.onMessage?.removeListener(handleRuntimeMessage)
      document.removeEventListener('xmd:media-response', handleMediaResponse)
    })
  },
})
