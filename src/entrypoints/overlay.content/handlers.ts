// Runtime-message handlers for the overlay content script, lifted out of the
// 226-line `handleRuntimeMessage` router in index.tsx. Pure relocation: each
// handler is a named function taking an explicit `HandlerDeps` context that
// threads main()'s closed-over mutable state as LIVE references (getters/setters
// + sibling helpers), never value copies — so the badge/launcher correction in
// `handleTransferOutcome` and the `store.clear()` reset in
// `handleClearDetectedMedia` still read AND write the same live state they did
// when inlined. The dispatch table at the bottom maps each message `_tag` to its
// handler; the router in index.tsx collapses to a single table lookup.
import { Option, Result, Schema } from 'effect'
import { resolveOutcome, type BadgeState } from '../../core/badge'
import { resolveOutcomeAll, type LauncherPhase } from '../../core/launcher'
import type { PlatformAdapter } from '../../core/adapters/types'
import { safeSend } from '../../core/messaging'
import { findFreshMediaItem } from '../../core/download/media-url-refresh'
import { makeListClear } from '../../core/clear/list-clear'
import type { ClearScopeResult } from '../../core/clear/result'
import {
  TWEET_ARTICLE_SEL,
  clearControl,
  clearableScope,
  findArticle,
  isMember,
  pageScope,
  shouldClickScope,
  tweetIdOfArticle,
  type MembershipScope,
} from '../../core/clear/clearer'
import type { makeDetectionStore } from '../../core/adapters/detection-store'
import type { ClearScope, MediaItem } from '../../core/schema'
import {
  TAB_MESSAGE_MEMBERS,
  TransferOutcome,
  SavedStatusUpdate,
  ClearDetectedMediaRequest,
} from '../../core/schema'

type HoverMediaElement = HTMLImageElement | HTMLVideoElement
type DetectionStore = ReturnType<typeof makeDetectionStore>

/**
 * LIVE handle on main()'s closed-over state and helpers. Scalars are exposed as
 * getter/setter pairs so a handler reads the current value and writes back into
 * the same closure variable (never a stale copy); objects (store) and helper
 * closures (rerender, resetBadge, …) are passed by reference. Every field here
 * is something a handler must read or mutate to preserve the inlined behavior.
 */
export interface HandlerDeps {
  readonly adapter: PlatformAdapter
  readonly store: DetectionStore
  readonly document: Document
  readonly location: Location
  readonly rerender: () => void
  // Badge live state + lifecycle.
  readonly getBadge: () => BadgeState
  readonly setBadge: (b: BadgeState) => void
  readonly getBadgeMedia: () => HoverMediaElement | null
  readonly getBadgeRequestId: () => string | null
  readonly getBadgeRequestKey: () => string | null
  readonly clearBadgeTimers: () => void
  readonly resetBadge: () => void
  readonly previewKeyFromMedia: (media: HoverMediaElement | null) => string | null
  // Launcher live state.
  readonly getLauncher: () => LauncherPhase
  readonly setLauncher: (p: LauncherPhase) => void
  readonly getLauncherBatchIds: () => ReadonlySet<string>
  readonly clearLauncherRevert: () => void
  // Quick-grab / rescan live state touched by ClearDetectedMediaRequest.
  readonly clearDwell: () => void
  readonly setCursorActive: (on: boolean) => void
  readonly resetGrab: () => void
  readonly clearRescanSpin: () => void
  // Shared side-effecting helpers.
  readonly sendTracked: (items: ReadonlyArray<MediaItem>) => Promise<boolean>
  readonly recoverMissingVideos: () => void
  readonly notifyContextLost: () => void
  readonly clearLog: (...args: unknown[]) => void
  readonly clearScope: (tweetId: string, scope: ClearScope) => Promise<boolean>
  /** Run one worker-authorized Scroll Drain and return its terminal result. */
  readonly runDrain: (
    tweetId: string,
    scopes: ClearScope[],
    allLists: boolean,
  ) => Promise<ReadonlyArray<ClearResult>>
  /** Whether the "Saved" status is live on THIS page right now (setting on AND an
   *  in-scope timeline) — gates the late cross-device chip push. */
  readonly savedStatusActive: () => boolean
}

