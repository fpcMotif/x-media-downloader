import './style.css'
import { render } from 'preact'
import { adapterForHostname, ALL_ADAPTERS } from '../../core/adapters/registry'
import { makeDetectionStore } from '../../core/adapters/detection-store'
import { harvestTweets } from '@/packages/capture/harvest'
import type { Source, TweetRecord } from '@/packages/capture/record'
import { parseSyndicationTweet } from '../../core/adapters/x/syndication'
import { focusedTweetArticle, tweetIdFromArticle } from '../../core/adapters/x'
import {
  bodyHasErrorSignal,
  matchReleaseMutationOp,
  tweetIdFromMutationRequestBody,
} from '../../core/adapters/x/tracked-mutation'
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
} from '@/packages/overlay/quickgrab'
import { makeLatestFrameTask } from '@/packages/overlay/latest-frame'
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
} from '@/packages/overlay/badge'
import {
  beginSendAll,
  launcherAriaLabel,
  launcherStatusMessage,
  launcherFailedRevertMs,
  launcherSavedRevertMs,
  resolveSendAll,
  settleLauncher,
  type LauncherPhase,
} from '@/packages/overlay/launcher'
import { getSettings, watchSettings } from '@/packages/settings'
import { idlePostHotkey, postHotkeyKey } from '../../core/post-hotkey'
import { fireCurrentPost, wholePostItemsFor, type PostGrabDeps } from './post-grab'
import { safeSend } from '@/packages/kernel/messaging'
import { clickSensitiveReveals } from '../../core/adapters/x/reveal'
import {
  alreadyCleared,
  CLEARED_STUB_ATTR,
  CLEARED_STUB_CSS,
  collapseClearedStubs,
  findArticle,
  isForYouHome,
  isMember,
  tweetIdOfArticle,
  TWEET_ARTICLE_SEL,
  type MembershipScope,
} from '@/packages/clear/clearer'
import { Option } from 'effect'
import {
  clearMountedTweet,
  dispatchOverlayMessage,
  releaseRunDetail,
  releaseTerminalStage,
  sweepSavedStatus,
  savedStatusVisible,
  type HandlerDeps,
  type ReleaseRun,
  type TrackedSendResult,
} from './handlers'
import { makeScrollDrain } from '@/packages/clear/scroll-drain'
import { makeSavedStatusLifecycle } from './saved-status-lifecycle'
import { partitionAllowedMediaItems } from '@/packages/sync/url-guard'
import { makeTweetClearer } from '@/packages/clear/tweet-clear'
import { makeReleaseRecheck, type FreshTimelineMembership } from '@/packages/clear/recheck'
import { timelineTweetIds } from '../../core/adapters/x/walk'
import { inlineDataPayloads } from '../../core/adapters/meta-shared/inline-data'
import type {
  CaptureTweets,
  MediaItem,
  QueueUpdate,
  RecoverTweetMediaResponse,
  Settings,
  SavedStatusResponse,
} from '@/packages/schema'

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
//
// `trace` is the PRODUCTION sink and is deliberately separate from `log`: `log` is
// DEV-only and prints element `textContent` on the "Not interested" path, which must
// never reach the durable Release log. `trace` carries only stage tokens, scopes,
// data-testids, ids and counters, so it is safe to persist and export.
//
// Both `trace` and `onFlip` MUST stay lazy arrows — `reportClear` and
// `releaseRecheck` are declared below this call, so a direct reference would be a
// TDZ error at module init. The arrow bodies only run once a clear is in flight.
const { clearScope } = makeTweetClearer({
  document,
  clock: { sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
  ...(import.meta.env.DEV ? { log: clearLog } : {}),
  trace: (stage, detail, tweetId) => reportClear(stage, detail, tweetId),
  // Every CONFIRMED flip arms the re-appearance watchdog. `notInterested` is
  // excluded by type (it has no membership control to re-probe) and never gets here
  // anyway — tweet-clear returns from that branch before the flip poll fires onFlip.
  onFlip: (tweetId, scope, origin) => {
    if (scope !== 'notInterested') releaseRecheck.arm(tweetId, scope, origin)
  },
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
      ...(tweetId !== undefined ? { tweetId } : {}),
      detail,
    }),
  )
}

