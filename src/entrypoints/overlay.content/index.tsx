import './style.css'
import { render } from 'preact'
import { adapterForHostname, ALL_ADAPTERS } from '../../core/adapters/registry'
import type { PlatformAdapter } from '../../core/adapters/types'
import { makeDetectionStore, postGrabItems } from '../../core/adapters/detection-store'
import { harvestTweets } from '../../core/capture/harvest'
import type { Source, TweetRecord } from '../../core/capture/record'
import { parseSyndicationTweet } from '../../core/adapters/x/syndication'
import { videoPosterUrl, VIDEO_PLAYER_SEL, VIDEO_PREVIEW_SECTIONS } from '../../core/adapters/x/dom'
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
import {
  badgeNudgeDelayMs,
  badgeSavedRevertMs,
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
  CLEAR_TESTID,
  CLEARED_STUB_ATTR,
  CLEARED_STUB_CSS,
  alreadyCleared,
  caretControl,
  cellOf,
  clearControl,
  collapseClearedStubs,
  findArticle,
  findFeedbackButton,
  findNotInterestedItem,
  flipConfirmed,
  isForYouHome,
  isMember,
  notInterestedConfirmed,
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
import { inlineDataPayloads } from '../../core/adapters/meta-shared/inline-data'
import type {
  CaptureTweets,
  ClearScope,
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

type HoverMediaElement = HTMLImageElement | HTMLVideoElement

/** Verbose clear-on-save tracing → the X PAGE console (content-script world).
 *  Open DevTools on the X tab to watch the un-bookmark/un-like decision live.
 *  DEV-only: every call site is guarded by `import.meta.env.DEV`, so neither the
 *  log strings nor `actionTestids(...)` are computed in the shipped build. */
const clearLog = (...args: unknown[]): void => console.info('[XMD clear]', ...args)

/** Every bookmark/like-ish data-testid actually present in an article — the tell
 *  for a selector mismatch (X renamed the control we click). */
const actionTestids = (article: Element): string[] =>
  [...article.querySelectorAll('[data-testid]')]
    .map((el) => el.getAttribute('data-testid') ?? '')
    .filter((t) => /bookmark|like/i.test(t))

// Poll for the post-click testid flip. X updates the control optimistically, but
// the row removal / re-render can lag well past a single tick, so we poll a fixed
// number of times rather than waiting once.
const FLIP_POLL_INTERVAL_MS = 200
const FLIP_POLL_ATTEMPTS = 6
const FLIP_CONFIRM_TIMEOUT_MS = FLIP_POLL_ATTEMPTS * FLIP_POLL_INTERVAL_MS

// Clear ONE scope for a tweet. Re-resolves the article by id IMMEDIATELY before
// the click (findArticle re-checks tweetId), so a virtualized/recycled node can
// never make us click the wrong post (spec §4.4 — the guard must run per click,
// not once per request). Member ⇒ click X's own control and confirm the flip on a
// FRESHLY re-resolved node (the settle window catches the optimistic re-render, and
// the row often detaches on a worklist page = cleared). Not a member ⇒ ok only if
// confirmed already-cleared; ambiguous DOM ⇒ false (stays re-claimable, never a
// blind "cleared" on selector rot).
async function clearScope(tweetId: string, scope: ClearScope): Promise<boolean> {
  const article = findArticle(document, tweetId)
  if (Option.isNone(article)) {
    if (import.meta.env.DEV) clearLog(scope, tweetId, '→ no matching article on page')
    return false
  }
  // The timeline feed clear is a caret-menu interaction, not a button flip.
  if (scope === 'notInterested') return clearNotInterested(article.value, tweetId)
  if (!isMember(article.value, scope)) {
    const ac = alreadyCleared(article.value, scope)
    if (import.meta.env.DEV)
      clearLog(
        scope,
        '→ not a member; alreadyCleared =',
        ac,
        '· testids present:',
        actionTestids(article.value),
      )
    return ac
  }
  const ctrl = clearControl(article.value, scope)
  if (ctrl === null) {
    if (import.meta.env.DEV)
      clearLog(
        scope,
        '→ member but control not found (selector rot?)',
        actionTestids(article.value),
      )
    return false
  }
  // Click the actionable button, not the bare testid node — X may put the testid
  // on a wrapper; clicking `.closest(button/role=button)` is the path proven to
  // un-like in the console. Falls back to the element itself.
  const target = (ctrl.closest('button,[role="button"]') as HTMLElement | null) ?? ctrl
  if (import.meta.env.DEV) clearLog(scope, '→ clicking', CLEAR_TESTID[scope].active)
  target.click()
  // Poll for the flip: X updates the control optimistically but the row removal /
  // re-render can lag well past a single tick — too short a window reports a real
  // un-like/un-bookmark as a failure. Confirm on the SAME node: its active
  // un-control gone (flipped in place) or the row detached.
  // oxlint-disable no-await-in-loop -- sequential poll with a fixed cap
  for (let i = 1; i <= FLIP_POLL_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, FLIP_POLL_INTERVAL_MS))
    if (flipConfirmed(article.value, scope)) {
      if (import.meta.env.DEV)
        clearLog(scope, `→ flip confirmed after ${i * FLIP_POLL_INTERVAL_MS}ms`)
      return true
    }
  }
  // oxlint-enable no-await-in-loop
  if (import.meta.env.DEV)
    clearLog(
      scope,
      `→ NO flip after ${FLIP_CONFIRM_TIMEOUT_MS / 1000}s · testids now:`,
      actionTestids(article.value),
    )
  return false
}