type SendResponse = (r: unknown) => void

/** A handler returns `true` to keep the message channel open for an async reply,
 *  or `false`/`undefined` for the fire-and-forget / unknown-tag paths. */
type MessageHandler = (
  message: unknown,
  deps: HandlerDeps,
  sendResponse: SendResponse,
) => boolean | void

// ── Cross-device "Saved" status sweep (B+C) ──────────────────────────────────

/** CSS class of an injected chip — and the idempotency guard (one per article). */
const SAVED_CHIP_CLASS = 'xdl-saved-chip'

/** The pages where the "Saved" status is shown: the home timeline (For You /
 *  Following) and List timelines. Profiles, Likes, Bookmarks, search, and
 *  single-tweet pages are out of scope for v1. */
export function isSavedStatusScope(pathname: string): boolean {
  return pathname === '/home' || /^\/i\/lists\/\d+/.test(pathname)
}

/** The full gate for the sweep: the `showSavedStatus` setting is on AND the page is
 *  an in-scope timeline. The overlay passes this as the sweep's `inScope`. */
export function savedStatusVisible(pathname: string, showSavedStatus: boolean): boolean {
  return showSavedStatus && isSavedStatusScope(pathname)
}

/** Inject the "Saved ✓" chip into an article, once. Idempotent: a re-sweep over an
 *  already-marked article is a no-op (the chip itself is the marker). */
function markArticleSaved(article: Element, doc: Document): void {
  if (article.querySelector(`.${SAVED_CHIP_CLASS}`) !== null) return
  // Give the chip a positioning context without disturbing X's own layout classes.
  if (article instanceof HTMLElement && article.style.position === '') {
    article.style.position = 'relative'
  }
  const chip = doc.createElement('div')
  chip.className = SAVED_CHIP_CLASS
  chip.textContent = 'Saved ✓'
  chip.setAttribute('aria-label', 'Already downloaded')
  article.appendChild(chip)
}

/** Sweep the visible timeline: enumerate posts (de-duped by tweetId), ask the
 *  background which are already downloaded cross-device, and chip each saved one.
 *  Fail-safe by construction — a chip appears ONLY on a positive reply, so missing
 *  data or a dropped request never marks a post. */
export async function sweepSavedStatus(deps: {
  readonly document: Document
  readonly inScope: () => boolean
  readonly requestSavedStatus: (tweetIds: string[]) => Promise<string[]>
}): Promise<void> {
  if (!deps.inScope()) return
  const byTweet = new Map<string, Element>()
  for (const article of deps.document.querySelectorAll(TWEET_ARTICLE_SEL)) {
    const tweetId = tweetIdOfArticle(article)
    if (Option.isNone(tweetId) || byTweet.has(tweetId.value)) continue
    byTweet.set(tweetId.value, article)
  }
  if (byTweet.size === 0) return
  const saved = await deps.requestSavedStatus([...byTweet.keys()])
  // The route/setting may have changed while the request was in flight — never
  // paint chips after scope was lost.
  if (!deps.inScope()) return
  for (const tweetId of saved) {
    const article = byTweet.get(tweetId)
    if (article !== undefined) markArticleSaved(article, deps.document)
  }
}

/** LATE cross-device hits pushed by the background (`SavedStatusUpdate`): the sweep's
 *  instant reply carries only the locally-known subset; once the Convex backstop
 *  answers, the fresh hits arrive here and chip any still-mounted article. Fail-safe
 *  like the sweep — scope-gated, positive ids only, idempotent chip injection. */