// ── Release re-appearance watchdog ──
// A confirmed flip is NOT proof the release stuck: the flip poll starts 200ms after
// the click, well before X answers the mutation, so a server-side revert (4xx/429 on
// DeleteBookmark) reports as success — and `flipConfirmed`'s detach arm can call a
// virtualizer unmount a flip that never happened. Both leave the post bookmarked while
// the durable worklist latches it 'cleared', which is why re-running the sweep then
// skips it forever. Re-probing repeatedly across a bounded window is the only signal
// that separates them.
//
// The ghost-vs-real discriminator (`freshTimelineHasMember` below) reads these two
// module-level sets — MUST be module-level, not `main()`-local, because `releaseRecheck`
// itself is also module-level (constructed once at content-script load, mirroring
// `clearScope`/`scrollDrain`), while the sets are WRITTEN from `handleMediaResponse`
// inside `main()`. `null` = no fresh capture yet (SPA start, or before the first
// Bookmarks/Likes response of this session) — a real third state, never coerced to
// "absent" (see `FreshTimelineMembership`'s docstring in recheck.ts).
let freshBookmarksIds: ReadonlySet<string> | null = null
let freshLikesIds: ReadonlySet<string> | null = null
const freshTimelineHasMember = (
  tweetId: string,
  scope: MembershipScope,
): FreshTimelineMembership => {
  const ids = scope === 'bookmark' ? freshBookmarksIds : freshLikesIds
  if (ids === null) return 'unknown'
  return ids.has(tweetId) ? 'present' : 'absent'
}

const releaseRecheck = makeReleaseRecheck({
  clock: {
    after: (ms, fn) => {
      const h = setTimeout(fn, ms)
      return () => clearTimeout(h)
    },
  },
  probe: (tweetId, scope) => {
    const article = findArticle(document, tweetId)
    // `absent` folds together "the row is gone" and "the row is here but shows
    // NEITHER control" (ambiguous DOM / selector rot). Both are inconclusive, and
    // folding the ambiguous case toward `cleared` would falsely absolve a release that
    // never landed — the watchdog must only ever accuse, never exonerate on a guess.
    // `articles` disambiguates a scrolled-away timeline (0) from a live one.
    const state = Option.isNone(article)
      ? 'absent'
      : isMember(article.value, scope)
        ? 'member'
        : alreadyCleared(article.value, scope)
          ? 'cleared'
          : 'absent'
    return {
      state,
      articles: document.querySelectorAll(TWEET_ARTICLE_SEL).length,
      path: location.pathname,
    }
  },
  freshTimelineHasMember,
  report: reportClear,
})

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
  clearMounted: (id, scopes, allLists) =>
    clearMountedTweet(drainDeps(), id, scopes, allLists, 'drain'),
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

const compactReleaseReason = (reason: unknown): string => {
  const raw = reason instanceof Error ? reason.message : String(reason)
  const compact = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return compact || 'unknown'
}

const skipSummaryDetail = (skipped?: SkipSummary): string | null =>
  skipped && skipped.length > 0 ? skipped.map((s) => `${s.reason}:${s.count}`).join(',') : null

const failureSummaryDetail = (
  failures?: ReadonlyArray<{ readonly itemId: string; readonly reason: string }>,
): string | null =>
  failures && failures.length > 0
    ? failures.map((f) => `${f.itemId}:${compactReleaseReason(f.reason)}`).join(',')
    : null

/** Gate-skipped ITEM total, folded out of the reply's by-reason summary. */
const skippedTotal = (skipped?: SkipSummary): number =>
  (skipped ?? []).reduce((n, s) => n + s.count, 0)

/**
 * How many of the requested items the background actually SCHEDULED work for — the
 * only honest answer to "is anything downloading?", and the one the popup now reports.
 *
 * `ok` cannot answer it: a fully-deduped batch takes background.ts's early return and
 * replies `completed:0 total:0`, which is `completed === total`, i.e. `ok === true`,
 * with nothing scheduled. `total` cannot answer it either — it counts REQUESTS, and a
 * sidecar expands one item into two. So: `total === 0` IS the background's own
 * "nothing was scheduled at all" signal (that same early return, and the only way to
 * see the already-in-flight drop, which happens AFTER admission); otherwise the gate's
 * partition of the batch gives the item-level count. URL-rejected items (the
 * fail-closed CDN allow-list) are neither admitted nor gate-skipped, so a forged-URL
 * batch overstates this by that many — the same trace line names them in `failures=`.
 *
 * The `completed === undefined` half is the well-formedness gate, and it is NOT
 * defensive: `reply` is an UNDECODED cast. background.ts's router turns any handler
 * rejection into `{ ok: false, error: 'handler failed' }` (background.ts's
 * `.catch(sendResponse)`), whose `total` is `undefined` — so a `total === 0` test alone
 * fell through and reported the FULL batch as admitted. That fabricated
 * `admitted=7 completed=0 total=7 ok=false` on a run that scheduled nothing, made the
 * popup say "Queued 7 items — some failed to start.", and left DOWNLOAD_REQUEST_FAILED
 * (which needs `admitted === 0`) unreachable.
 */
