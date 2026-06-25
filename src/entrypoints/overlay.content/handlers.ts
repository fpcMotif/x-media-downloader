// Runtime-message handlers for the overlay content script, lifted out of the
// 226-line `handleRuntimeMessage` router in index.tsx. Pure relocation: each
// handler is a named function taking an explicit `HandlerDeps` context that
// threads main()'s closed-over mutable state as LIVE references (getters/setters
// + sibling helpers), never value copies — so the badge/launcher correction in
// `handleTransferOutcome` and the `store.clear()` reset in
// `handleClearDetectedMedia` still read AND write the same live state they did
// when inlined. The dispatch table at the bottom maps each message `_tag` to its
// handler; the router in index.tsx collapses to a single table lookup.
import { resolveOutcome, type BadgeState } from '../../core/badge'
import { resolveOutcomeAll, type LauncherPhase } from '../../core/launcher'
import { detectRenderedImageElements } from '../../core/adapters/x'
import { safeSend } from '../../core/messaging'
import { findFreshMediaItem } from '../../core/download/media-url-refresh'
import {
  TWEET_ARTICLE_SEL,
  clearControl,
  clearableScope,
  findArticle,
  isMember,
  pageScope,
  shouldClickScope,
  tweetIdOfArticle,
} from '../../core/clear/clearer'
import type { makeDetectionStore } from '../../core/adapters/x/detection-store'
import type { ClearScope, MediaItem } from '../../core/schema'

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
}

type SendResponse = (r: unknown) => void

/** A handler returns `true` to keep the message channel open for an async reply,
 *  or `false`/`undefined` for the fire-and-forget / unknown-tag paths. */
type MessageHandler = (
  message: unknown,
  deps: HandlerDeps,
  sendResponse: SendResponse,
) => boolean | void

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
  if (fresh?.tweetId !== req.tweetId) fresh = undefined
  if (fresh === undefined && req.index !== undefined && req.type !== undefined) {
    const domItems = detectRenderedImageElements(deps.document, deps.location.pathname)
    if (domItems.length > 0) deps.store.addDetected(domItems)
    fresh = findFreshMediaItem(
      { id: req.itemId, tweetId: req.tweetId, index: req.index, type: req.type },
      [...deps.store.values(), ...domItems],
    )
  }
  sendResponse({ _tag: 'RefreshMediaUrlResponse', ...(fresh ? { url: fresh.url } : {}) })
  return true
}