export const handleSavedStatusUpdate: MessageHandler = (message, deps) => {
  // The sweep/chip DOM (TWEET_ARTICLE_SEL, tweetIdOfArticle) is X-specific; an
  // Instagram/Threads tab has nothing to chip. Fire-and-forget, so a bare early
  // return (no sendResponse) is the correct no-op here too.
  if (deps.adapter.platform !== 'x') return
  if (!deps.savedStatusActive()) return
  const saved = (message as { saved?: unknown }).saved
  if (!Array.isArray(saved) || saved.length === 0) return
  const ids = new Set(saved.filter((x): x is string => typeof x === 'string'))
  for (const article of deps.document.querySelectorAll(TWEET_ARTICLE_SEL)) {
    const tweetId = tweetIdOfArticle(article)
    if (Option.isSome(tweetId) && ids.has(tweetId.value)) markArticleSaved(article, deps.document)
  }
}

// A tracked transfer reached its TERMINAL outcome after the optimistic save
// (bytes landed / 403 / timeout). Correct the badge/launcher that fired it,
// ONLY while still on screen. Broadcast to every X tab, so this no-ops unless
// this tab is the one whose entrance/batch owns the request. Fire-and-forget.
export const handleTransferOutcome: MessageHandler = (message, deps) => {
  const m = message as { requestId: string; outcome: 'complete' | 'failed' }
  const ok = m.outcome === 'complete'
  const badge = deps.getBadge()
  const badgeMedia = deps.getBadgeMedia()
  if (
    m.requestId === deps.getBadgeRequestId() &&
    badge.key === deps.getBadgeRequestKey() &&
    badgeMedia?.isConnected === true &&
    deps.previewKeyFromMedia(badgeMedia) === badge.key
  ) {
    const nextBadge = resolveOutcome(badge, ok)
    if (nextBadge !== badge) {
      deps.clearBadgeTimers()
      deps.setBadge(nextBadge)
      deps.rerender()
    }
  }
  if (deps.getLauncherBatchIds().has(m.requestId)) {
    const launcher = deps.getLauncher()
    const nextLauncher = resolveOutcomeAll(launcher, ok)
    if (nextLauncher !== launcher) {
      deps.setLauncher(nextLauncher)
      deps.rerender()
    }
  }
  return false // fire-and-forget: no reply; do not keep the channel open
}

// The background re-resolves a CDN url from this open tab before an
// interrupt retry (twimg urls expire). Answer from the detected map, or a
// fresh DOM scan keyed by tweet/index/type when the item has rotated out.
export const handleRefreshMediaUrl: MessageHandler = (message, deps, sendResponse) => {
  const req = message as {
    itemId: string
    tweetId: string
    index?: number
    type?: MediaItem['type']
  }
  let fresh = deps.store.get(req.itemId)
  if (fresh?.postId !== req.tweetId) fresh = undefined
  if (fresh === undefined && req.index !== undefined && req.type !== undefined) {
    const domItems = deps.adapter.detectRenderedMedia(deps.document, deps.location.pathname)
    if (domItems.length > 0) deps.store.addDetected(domItems)
    fresh = findFreshMediaItem(
      { id: req.itemId, postId: req.tweetId, index: req.index, type: req.type },
      [...deps.store.values(), ...domItems],
    )
  }
  sendResponse({ _tag: 'RefreshMediaUrlResponse', ...(fresh ? { url: fresh.url } : {}) })
  return true
}

/** Click the clear control on every mounted post that is a clearable member of
 *  `scope`, paced one click at a time so X registers each. Returns how many were
 *  clicked. Shared by the one-shot visible clear and the whole-list scroll sweep. */
export async function clearMountedForScope(
  document: Document,
  scope: MembershipScope,
  paceMs: number,
): Promise<number> {
  let cleared = 0
  // oxlint-disable no-await-in-loop -- paced one-at-a-time bulk clear
  for (const article of document.querySelectorAll(TWEET_ARTICLE_SEL)) {
    const ctrl = clearControl(article, scope)
    if (ctrl === null) continue
    const target = (ctrl.closest('button,[role="button"]') as HTMLElement | null) ?? ctrl
    target.click()
    cleared++
    await new Promise((r) => setTimeout(r, paceMs))
  }
  // oxlint-enable no-await-in-loop
  return cleared
}

