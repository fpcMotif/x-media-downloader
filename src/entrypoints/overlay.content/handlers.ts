// Runtime-message handlers for the overlay content script, lifted out of the
// 226-line `handleRuntimeMessage` router in index.tsx. Pure relocation: each
// handler is a named function taking an explicit `HandlerDeps` context that
// threads main()'s closed-over mutable state as LIVE references (getters/setters
// + sibling helpers), never value copies. The dispatch table at the bottom maps
// each message `_tag` to its handler; the router in index.tsx collapses to a
// single table lookup.
import { Option } from 'effect'
import type { PlatformAdapter } from '../../core/adapters/types'
import { TWEET_ARTICLE_SEL } from '../../core/adapters/x/dom'
import { expectReply, safeSend } from '../../core/messaging'
import { findFreshMediaItem } from '../../core/download/media-url-refresh'
import {
  alreadyCleared,
  caretControl,
  clearableScope,
  findArticle,
  isMember,
  shouldClickScope,
  tweetIdOfArticle,
} from '../../core/clear/clearer'
import { pageScope, type MembershipScope } from '../../core/clear/scope'
import type { makeDetectionStore } from '../../core/adapters/detection-store'
import {
  decodeCaptureEpochChanged,
  decodeQueueUpdate as decodeQueueUpdateReply,
  decodeSettingsChanged,
  decodeSweepEnqueueResponse,
  type ClearScope,
  type ClearTweetState,
  type MediaItem,
  type QueueUpdate,
} from '../../core/schema'
import { isFromExtensionWorker, type MessageSenderLike } from '../../core/sender-guard'
import { decodeOverlayInboundMessage, readOverlayInboundTag } from '../../core/schema/tab'
export { decodeSavedStatusResponse } from '../../core/schema/saved-status'
import { partitionSweepPosts, type SweepBatchPost } from './request-batching'
import { markArticleSaved } from './saved-status-marks'
export {
  clearSavedStatusMarks,
  isSavedStatusScope,
  savedStatusVisible,
  sweepSavedStatus,
} from './saved-status-marks'
import type { TrackedStart } from './tracked-download'

type DetectionStore = ReturnType<typeof makeDetectionStore>

/** Decode only the exact QueueUpdate accepted as a start acknowledgement. */
export const decodeQueueUpdate = (
  value: unknown,
  requestedItems: ReadonlyArray<MediaItem>,
): QueueUpdate | undefined => decodeQueueUpdateReply(value, requestedItems)

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
  /** Download UI owns its own state, timers, and terminal-outcome correction. */
  readonly onTransferOutcome: (requestId: string, outcome: 'complete' | 'failed') => boolean
  // Shared side-effecting helpers.
  readonly sendTracked: (items: ReadonlyArray<MediaItem>) => Promise<TrackedStart>
  readonly notifyContextLost: () => void
  readonly clearLog: (...args: unknown[]) => void
  /** One scope's exact irreversible-action result. It distinguishes a harmless
   * preflight miss from a click whose result failed to verify. */
  readonly clearScopeAttempt: (tweetId: string, scope: ClearScope) => Promise<ClearTweetState>
  /** Whether the "Saved" status is live on THIS page right now (setting on AND an
   *  in-scope timeline) — gates the late cross-device chip push. */
  readonly savedStatusActive: () => boolean
}

export interface OverlayMessageAuthority {
  readonly extensionId: string
  readonly popupUrl: string
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
  deps.onTransferOutcome(m.requestId, m.outcome)
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
    if (domItems.length > 0) deps.store.reconcileDetected(domItems)
    fresh = findFreshMediaItem(
      { id: req.itemId, postId: req.tweetId, index: req.index, type: req.type },
      [...deps.store.values(), ...domItems],
    )
  }
  sendResponse({
    _tag: 'RefreshMediaUrlResponse',
    ...(fresh ? { url: fresh.url } : {}),
  })
  return true
}

const isSweepEnqueueUnavailable = (reply: unknown): boolean =>
  typeof reply === 'object' &&
  reply !== null &&
  !Array.isArray(reply) &&
  Object.keys(reply).length === 1 &&
  (reply as { readonly _tag?: unknown })._tag === 'SweepEnqueueUnavailable'