/** Close any open X menu (Escape) — cleans up a bailed "Not interested" attempt so
 *  a half-opened caret menu isn't left covering the feed. */
function dismissMenu(): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
}

// Clear a For You post by firing X's own "Not interested in this post": open the
// tweet's caret menu, click the item, then confirm the post left the feed. Two
// staged polls — one for the (portaled, document-level) menu to mount, one for the
// post to collapse/detach. Fails safe at every step: no caret, no menu/item, or no
// collapse ⇒ false (stays re-claimable, never a blind "cleared" on selector rot),
// and a bailed attempt dismisses the dangling menu.
async function clearNotInterested(article: Element, tweetId: string): Promise<boolean> {
  const caret = caretControl(article)
  if (caret === null) {
    if (import.meta.env.DEV)
      clearLog('notInterested', tweetId, '→ no caret control (selector rot?)')
    return false
  }
  // Capture the wrapping cell BEFORE the click — X replaces the tweet article with
  // the feedback stub in-place, so we'd lose the handle once it fires.
  const cell = cellOf(article)
  const caretTarget = (caret.closest('button,[role="button"]') as HTMLElement | null) ?? caret
  // Snapshot the menus open BEFORE we click, so we only ever act on the menu THIS
  // caret click opens — never a stale clear-menu, the account switcher, a
  // compose/share menu, or one the user opened by hand. X portals the caret menu to
  // the document with no article tie-back, so a document-wide search could otherwise
  // fire "Not interested" in the WRONG post's menu (the irreversible-action footgun).
  const before = new Set(document.querySelectorAll('[role="menu"]'))
  if (import.meta.env.DEV) clearLog('notInterested', tweetId, '→ opening caret menu')
  caretTarget.click()
  // Poll for the menu our click opened — the one new since the snapshot. Exactly one
  // new menu = ours; two+ is ambiguous (don't guess which is this caret's) → bail.
  let item: HTMLElement | null = null
  // oxlint-disable no-await-in-loop -- staged poll with a fixed cap
  for (let i = 1; i <= FLIP_POLL_ATTEMPTS && item === null; i++) {
    await new Promise((r) => setTimeout(r, FLIP_POLL_INTERVAL_MS))
    const opened = [...document.querySelectorAll('[role="menu"]')].filter((m) => !before.has(m))
    if (opened.length > 1) break
    const [sole] = opened
    if (sole) item = Option.getOrNull(findNotInterestedItem(sole))
  }
  if (item === null) {
    if (import.meta.env.DEV) clearLog('notInterested', '→ own menu/item not found; dismissing')
    dismissMenu()
    return false
  }
  if (import.meta.env.DEV) clearLog('notInterested', '→ clicking "Not interested in this post"')
  item.click()
  // Confirm the post left the feed (article detached, or its caret/action bar gone),
  // then FULLY hide it: click the follow-up "This post isn't relevant" so X drops the
  // post rather than leaving the "Thanks…" stub (the stub-collapse CSS hides any
  // residual). Without this the cleared post lingers as a feedback panel on the feed.
  for (let i = 1; i <= FLIP_POLL_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, FLIP_POLL_INTERVAL_MS))
    if (notInterestedConfirmed(article)) {
      if (import.meta.env.DEV)
        clearLog('notInterested', `→ confirmed after ${i * FLIP_POLL_INTERVAL_MS}ms`)
      // Collapse the cleared cell immediately (the observer also keeps it marked,
      // recycling-safe) so the "Thanks…" stub never flashes, then click the
      // follow-up so X drops the post natively.
      cell?.setAttribute(CLEARED_STUB_ATTR, '')
      await dismissFeedbackStub(cell)
      return true
    }
  }
  // oxlint-enable no-await-in-loop
  if (import.meta.env.DEV) clearLog('notInterested', '→ NO collapse; dismissing')
  dismissMenu()
  return false
}