// Manual "Clear this page now" (popup button): un-bookmark / un-like EVERY
// currently-mounted post for the requested scopes — a one-shot Drain of the
// visible worklist, independent of downloads. Same click path proven to work.
export const handleClearVisible: MessageHandler = (_message, deps, sendResponse) => {
  // X-only: pageScope/TWEET_ARTICLE_SEL are X-specific DOM selectors that happen
  // to match nothing off-X — gate explicitly rather than rely on that accident.
  if (deps.adapter.platform !== 'x') {
    sendResponse({ _tag: 'ClearVisibleResponse', cleared: 0 })
    return
  }
  // List-scoped: only ever clear the list you're ON — Likes page un-likes,
  // Bookmarks page un-bookmarks. Never both at once.
  const scope = pageScope(deps.location.pathname)
  if (import.meta.env.DEV)
    deps.clearLog(
      'clear-visible request · page scope =',
      Option.getOrElse(scope, () => '(not a Likes/Bookmarks page)'),
    )
  void (async () => {
    if (Option.isNone(scope)) {
      sendResponse({ _tag: 'ClearVisibleResponse', cleared: 0 })
      return
    }
    const cleared = await clearMountedForScope(deps.document, scope.value, 350)
    if (import.meta.env.DEV) deps.clearLog('clear-visible done · cleared', cleared, scope.value)
    sendResponse({ _tag: 'ClearVisibleResponse', cleared })
  })()
  return true
}

// "Clear entire list" (popup): auto-scroll the whole Likes/Bookmarks list and click
// every post's clear control as it mounts — a list-scoped, download-free bulk clear.
// The bounded scroll loop lives in core/clear/list-clear; here we wire the live
// window/document/timer ports + the shared per-pass clear.
export const handleClearWholeList: MessageHandler = (_message, deps, sendResponse) => {
  // X-only: the auto-scroll drain clicks X's own bookmark/like controls.
  if (deps.adapter.platform !== 'x') {
    sendResponse({ _tag: 'ClearWholeListResponse', cleared: 0, reason: 'not-x' })
    return true
  }
  const scope = pageScope(deps.location.pathname)
  if (Option.isNone(scope)) {
    sendResponse({ _tag: 'ClearWholeListResponse', cleared: 0, reason: 'not-list-page' })
    return true
  }
  const view = deps.document.defaultView ?? window
  const listClear = makeListClear({
    scroll: {
      position: () => view.scrollY,
      to: (y) => view.scrollTo(0, y),
      by: (dy) => view.scrollBy(0, dy),
      viewport: () => view.innerHeight,
    },
    clock: {
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      after: (ms, fn) => {
        const h = setTimeout(fn, ms)
        return () => clearTimeout(h)
      },
    },
    path: () => deps.location.pathname,
    clearVisibleForPage: () => clearMountedForScope(deps.document, scope.value, 350),
    report: (stage, detail) => {
      if (import.meta.env.DEV) deps.clearLog(stage, detail)
    },
  })
  void (async () => {
    const result = await listClear.run()
    sendResponse({ _tag: 'ClearWholeListResponse', ...result })
  })()
  return true
}

// "Drain this page" (popup): hand every detected item to the download queue;
// clear-on-save then un-likes/un-bookmarks each post (list-scoped) as its
// media truly completes — the list self-empties. Scroll + repeat for more.
export const handleDrainPage: MessageHandler = (_message, deps, sendResponse) => {
  const items = deps.store.values()
  if (import.meta.env.DEV)
    deps.clearLog(
      'drain-page · downloading',
      items.length,
      'items · scope',
      Option.getOrNull(pageScope(deps.location.pathname)),
    )
  void deps.sendTracked(items)
  sendResponse({ _tag: 'DrainPageResponse', count: items.length })
  return true
}