type SweepBatchOutcome =
  | {
      readonly _tag: 'accepted'
      readonly queued: number
      readonly skipped: number
    }
  | { readonly _tag: 'context' }
  | { readonly _tag: 'background' }

const sendSweepBatch = async (
  deps: HandlerDeps,
  scope: MembershipScope,
  posts: ReadonlyArray<SweepBatchPost>,
): Promise<SweepBatchOutcome> => {
  const out = expectReply(
    await safeSend(() =>
      browser.runtime.sendMessage({
        _tag: 'SweepEnqueueRequest',
        scope,
        posts,
      }),
    ),
  )
  if (out.status === 'context-invalidated') {
    deps.notifyContextLost()
    return { _tag: 'context' }
  }
  if (out.status !== 'ok' || isSweepEnqueueUnavailable(out.reply)) return { _tag: 'background' }
  const reply = decodeSweepEnqueueResponse(out.reply, posts.length)
  if (reply === undefined) return { _tag: 'background' }
  return {
    _tag: 'accepted',
    queued: reply.queued,
    skipped: reply.skipped,
  }
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
  void (async () => {
    try {
      const started = await deps.sendTracked(items)
      if (started._tag === 'started') {
        sendResponse({
          _tag: 'DrainPageResponse',
          ok: true,
          count: items.length,
        })
        return
      }
      sendResponse({
        _tag: 'DrainPageResponse',
        ok: false,
        reason: started._tag === 'context' ? 'context' : 'background',
      })
    } catch {
      sendResponse({
        _tag: 'DrainPageResponse',
        ok: false,
        reason: 'background',
      })
    }
  })().catch(() =>
    sendResponse({
      _tag: 'DrainPageResponse',
      ok: false,
      reason: 'background',
    }),
  )
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
  const posts: SweepBatchPost[] = []
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
  const partitioned = partitionSweepPosts(posts)
  if (partitioned._tag === 'failure') {
    sendResponse({
      _tag: 'SweepPageResponse',
      ok: false,
      queued: 0,
      skipped: 0,
      reason: 'local-invalid',
    })
    return true
  }
  if (partitioned.batches.length === 0) {
    sendResponse({
      _tag: 'SweepPageResponse',
      ok: true,
      queued: 0,
      skipped: 0,
    })
    return true
  }
  void (async () => {
    let queued = 0
    let skipped = 0
    try {
      // oxlint-disable no-await-in-loop -- ordered commits preserve the visible worklist.
      for (const batch of partitioned.batches) {
        const outcome = await sendSweepBatch(deps, scope.value, batch)
        if (outcome._tag === 'accepted') {
          queued += outcome.queued
          skipped += outcome.skipped
          continue
        }
        sendResponse({
          _tag: 'SweepPageResponse',
          ok: false,
          queued,
          skipped,
          reason: outcome._tag,
        })
        return
      }
      // oxlint-enable no-await-in-loop
      sendResponse({ _tag: 'SweepPageResponse', ok: true, queued, skipped })
    } catch {
      sendResponse({
        _tag: 'SweepPageResponse',
        ok: false,
        queued,
        skipped,
        reason: 'failed',
      })
    }
  })().catch(() =>
    sendResponse({
      _tag: 'SweepPageResponse',
      ok: false,
      queued: 0,
      skipped: 0,
      reason: 'failed',
    }),
  )
  return true
}