const admittedCount = (itemCount: number, reply: QueueUpdate | undefined): number =>
  reply?.completed === undefined || reply.total === 0 ? 0 : itemCount - skippedTotal(reply.skipped)

const releaseQueueDetail = (
  release: ReleaseRun,
  reply: QueueUpdate | undefined,
  ok: boolean,
  admitted: number,
): string => {
  const parts = [
    releaseRunDetail(release),
    `admitted=${admitted}`,
    `completed=${reply?.completed ?? 0}`,
    // Falls back to 0, NOT `release.items`: `total` counts what the background said it
    // scheduled, and standing the press-time detection count in for it printed
    // `total=7` next to `completed=0` for a run that never reached the queue — a
    // fabricated number in the one log this whole spine exists to make trustworthy.
    // `items=` on the shared head already carries what was asked for.
    `total=${reply?.total ?? 0}`,
    `ok=${ok}`,
  ]
  const skipped = skipSummaryDetail(reply?.skipped)
  const failures = failureSummaryDetail(reply?.failures)
  if (skipped !== null) parts.push(`skipped=${skipped}`)
  if (failures !== null) parts.push(`failures=${failures}`)
  // Two different silences, and telling them apart is the difference between "the tab
  // never heard back" and "the background answered, but not with a QueueUpdate" — the
  // shape its router replies for ANY handler rejection.
  if (reply?.completed === undefined)
    parts.push(reply === undefined ? 'reason=no-reply' : 'reason=malformed-reply')
  return parts.join(' ')
}

/**
 * Send one tracked request. `clearExpect` (For You only) widens the clear gate to the
 * whole post.
 *
 * `release` is the ONE key to the Release trace: the drain — the only caller that
 * wrote a `clear-download-page-start` — hands its run down, and exactly one terminal
 * is written for it here. This deliberately replaces a gate on
 * `pageScope(location.pathname)`, which fired for EVERY caller: one hover grab on
 * /i/bookmarks used to write a `clear-download-page-end` with no start, byte-identical
 * to a real Release terminal, into the durable log — while a drain off a list page got
 * no terminal at all.
 */