// "Download + clear, one by one" (popup): the durable sweep. Collect the
// posts currently mounted on this list page that are members of its scope
// AND whose media we detected (we only ever clear a post whose media we
// saved), de-duped by tweetId, then hand them to the background. The
// background owns the persistent worklist flag: it skips already-cleared
// tweets, queues the downloads, and clears each via the verified Settle
// pipeline — nothing is clicked here. Progress is durable, so re-running
// after scrolling only picks up new posts. List-scoped; on-screen only.
export const handleSweepPage: MessageHandler = (_message, deps, sendResponse) => {
  const scope = pageScope(deps.location.pathname)
  if (import.meta.env.DEV)
    deps.clearLog(
      'sweep request · page scope =',
      Option.getOrElse(scope, () => '(not a Likes/Bookmarks page)'),
    )
  if (Option.isNone(scope)) {
    sendResponse({
      _tag: 'SweepPageResponse',
      ok: false,
      queued: 0,
      skipped: 0,
      reason: 'not-list-page',
    })
    return true
  }
  const posts: { tweetId: string; items: MediaItem[] }[] = []
  const seen = new Set<string>()
  for (const article of deps.document.querySelectorAll(TWEET_ARTICLE_SEL)) {
    if (!isMember(article, scope.value)) continue
    const tweetId = tweetIdOfArticle(article)
    if (Option.isNone(tweetId) || seen.has(tweetId.value)) continue
    const items = deps.store.valuesForTweet(tweetId.value)
    if (items.length === 0) continue
    seen.add(tweetId.value)
    posts.push({ tweetId: tweetId.value, items })
  }
  if (import.meta.env.DEV)
    deps.clearLog('sweep · handing', posts.length, 'posts to background on', scope.value)
  void (async () => {
    const out = await safeSend(() =>
      browser.runtime.sendMessage({ _tag: 'SweepEnqueueRequest', scope: scope.value, posts }),
    )
    if (out.status === 'context-invalidated') {
      deps.notifyContextLost()
      sendResponse({
        _tag: 'SweepPageResponse',
        ok: false,
        queued: 0,
        skipped: 0,
        reason: 'context',
      })
      return
    }
    const r =
      out.status === 'ok'
        ? (out.reply as { queued?: number; skipped?: number } | undefined)
        : undefined
    sendResponse({
      _tag: 'SweepPageResponse',
      ok: out.status === 'ok',
      queued: r?.queued ?? 0,
      skipped: r?.skipped ?? 0,
    })
  })()
  return true
}

// Clear-on-complete (worklist): the tweet is Truly Complete — un-bookmark /
// un-like it by clicking X's own control, then VERIFY the testid flipped
// before reporting ok. id-match guard + membership check defend against
// virtualization clicking the wrong post (spec §4.4).
export type ClearResult = ClearScopeResult

/**
 * Clear one MOUNTED tweet. Which scope(s) actually click is `shouldClickScope`'s
 * call: page-scoped by default (only the current page's list / "Not interested" on
 * For You), or membership-driven when "Clear from every list" (allLists) is on. The
 * scope that removes the post from the CURRENT view (page's own list / NI) DETACHES
 * the article, so it runs LAST — cross-list clicks must act on a still-mounted
 * article. The live article is re-resolved EACH iteration (a prior scope's clear can
 * re-render the action bar in place; a stale reference could false-negative a real
 * membership). Shared by the live handler and the auto-scroll drain.
 */
export async function clearMountedTweet(
  deps: Pick<HandlerDeps, 'document' | 'location' | 'clearScope' | 'clearLog'>,
  tweetId: string,
  scopes: ReadonlyArray<ClearScope>,
  allLists: boolean,
): Promise<ClearResult[]> {
  const onScope = clearableScope(deps.location.pathname, deps.document)
  const ordered = [...scopes.filter((s) => s !== onScope), ...scopes.filter((s) => s === onScope)]
  const results: ClearResult[] = []
  // oxlint-disable no-await-in-loop -- pace clicks one scope at a time
  for (const scope of ordered) {
    const live = findArticle(deps.document, tweetId)
    const member =
      scope === 'notInterested' || Option.isNone(live) ? false : isMember(live.value, scope)
    if (shouldClickScope({ scope, onScope, member, allLists })) {
      results.push({ scope, ok: await deps.clearScope(tweetId, scope) })
    } else {
      if (import.meta.env.DEV)
        deps.clearLog(
          scope,
          '→ skipped',
          allLists ? '(not a member / off-feed)' : '(not this page)',
        )
      results.push({ scope, ok: true, noop: true })
    }
  }
  // oxlint-enable no-await-in-loop
  return results
}