/** After "Not interested" confirms, X leaves a feedback stub ("Thanks…/Show fewer/
 *  This post isn't relevant"). Click the post-level dismiss so X drops the post
 *  entirely (it renders a beat after the article unmounts — poll briefly). The
 *  stub-collapse CSS hides any residual, so this is best-effort: the CSS is the
 *  guarantee, the click is the native full-dismiss (matching xtimelinefilter). */
async function dismissFeedbackStub(cell: Element | null): Promise<void> {
  if (cell === null) return
  // oxlint-disable no-await-in-loop -- short bounded poll for the follow-up panel
  for (let i = 1; i <= FLIP_POLL_ATTEMPTS; i++) {
    const fb = findFeedbackButton(cell)
    if (Option.isSome(fb)) {
      if (import.meta.env.DEV)
        clearLog('notInterested', '→ dismissing feedback stub:', fb.value.textContent?.trim())
      ;((fb.value.closest('button,[role="button"]') as HTMLElement | null) ?? fb.value).click()
      return
    }
    await new Promise((r) => setTimeout(r, FLIP_POLL_INTERVAL_MS))
  }
  // oxlint-enable no-await-in-loop
}

// ── Auto-scroll drain for not-mounted clears ──
// The bounded scroll-pass loop lives in `core/clear/scroll-drain`; this entrypoint
// wires the live window/document/timer ports + the real clear and trace sinks into it
// (see `scrollDrain` below).
// Debounce for the cross-device "Saved" status sweep: a burst of scroll/render
// mutations collapses into one overlay→background round-trip + chip pass.
const SAVED_SWEEP_DEBOUNCE_MS = 500

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