const sendTracked = (
  items: ReadonlyArray<MediaItem>,
  clearExpect?: ClearExpect,
  release?: ReleaseRun,
): Promise<TrackedSendResult> => {
  // A dead channel terminates the run as `-failed` even off a list page: the run DID
  // start, and losing the runtime is a real failure, not the "no list here" skip.
  const traceReleaseFailure = (reason: string): void => {
    if (release !== undefined)
      reportClear('clear-download-page-failed', `${releaseRunDetail(release)} reason=${reason}`)
  }
  return safeSend(() =>
    browser.runtime.sendMessage({
      _tag: 'DownloadRequest',
      items,
      ...(clearExpect ? { clearExpect } : {}),
    }),
  ).then((out) => {
    if (out.status === 'context-invalidated') {
      notifyContextLost()
      traceReleaseFailure('context')
      return { ok: false, admitted: 0, skipped: 0 }
    }
    if (out.status === 'error') {
      // The send itself rejected (an async failure `safeSend` didn't classify as
      // context-invalidation — most likely an uncaught exception inside
      // background.ts's DownloadRequest handler, before it could even build a
      // reply). Previously silently discarded; log it so "why did this fail?"
      // doesn't require opening the SW's own separate devtools context.
      console.warn('[XMD] DownloadRequest send FAILED —', out.error)
      traceReleaseFailure(`channel-${compactReleaseReason(out.error)}`)
      return { ok: false, admitted: 0, skipped: 0 }
    }
    const r = out.reply as QueueUpdate | undefined
    reportSkipped(r?.skipped)
    reportFailures(r?.failures)
    const ok = r?.completed !== undefined && r.completed === r.total
    const admitted = admittedCount(items.length, r)
    if (release !== undefined)
      reportClear(
        releaseTerminalStage(release.scope, ok),
        releaseQueueDetail(release, r, ok, admitted),
      )
    return { ok, admitted, skipped: skippedTotal(r?.skipped) }
  })
}

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
 * Adding the augment modifier (Alt+Cmd by default) grabs the WHOLE post instead;
 * the same whole-post grab fires from the keyboard — `d d` (double-tap) on the
 * hovered post, else the one under X's native j/k cursor (`core/post-hotkey` +
 * `post-grab`).
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
    // The `d d` hotkey sequence state (vim-style whole-post grab).
    let hotkey = idlePostHotkey
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
    // Release diagnostics mutation observation (spec #59 ticket #63), default off.
    // Gates `handleMutationResponse` below FIRST — off means zero work, not just
    // zero relay — kept live by `applySettings` like every other toggle here.
    let releaseMutationDiagnosticsOn = false
    // Tweet-text harvest gate + breadth flag (§7); applySettings keeps them live.
    let captureEnabled = false
    let captureAllScrolled = false
    let savedStatusAlive = true
    /** The COMMITTED route, pinned for exactly the duration of one synchronous
     *  `savedStatusLifecycle.sync()`. WXT dispatches `wxt:locationchange`
     *  synchronously from inside the Navigation API `navigate` event
     *  (wxt/dist/utils/internal/location-watcher.mjs) — i.e. BEFORE the URL
     *  commits — so a route read from that listener is still the OLD one. Null
     *  everywhere else, so every later read (the debounced sweep, the observer's
     *  reschedules, applySettings) still sees the live `location`. */
    let savedStatusCommittedPath: string | null = null
    const savedStatusIsActive = (): boolean =>
      savedStatusAlive &&
      adapter.platform === 'x' &&
      savedStatusVisible(savedStatusCommittedPath ?? location.pathname, savedStatusOn)
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
        const { ok } = await sendTracked(items, forYouClearExpect(items))
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

    // Deps for the whole-post orchestration (`d d` hotkey + the shared payload
    // resolver fireGrab delegates to). Every entry closes over LIVE state.
    const postGrabDeps: PostGrabDeps = {
      adapter,
      store,
      doc: document,
      pathname: () => location.pathname,
      hovered: () => (hoverMedia && hoverKey ? { media: hoverMedia, key: hoverKey } : null),
      focusedArticle: () => focusedTweetArticle(document),
      tweetIdFromArticle,
      send: async (items) => (await sendTracked(items, forYouClearExpect(items))).ok,
      setUi: (ui) => {
        grabUi = ui
        rerender()
      },
      getUi: () => grabUi,
      markGrabbed: (keys) => {
        grab = markAllGrabbed(grab, keys)
      },
      rectOf,
    }

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
        items = wholePostItemsFor(postGrabDeps, media, item)
        // Mark every key of the resolved post so a cursor sweep across sibling
        // slides doesn't re-charge the ring (downstream the gate dedups anyway).
        grab = markAllGrabbed(
          grab,
          [...new Set(items.map((i) => i.postId))].flatMap((id) => store.keysForTweet(id)),
        )
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
      // timeline is virtualized) — bail unless it is still the same media.
      if (!media.isConnected || previewKeyFromMedia(adapter, media, location.pathname) !== key) {
        resetBadge()
        rerender()
        return
      }
      const item = adapter.resolveHoverItem(media, key, store.keyIndex(), location.pathname)
      if (!item) {
        traceBadge('no-item-for-hover', { key })
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
      releaseMutationDiagnosticsOn = s.releaseMutationDiagnosticsEnabled
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
        if (import.meta.env.DEV)
          console.debug(
            `[XMD] media-response · ${adapter.platform} · path=${detail.path} · non-JSON body (${detail.body.length} chars), skipping`,
          )
        return /* non-JSON tee body */
      }
      // Release re-appearance watchdog's ghost-vs-real discriminator (spec #59 ticket
      // #64): the media tee already captures Bookmarks/Likes timeline responses for
      // detection — reuse that SAME capture to track which tweet ids are CURRENTLY
      // members of each list, independent of media (a text-only bookmark still counts).
      // Own try/catch: this must never disrupt media detection below, whatever X's
      // response shape does.
      if (adapter.platform === 'x') {
        try {
          if (detail.path.endsWith('/Bookmarks')) freshBookmarksIds = timelineTweetIds(json)
          else if (detail.path.endsWith('/Likes')) freshLikesIds = timelineTweetIds(json)
        } catch {
          /* the watchdog degrades to freshTimeline=unknown; never break the page */
        }
      }
      try {
        // Fail-closed trust boundary: page scripts can forge 'xmd:media-response'
        // events, so only CDN-allow-listed items ever reach the store.
        const raw = adapter.detectFromResponse(detail.path, json)
        const checked = partitionAllowedMediaItems(raw)
        if (import.meta.env.DEV)
          console.debug(
            `[XMD] media-response · ${adapter.platform} · path=${detail.path} · detected=${raw.length} allowed=${checked.allowed.length} rejected=${checked.rejected.length}`,
          )
        if (checked.rejected.length > 0) {
          console.warn(`[XMD] dropped ${checked.rejected.length} media item(s) with unsafe URLs`)
        }
        const added = store.addDetected(checked.allowed)
        if (added.length > 0) {
          if (import.meta.env.DEV)
            console.debug(
              `[XMD] media-response · ${adapter.platform} · store added ${added.length} new item(s), total=${store.count}`,
            )
          rerender()
        }
        // Instagram/Threads only (X omits extractPostCodes): links the DOM's
        // URL-shortcode to the tee's own postId (which may differ — e.g.
        // Instagram's numeric pk vs its /p/{code}/ shortcode), so a hovered
        // video's DOM-derived post:{code} key (see previewKeyFromMedia above)
        // resolves to the same MediaItem addDetected just indexed by postId.
        const codes = adapter.extractPostCodes?.(json)
        if (codes) {
          if (import.meta.env.DEV && codes.size > 0)
            console.debug(
              `[XMD] media-response · ${adapter.platform} · registered ${codes.size} post code(s)`,
            )
          for (const [postId, code] of codes) store.registerPostCode(postId, code)
        }
      } catch {
        /* media detection is best-effort */
      }
      // Knowledge Capture is X-only-forever (design spec Non-goals): harvestTweets'
      // tree walker assumes X's tweet-node JSON shape, so never call it off-platform.
      if (adapter.platform === 'x') harvestFrom(json, detail.path) // own try/catch — never swallowed by media path
    }
    document.addEventListener('xmd:media-response', handleMediaResponse)

    // Release diagnostics: one observed bookmark/like mutation off the MAIN-world
    // tee's separate 'xmd:mutation-response' channel (spec #59 ticket #63). Fail-
    // closed trust boundary, same posture as `handleMediaResponse` above: page
    // scripts can forge this event, so every field is re-derived/re-validated here
    // — the tee's own classification is not proof of anything. Gated FIRST on the
    // setting (off ⇒ zero work, not just zero relay) and repeats the X-only gate
    // the tee itself already applies (defense in depth).
    const handleMutationResponse = (event: Event): void => {
      if (!releaseMutationDiagnosticsOn || adapter.platform !== 'x') return
      const detail = (
        event as CustomEvent<{
          path: unknown
          status: unknown
          body: unknown
          requestBody: unknown
        }>
      ).detail
      if (typeof detail.path !== 'string' || typeof detail.status !== 'number') return
      const op = matchReleaseMutationOp(detail.path)
      if (op === null) return
      const error = typeof detail.body === 'string' ? bodyHasErrorSignal(detail.body) : false
      const tweetId =
        typeof detail.requestBody === 'string'
          ? tweetIdFromMutationRequestBody(detail.requestBody)
          : undefined
      void safeSend(() =>
        browser.runtime.sendMessage({
          _tag: 'ReleaseMutationEvent',
          op,
          status: detail.status,
          error,
          ...(tweetId !== undefined ? { tweetId } : {}),
          t: Date.now(),
        }),
      )
    }
    document.addEventListener('xmd:mutation-response', handleMutationResponse)

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
    // not a MutationObserver. Instagram/Threads-only: X embeds no media JSON in
    // document scripts, so there is nothing to replay there.
    if (adapter.platform === 'instagram' || adapter.platform === 'threads') {
      const inlineBodies = inlineDataPayloads(document.scripts)
      if (import.meta.env.DEV)
        console.debug(
          `[XMD] inline-data replay · ${adapter.platform} · ${inlineBodies.length} candidate script(s)`,
        )
      for (const body of inlineBodies) {
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
      refreshPostGrabArmed(postGrabActive(grab.active, sample, qgModifier))
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
      postGrabArmed = postGrabActive(grab.active, e, qgModifier)
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
      if (!qgEnabled) return
      if (!isModifierKey(e.key, allAugmentModifier(qgModifier))) return
      refreshPostGrabArmed(postGrabActive(grab.active, e, qgModifier))
    })
    ctx.addEventListener(window, 'keyup', (event) => {
      const e = event as KeyboardEvent
      if (!isModifierKey(e.key, allAugmentModifier(qgModifier))) return
      refreshPostGrabArmed(false)
    })
    // Vim-style `d d`: grab ALL media of the current post — hovered, else X's
    // j/k-focused. Bare `d` is unbound on x.com (`g d` is X's display-settings
    // chord, guarded inside postHotkeyKey), so this stays passive: no
    // preventDefault, X always sees the key.
    ctx.addEventListener(window, 'keydown', (event) => {
      const e = event as KeyboardEvent
      const next = postHotkeyKey(
        hotkey,
        {
          key: e.key,
          altKey: e.altKey,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          repeat: e.repeat,
          target: (e.composedPath?.()[0] ?? e.target) as EventTarget | null,
        },
        Date.now(),
      )
      hotkey = next.state
      if (next.action === 'fire') fireCurrentPost(postGrabDeps)
    })
    ctx.addEventListener(document, 'mouseleave', () => {
      mouseHitTest.clear()
      focusHover(null, null)
      focusBadge(null, null)
    })

    ctx.addEventListener(window, 'wxt:locationchange', (event) => {
      // A pre-navigation sample must not re-arm UI against detached DOM.
      mouseHitTest.clear()
      releaseAll()
      resetBadge()
      focusHover(null, null)
      // "Download this page" must never inherit media detected on a previous SPA
      // route. Without this reset, visiting Tweet Detail/Likes before Bookmarks
      // makes Release enqueue those stale posts against the Bookmarks drain.
      store.clear()
      // An armed 5s probe that wakes up here would query the NEW timeline for a post
      // released off the OLD one, find nothing mounted, and write `clear-recheck
      // state=absent` about a page that no longer exists — noise evicting real evidence
      // from the capped diagnostics ring. This is the navigation half of `cancelAll`'s
      // contract; the teardown half is in `ctx.onInvalidated` below.
      releaseRecheck.cancelAll()
      settleRenderedScan()
      // `sync()` is the ONE synchronous route reader here — everything above is
      // route-independent, and settleRenderedScan defers its scans to rAF. WXT
      // fires this event from inside the Navigation API `navigate` event, BEFORE
      // the URL commits, so an unpinned read evaluates the OLD route: a
      // /likes → /home hop takes savedStatusIsActive()'s inactive branch and the
      // observer is never attached. `showSavedStatus` defaults ON, so that is the
      // DEFAULT path — only a later applySettings re-armed it. Pin the committed
      // path across the call and drop it in `finally`: `sync()` is fully
      // synchronous (it arms the observer and starts a timer, nothing more), so
      // the debounced sweep that fires later still reads the live `location`.
      savedStatusCommittedPath = event.newUrl.pathname
      try {
        savedStatusLifecycle.sync()
      } finally {
        savedStatusCommittedPath = null
      }
      rerender()
    })

    // The handlers' door onto `sendTracked`: it forwards the drain's `ReleaseRun`
    // (and nothing else does), which is what authorizes the terminal. No
    // `clearExpect` — the drain has never widened the For You clear gate, and this
    // is a pure relocation of that behavior, not a change to it.
    const handlerSendTracked: HandlerDeps['sendTracked'] = (items, release) =>
      sendTracked(items, undefined, release)

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
      sendTracked: handlerSendTracked,
      recoverMissingVideos,
      notifyContextLost,
      clearLog,
      reportClear,
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
      // Teardown half of `cancelAll`'s contract (the navigation half is on
      // `wxt:locationchange`): a probe surviving invalidation reports `absent` about a
      // page whose overlay is already gone, and `reportClear` can no longer reach the
      // background to say so — a guaranteed-useless line in a capped log.
      releaseRecheck.cancelAll()
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
      document.removeEventListener('xmd:mutation-response', handleMutationResponse)
    })
  },
})