export const handleClearTweet: MessageHandler = (message, deps, sendResponse) => {
  // X-only: findArticle/clearMountedTweet drive X's bookmark/like/notInterested
  // DOM controls — nothing to click on an Instagram/Threads tab. Keep the channel
  // open (return true) and reply with empty results, same shape as the "queued
  // for scroll-drain" no-op below.
  if (deps.adapter.platform !== 'x') {
    sendResponse({
      _tag: 'ClearTweetResponse',
      mounted: false,
      drainEligible: false,
      results: [],
    })
    return true
  }
  const req = message as { tweetId: string; scopes: ClearScope[]; allLists?: boolean }
  const allLists = req.allLists === true
  const onList = pageScope(deps.location.pathname)
  const membershipScopes = req.scopes.filter((scope) => scope !== 'notInterested')
  const drainEligible =
    Option.isSome(onList) &&
    membershipScopes.length > 0 &&
    (allLists || membershipScopes.includes(onList.value))
  if (import.meta.env.DEV)
    deps.clearLog('request', req.tweetId, req.scopes, allLists ? '· all-lists' : '')
  void (async () => {
    const article = findArticle(deps.document, req.tweetId)
    if (Option.isNone(article)) {
      if (import.meta.env.DEV) {
        const n = deps.document.querySelectorAll('article[data-testid="tweet"]').length
        deps.clearLog('not mounted.', n, 'articles on page')
      }
      sendResponse({
        _tag: 'ClearTweetResponse',
        mounted: false,
        drainEligible,
        results: [],
      })
      return
    }
    let results: ReadonlyArray<ClearResult>
    try {
      results = await clearMountedTweet(deps, req.tweetId, req.scopes, allLists)
    } catch {
      results = req.scopes.map((scope) => ({ scope, ok: false }))
    }
    sendResponse({
      _tag: 'ClearTweetResponse',
      mounted: true,
      drainEligible,
      results,
    })
  })()
  return true
}

export const handleClearDrain: MessageHandler = (message, deps, sendResponse) => {
  const req = message as { tweetId: string; scopes: ClearScope[]; allLists?: boolean }
  if (deps.adapter.platform !== 'x') {
    sendResponse({
      _tag: 'ClearDrainResponse',
      results: req.scopes.map((scope) => ({ scope, ok: false })),
    })
    return true
  }
  void (async () => {
    let results: ReadonlyArray<ClearResult>
    try {
      results = await deps.runDrain(req.tweetId, req.scopes, req.allLists === true)
    } catch {
      results = req.scopes.map((scope) => ({ scope, ok: false }))
    }
    sendResponse({ _tag: 'ClearDrainResponse', results })
  })()
  return true
}