/** Accessible name for the badge by the one Media Item it downloads. */
const BADGE_ARIA: Record<MediaItem['type'], string> = {
  photo: 'Download photo',
  video: 'Download video',
  gif: 'Download GIF',
}

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
    // Whole-post grab (Cmd augment) is Instagram/Threads-only by product decision.
    const postGrabEligible = adapter.platform === 'instagram' || adapter.platform === 'threads'
    // Boot marker: if you don't see this in the X page console, the content
    // script isn't live on this tab (old build loaded, or the tab predates the
    // extension reload) — reload the extension AND refresh the tab.
    console.info('[XMD] overlay content script loaded @', location.href, adapter.platform)

    const store = makeDetectionStore({ mediaKeyFromUrl: adapter.mediaKeyFromUrl })
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
    // X-only: `store.needsRecovery` walks X's VIDEO_PLAYER_SEL/TWEET_ARTICLE_SEL
    // (syndication recovery has no Instagram/Threads equivalent — design spec
    // Non-goals) — skip the DOM walk entirely on other platforms.
    const recoverMissingVideos = (): void => {
      if (adapter.platform !== 'x') return
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
      recoverMissingVideos()
    }

    const queueRenderedMediaScan = (): void => {
      if (renderedScanQueued) return
      renderedScanQueued = true
      ctx.requestAnimationFrame(() => {
        renderedScanQueued = false
        scanRenderedMedia()
      })
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
      queueRenderedMediaScan()
      settleTimers = [
        setTimeout(queueRenderedMediaScan, 700),
        setTimeout(queueRenderedMediaScan, 2000),
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
    // setting (applySettings keeps `savedStatusOn` live).
    let savedStatusOn = false
    // Tweet-text harvest gate + breadth flag (§7); applySettings keeps them live.
    let captureEnabled = false
    let captureAllScrolled = false
    let savedSweepTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleSavedSweep = (): void => {
      if (savedSweepTimer !== null) clearTimeout(savedSweepTimer)
      savedSweepTimer = setTimeout(() => {
        savedSweepTimer = null
        void sweepSavedStatus({
          document,
          inScope: () => savedStatusVisible(location.pathname, savedStatusOn),
          requestSavedStatus,
        })
      }, SAVED_SWEEP_DEBOUNCE_MS)
    }
    // X-only: SavedIndex/Convex queries + TWEET_ARTICLE_SEL/tweetIdOfArticle are
    // X-DOM-specific — never construct this observer on Instagram/Threads tabs.
    if (adapter.platform === 'x') {
      const savedSweepObserver = new MutationObserver(scheduleSavedSweep)
      savedSweepObserver.observe(document.body, { childList: true, subtree: true })
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
        // TEMP DIAG (grab-all) — DEV-gated (see below), REMOVE after confirming
        // on live IG/Threads.
        // Breaks the payload down by media TYPE and by postId so a missing-video
        // report can be pinned to the right boundary: `sendingTypes` lacking the
        // videos ⇒ they never got RESOLVED into the payload (a postId/resolution
        // bug); `sendingTypes` INCLUDING them but nothing downloading ⇒ they were
        // resolved and the dedup/size gate dropped them downstream. `videosInStore`
        // + `postIdCounts` expose a postId split (videos indexed under a different
        // postId than `codePostId`, so `valuesForTweet(codePostId)` misses them).
        // The whole block — including the per-call type/postId scans and the
        // JSON.stringify — is skipped in prod builds.
        if (import.meta.env.DEV) {
          const typeCounts = (arr: readonly MediaItem[]): Record<string, number> =>
            arr.reduce<Record<string, number>>((a, i) => {
              a[i.type] = (a[i.type] ?? 0) + 1
              return a
            }, {})
          console.info(
            '[XMD grab-all diag]',
            JSON.stringify({
              platform: adapter.platform,
              hoveredType: item.type,
              hoveredPostId: item.postId,
              hoveredId: item.id,
              hoveredInStore: store.get(item.id) !== undefined,
              domCode: code,
              codePostId: codePostId ?? null,
              codeMatchesHovered: (codePostId ?? null) === item.postId,
              teePostCount: teePost.length,
              teeTypes: typeCounts(teePost),
              sending: items.length,
              sendingTypes: typeCounts(items),
              videosInStore: store
                .values()
                .filter((i) => i.type === 'video')
                .map((i) => ({ postId: i.postId, index: i.index, id: i.id })),
              postIdCounts: store.values().reduce<Record<string, number>>((a, i) => {
                a[i.postId] = (a[i.postId] ?? 0) + 1
                return a
              }, {}),
              storeCount: store.count,
            }),
          )
        }
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
      if (!media.isConnected || previewKeyFromMedia(adapter, media) !== key) {
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
      if (adapter.platform === 'x') scheduleSavedSweep()
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

    document.addEventListener('xmd:media-response', (event) => {
      const detail = (event as CustomEvent<{ path: string; body: string }>).detail
      let json: unknown
      try {
        json = JSON.parse(detail.body)
      } catch {
        return /* non-JSON tee body */
      }
      try {
        if (store.addDetected(adapter.detectFromResponse(detail.path, json)).length > 0) rerender()
        // Instagram/Threads only (X omits extractPostCodes): links the DOM's
        // URL-shortcode to the tee's own postId (which may differ — e.g.
        // Instagram's numeric pk vs its /p/{code}/ shortcode), so a hovered
        // video's DOM-derived post:{code} key (see previewKeyFromMedia above)
        // resolves to the same MediaItem addDetected just indexed by postId.
        const codes = adapter.extractPostCodes?.(json)
        if (codes) for (const [postId, code] of codes) store.registerPostCode(postId, code)
      } catch {
        /* media detection is best-effort */
      }
      // Knowledge Capture is X-only-forever (design spec Non-goals): harvestTweets'
      // tree walker assumes X's tweet-node JSON shape, so never call it off-platform.
      if (adapter.platform === 'x') harvestFrom(json, detail.path) // own try/catch — never swallowed by media path
    })

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
    // TEMP hover diag — throttle key, DEV-gated (see below), REMOVE after
    // debugging grab failures.
    let hoverProbeLast: Element | null = null
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
      // TEMP hover diag — logs (once per element) WHY a hovered media does/doesn't
      // resolve, but only while the grab modifier is held. DEV-gated: the whole
      // block (including the URL parse and JSON.stringify) is skipped in prod
      // builds. REMOVE after debugging.
      if (import.meta.env.DEV) {
        if (grabbing && target && target !== hoverProbeLast) {
          hoverProbeLast = target
          const src = media
            ? isVideoElement(media)
              ? media.poster || media.currentSrc || media.src
              : media.currentSrc || media.src
            : ''
          let host = ''
          let family: string | null = null
          try {
            const u = new URL(src)
            host = u.hostname
            family = u.pathname.split('/').find((p) => /^t\d+(\.\d+-\d+)?$/.test(p)) ?? null
          } catch {
            /* blob: or empty src */
          }
          console.info(
            '[XMD hover diag]',
            JSON.stringify({
              mediaTag: media?.tagName ?? null,
              key,
              host,
              family,
              srcKind: src.startsWith('blob:') ? 'blob:' : src.slice(0, 44),
              targetTag: target.tagName,
              targetClass:
                typeof target.className === 'string' ? target.className.slice(0, 70) : '',
              hasArticle: target.closest('article') !== null,
              domCode: media
                ? (adapter.postCodeFromElement?.(media, location.pathname) ?? null)
                : null,
            }),
          )
        }
      }
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
      resetBadge()
      focusHover(null, null)
      settleRenderedScan()
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
      previewKeyFromMedia: (media) => previewKeyFromMedia(adapter, media),
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
      clearDwell()
      setCursorActive(false)
      grab = idleQuickGrab
      grabUi = null
      resetBadge()
      clearLauncherRevert()
      clearRescanSpin()
      clearSettleTimers()
      launcher = 'idle'
      renderedScanQueued = false
      scrollHitTestQueued = false
      revealObserver?.disconnect()
      revealObserver = null
      stubObserver?.disconnect()
      stubObserver = null
      stubStyle?.remove()
      stubStyle = null
      // `browser.runtime` is already undefined once the context is invalidated.
      browser.runtime?.onMessage?.removeListener(handleRuntimeMessage)
    })
  },
})