// Manual "Clear this page now" (popup button): un-bookmark / un-like EVERY
// currently-mounted post for the requested scopes — a one-shot Drain of the
// visible worklist, independent of downloads. Same click path proven to work.
export const handleClearVisible: MessageHandler = (_message, deps, sendResponse) => {
  // List-scoped: only ever clear the list you're ON — Likes page un-likes,
  // Bookmarks page un-bookmarks. Never both at once.
  const scope = pageScope(deps.location.pathname)
  if (import.meta.env.DEV)
    deps.clearLog('clear-visible request · page scope =', scope ?? '(not a Likes/Bookmarks page)')
  void (async () => {
    if (scope === null) {
      sendResponse({ _tag: 'ClearVisibleResponse', cleared: 0 })
      return
    }
    let cleared = 0
    // oxlint-disable no-await-in-loop -- paced one-at-a-time bulk clear
    for (const article of deps.document.querySelectorAll(TWEET_ARTICLE_SEL)) {
      const ctrl = clearControl(article, scope)
      if (ctrl === null) continue
      const target = (ctrl.closest('button,[role="button"]') as HTMLElement | null) ?? ctrl
      target.click()
      cleared++
      await new Promise((r) => setTimeout(r, 350))
    }
    // oxlint-enable no-await-in-loop
    if (import.meta.env.DEV) deps.clearLog('clear-visible done · cleared', cleared, scope)
    sendResponse({ _tag: 'ClearVisibleResponse', cleared })
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
      pageScope(deps.location.pathname),
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
    deps.clearLog('sweep request · page scope =', scope ?? '(not a Likes/Bookmarks page)')
  if (scope === null) {
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
    if (!isMember(article, scope)) continue
    const tweetId = tweetIdOfArticle(article)
    if (tweetId === null || seen.has(tweetId)) continue
    const items = deps.store.valuesForTweet(tweetId)
    if (items.length === 0) continue
    seen.add(tweetId)
    posts.push({ tweetId, items })
  }
  if (import.meta.env.DEV)
    deps.clearLog('sweep · handing', posts.length, 'posts to background on', scope)
  void (async () => {
    const out = await safeSend(() =>
      browser.runtime.sendMessage({ _tag: 'SweepEnqueueRequest', scope, posts }),
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
export const handleClearTweet: MessageHandler = (message, deps, sendResponse) => {
  const req = message as { tweetId: string; scopes: ClearScope[]; allLists?: boolean }
  const allLists = req.allLists === true
  if (import.meta.env.DEV)
    deps.clearLog('request', req.tweetId, req.scopes, allLists ? '· all-lists' : '')
  void (async () => {
    // Not mounted in THIS tab → empty results, so the background defers (and
    // tries another tab) instead of recording a false failure (spec §4.5).
    const article = findArticle(deps.document, req.tweetId)
    if (article === null) {
      if (import.meta.env.DEV) {
        const n = deps.document.querySelectorAll('article[data-testid="tweet"]').length
        deps.clearLog('article not mounted here → defer.', n, 'articles on page')
      }
      sendResponse({ _tag: 'ClearTweetResponse', results: [] })
      return
    }
    // Which scope(s) actually click is `shouldClickScope`'s call: page-scoped by
    // default (only the current page's list / "Not interested" on For You), or
    // membership-driven when "Clear from every list" (allLists) is on — un-bookmark
    // a liked post, un-like a bookmarked one, anywhere. A scope that doesn't fire
    // resolves ok:true + noop:true so the in-memory ledger settles but the durable
    // sweep flag never counts a non-click as a verified clear.
    const onScope = clearableScope(deps.location.pathname, deps.document)
    // The scope that removes the post from the CURRENT view — the page's own list,
    // or "Not interested" on For You — DETACHES the article. Process it LAST so the
    // cross-list clicks act on a still-mounted article; on a detached node a later
    // click would false-confirm (its un-control is already gone) with no real
    // account mutation. Cross-list actions (e.g. un-bookmark while on Likes) don't
    // remove the post from the current page, so they stay mounted for each other.
    const ordered = [
      ...req.scopes.filter((s) => s !== onScope),
      ...req.scopes.filter((s) => s === onScope),
    ]
    const results: { scope: ClearScope; ok: boolean; noop?: boolean }[] = []
    // oxlint-disable no-await-in-loop -- pace clicks one scope at a time
    for (const scope of ordered) {
      // Re-resolve the article EACH iteration (mirroring clearScope's own
      // findArticle-at-click-time discipline) so membership is read off a LIVE
      // node, never the top-of-handler snapshot: a prior scope's clear can
      // re-render the action bar in place, and reading the stale reference could
      // false-negative a real membership and silently drop a clear with no retry
      // (the durable worklist has no re-trigger in v1). Gone now → nothing to do.
      const live = findArticle(deps.document, req.tweetId)
      const member = scope === 'notInterested' || live === null ? false : isMember(live, scope)
      if (shouldClickScope({ scope, onScope, member, allLists })) {
        results.push({ scope, ok: await deps.clearScope(req.tweetId, scope) })
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
    sendResponse({ _tag: 'ClearTweetResponse', results })
  })()
  return true
}

// Popup "Clear detected media": drop every detected pick + disarm all
// affordances, optionally rescanning the visible page in place.
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
      detectRenderedImageElements(deps.document, deps.location.pathname),
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
  RefreshMediaUrlRequest: handleRefreshMediaUrl,
  ClearVisibleRequest: handleClearVisible,
  DrainPageRequest: handleDrainPage,
  SweepPageRequest: handleSweepPage,
  ClearTweetRequest: handleClearTweet,
  ClearDetectedMediaRequest: handleClearDetectedMedia,
}