// Popup "Clear detected media": drop every detected pick + disarm all
// affordances, optionally rescanning the visible page in place.
//
// Deliberately NOT platform-gated (unlike its four clear-family siblings above):
// every line here is adapter-agnostic UI-state reset (store.clear(), dwell/cursor/
// grab/badge/launcher) with no X-specific DOM read. The one branch that touches the
// page, `rescanVisible`, calls `deps.adapter.detectRenderedMedia` — already correctly
// dispatched per-platform (every registered adapter implements it; Instagram/Threads
// currently return `[]`, a separate and intentional TODO, not a gating concern here).
// Gating this handler would silently break "Clear detected media" for Instagram/
// Threads users, who have nothing X-specific to protect against in the first place.
//
// TODO: currently unreachable from the UI — its only sender was dropped by the
// in-flight popup rewrite; kept wired pending that rewrite settling.
export const handleClearDetectedMedia: MessageHandler = (message, deps, sendResponse) => {
  const cleared = deps.store.count
  deps.store.clear()
  deps.clearDwell()
  deps.setCursorActive(false)
  deps.resetGrab()
  deps.resetBadge()
  deps.clearLauncherRevert()
  deps.clearRescanSpin()
  deps.setLauncher('idle')
  let rescanned = 0
  const req = message as { _tag: string; rescanVisible?: boolean }
  if (req.rescanVisible) {
    rescanned = deps.store.addDetected(
      deps.adapter.detectRenderedMedia(deps.document, deps.location.pathname),
    ).length
    deps.recoverMissingVideos()
  }
  deps.rerender()
  sendResponse({ _tag: 'ClearDetectedMediaResponse', cleared, rescanned })
}

/** Maps each runtime-message `_tag` to its handler. The router in index.tsx
 *  reads `dispatch[tag]?.(message, deps, sendResponse)`; an unmapped tag (no
 *  entry) falls through to the same `undefined`/`return false` path as before. */
export const messageHandlers: Record<string, MessageHandler> = {
  TransferOutcome: handleTransferOutcome,
  SavedStatusUpdate: handleSavedStatusUpdate,
  RefreshMediaUrlRequest: handleRefreshMediaUrl,
  ClearVisibleRequest: handleClearVisible,
  ClearWholeListRequest: handleClearWholeList,
  DrainPageRequest: handleDrainPage,
  SweepPageRequest: handleSweepPage,
  ClearTweetRequest: handleClearTweet,
  ClearDrainRequest: handleClearDrain,
  ClearDetectedMediaRequest: handleClearDetectedMedia,
}

/** The overlay's TRUE inbound set, decode-gated before any dispatch: the
 *  tab-targeted (`browser.tabs.sendMessage`) tags — spread from the SAME
 *  `TAB_MESSAGE_MEMBERS` array `TabMessage` itself is built from, so the two
 *  unions can never drift — plus the three broadcast `Message`-union tags
 *  `messageHandlers` above also answers (`TransferOutcome`, `SavedStatusUpdate`,
 *  `ClearDetectedMediaRequest`) — NOT the full `Message` union, most of which
 *  the overlay never receives. */
const OverlayInboundMessage = Schema.Union([
  ...TAB_MESSAGE_MEMBERS,
  TransferOutcome,
  SavedStatusUpdate,
  ClearDetectedMediaRequest,
])

/** The overlay's single `runtime.onMessage` entry point: decode-gate, then table
 *  dispatch. A message whose tag/shape falls outside the inventoried set above is
 *  DROPPED before it ever reaches a handler — the same "no entry" no-op the table
 *  already gives an unmapped tag, so a forged or garbled message degrades exactly
 *  like an unknown one, never a thrown decode error. */
export const dispatchOverlayMessage: MessageHandler = (message, deps, sendResponse) => {
  const decoded = Schema.decodeUnknownResult(OverlayInboundMessage)(message)
  if (Result.isFailure(decoded)) {
    // Warn UNCONDITIONALLY (not DEV-gated), mirroring background.ts's decode
    // gate: a silently-dropped message is exactly the signature two shipped
    // incidents had — diagnosed only live in a browser console.
    const rawTag = (message as { _tag?: unknown } | null)?._tag
    if (typeof rawTag === 'string')
      console.warn(
        `[XMD] message ${rawTag} FAILED overlay schema decode (dropped):`,
        decoded.failure,
      )
    // `undefined` ≡ `false` to the WebExtension onMessage API (channel not kept
    // open) — the same drop background.ts spells as an explicit `return false`.
    return
  }
  const handler = messageHandlers[decoded.success._tag]
  if (handler === undefined) return
  return handler(decoded.success, deps, sendResponse)
}