export const handleClearTweet: MessageHandler = (message, deps, sendResponse) => {
  const req = message as {
    tweetId: string
    scopes: ClearScope[]
    allLists: boolean
  }
  // X-only: nothing destructive can run on another adapter. Return one exact,
  // retryable result per requested scope; never fall through to another tab here.
  if (deps.adapter.platform !== 'x') {
    sendResponse({
      _tag: 'ClearTweetResponse',
      results: req.scopes.map((scope) => ({ scope, state: 'not-actionable' })),
    })
    return true
  }
  const allLists = req.allLists
  if (import.meta.env.DEV)
    deps.clearLog('request', req.tweetId, req.scopes, allLists ? '· all-lists' : '')
  void (async () => {
    const results: Array<{ scope: ClearScope; state: ClearTweetState }> = []
    const withFallback = (
      fallback: ClearTweetState,
    ): Array<{ scope: ClearScope; state: ClearTweetState }> =>
      req.scopes.map(
        (scope) =>
          results.find((result) => result.scope === scope) ?? {
            scope,
            state: fallback,
          },
      )
    try {
      const article = findArticle(deps.document, req.tweetId)
      if (Option.isNone(article)) {
        sendResponse({
          _tag: 'ClearTweetResponse',
          results: req.scopes.map((scope) => ({
            scope,
            state: 'preflight-failed',
          })),
        })
        return
      }
      const onScope = clearableScope(deps.location.pathname, deps.document)
      const ordered = [
        ...req.scopes.filter((scope) => scope !== onScope),
        ...req.scopes.filter((scope) => scope === onScope),
      ]
      // oxlint-disable no-await-in-loop -- each later action rechecks the DOM after a prior click
      for (const scope of ordered) {
        const live = findArticle(deps.document, req.tweetId)
        if (Option.isNone(live)) {
          results.push({ scope, state: 'preflight-failed' })
          continue
        }
        const member = scope === 'notInterested' ? false : isMember(live.value, scope)
        if (!shouldClickScope({ scope, onScope, member, allLists })) {
          results.push({
            scope,
            state:
              scope !== 'notInterested' && alreadyCleared(live.value, scope)
                ? 'already-clear'
                : 'not-actionable',
          })
          continue
        }
        let state: ClearTweetState
        try {
          state = await deps.clearScopeAttempt(req.tweetId, scope)
        } catch {
          // The injected attempt owns the click boundary. A rejected call cannot
          // prove it failed before mutation, so automatic retry is unsafe.
          state = 'uncertain'
        }
        results.push({
          scope,
          state,
        })
      }
      // oxlint-enable no-await-in-loop
      sendResponse({ _tag: 'ClearTweetResponse', results })
    } catch {
      sendResponse({
        _tag: 'ClearTweetResponse',
        results: withFallback('preflight-failed'),
      })
    }
  })().catch(() =>
    sendResponse({
      _tag: 'ClearTweetResponse',
      results: req.scopes.map((scope) => ({
        scope,
        state: 'uncertain',
      })),
    }),
  )
  return true
}

/** Locate is read-only: it must never call clearScopeAttempt or queue deferred
 * work. It answers exactly once for every requested scope on a mounted tweet. */
export const handleLocateClearTweet: MessageHandler = (message, deps, sendResponse) => {
  const req = message as {
    tweetId: string
    scopes: ClearScope[]
    allLists: boolean
  }
  if (deps.adapter.platform !== 'x') {
    sendResponse({ _tag: 'LocateClearTweetResponse', mounted: false })
    return true
  }
  const article = findArticle(deps.document, req.tweetId)
  if (Option.isNone(article)) {
    sendResponse({ _tag: 'LocateClearTweetResponse', mounted: false })
    return true
  }
  const onScope = clearableScope(deps.location.pathname, deps.document)
  const allLists = req.allLists
  const results = req.scopes.map((scope) => {
    const member = scope === 'notInterested' ? false : isMember(article.value, scope)
    if (shouldClickScope({ scope, onScope, member, allLists })) {
      if (scope === 'notInterested')
        return {
          scope,
          state: caretControl(article.value) === null ? 'unknown' : 'actionable',
        }
      if (member) return { scope, state: 'actionable' }
      return {
        scope,
        state: alreadyCleared(article.value, scope) ? 'already-clear' : 'unknown',
      }
    }
    return {
      scope,
      state:
        scope !== 'notInterested' && alreadyCleared(article.value, scope)
          ? 'already-clear'
          : 'not-applicable',
    }
  })
  sendResponse({ _tag: 'LocateClearTweetResponse', mounted: true, results })
  return true
}

/** Maps each runtime-message `_tag` to its handler. The router in index.tsx
 *  reads `dispatch[tag]?.(message, deps, sendResponse)`; an unmapped tag (no
 *  entry) falls through to the same `undefined`/`return false` path as before. */
export const messageHandlers: Record<string, MessageHandler> = {
  TransferOutcome: handleTransferOutcome,
  SavedStatusUpdate: handleSavedStatusUpdate,
  RefreshMediaUrlRequest: handleRefreshMediaUrl,
  DrainPageRequest: handleDrainPage,
  SweepPageRequest: handleSweepPage,
  LocateClearTweetRequest: handleLocateClearTweet,
  ClearTweetRequest: handleClearTweet,
}

/** The overlay's single `runtime.onMessage` entry point: decode-gate, then table
 *  dispatch. A message whose tag/shape falls outside the inventoried set above is
 *  DROPPED before it ever reaches a handler — the same "no entry" no-op the table
 *  already gives an unmapped tag, so a forged or garbled message degrades exactly
 *  like an unknown one, never a thrown decode error. */
const POPUP_ACTION_TAGS = new Set(['DrainPageRequest', 'SweepPageRequest'])
const WORKER_ONLY_TAGS = new Set([
  'RefreshMediaUrlRequest',
  'LocateClearTweetRequest',
  'ClearTweetRequest',
  'TransferOutcome',
  'SavedStatusUpdate',
])

export const isPopupActionSender = (
  sender: MessageSenderLike | undefined,
  authority: OverlayMessageAuthority,
): boolean =>
  sender?.id === authority.extensionId &&
  sender.tab === undefined &&
  sender.url === authority.popupUrl

/** Worker-only messages cannot be forged by popup, options, or another tab. */
export const isWorkerMessageSender = (
  sender: MessageSenderLike | undefined,
  authority: OverlayMessageAuthority,
): boolean => isFromExtensionWorker(sender, authority.extensionId)

const unauthorizedReply = (tag: string): unknown => {
  switch (tag) {
    case 'DrainPageRequest':
      return { _tag: 'DrainPageResponse', ok: false, reason: 'unauthorized' }
    case 'SweepPageRequest':
      return {
        _tag: 'SweepPageResponse',
        ok: false,
        queued: 0,
        skipped: 0,
        reason: 'unauthorized',
      }
  }
}

export const dispatchOverlayMessage = (
  message: unknown,
  deps: HandlerDeps,
  sendResponse: SendResponse,
  sender: MessageSenderLike | undefined,
  authority: OverlayMessageAuthority,
): boolean | void => {
  const rawTag = readOverlayInboundTag(message)
  // Dedicated content clients own these worker broadcasts through their own
  // listeners. They are valid tab traffic, not failed overlay messages.
  if (
    isWorkerMessageSender(sender, authority) &&
    ((rawTag === 'SettingsChanged' && decodeSettingsChanged(message) !== undefined) ||
      (rawTag === 'CaptureEpochChanged' && decodeCaptureEpochChanged(message) !== undefined))
  )
    return
  const decoded = decodeOverlayInboundMessage(message)
  if (decoded === undefined) {
    // Warn UNCONDITIONALLY (not DEV-gated), mirroring background.ts's decode
    // gate: a silently-dropped message is exactly the signature two shipped
    // incidents had — diagnosed only live in a browser console.
    if (typeof rawTag === 'string')
      console.warn(
        `[XMD] message ${rawTag} FAILED overlay schema decode (dropped):`,
        'invalid payload',
      )
    // `undefined` ≡ `false` to the WebExtension onMessage API (channel not kept
    // open) — the same drop background.ts spells as an explicit `return false`.
    return
  }
  if (POPUP_ACTION_TAGS.has(decoded._tag) && !isPopupActionSender(sender, authority)) {
    sendResponse(unauthorizedReply(decoded._tag))
    return true
  }
  if (WORKER_ONLY_TAGS.has(decoded._tag) && !isWorkerMessageSender(sender, authority)) return
  const handler = messageHandlers[decoded._tag]
  if (handler === undefined) return
  return handler(decoded, deps, sendResponse)
}
