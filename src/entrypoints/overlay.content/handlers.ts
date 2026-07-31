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
import { resolveOutcome, type BadgeState } from '@/packages/overlay/badge'
import { resolveOutcomeAll, type LauncherPhase } from '@/packages/overlay/launcher'
import type { PlatformAdapter } from '../../core/adapters/types'
import type { HoverMediaElement } from '../../core/adapters/hover-resolve'
import { safeSend } from '@/packages/kernel/messaging'
import { findFreshMediaItem } from '@/packages/download/media-url-refresh'
import { makeListClear } from '@/packages/clear/list-clear'
import type { ClearScopeResult } from '@/packages/clear/result'
import {
  TWEET_ARTICLE_SEL,
  actionTestids,
  classifyFlip,
  clearControl,
  clearableScope,
  type ClearOrigin,
  findArticle,
  flipConfirmed,
  isMember,
  pageScope,
  shouldClickScope,
  tweetIdOfArticle,
  type MembershipScope,
} from '@/packages/clear/clearer'
import type { makeDetectionStore } from '../../core/adapters/detection-store'
import type { ClearScope, MediaItem } from '@/packages/schema'
import {
  TAB_MESSAGE_MEMBERS,
  TransferOutcome,
  SavedStatusUpdate,
  ClearDetectedMediaRequest,
} from '@/packages/schema'

type DetectionStore = ReturnType<typeof makeDetectionStore>

/**
 * ONE Release run — minted only by `handleDrainPage`, which writes the run's
 * `clear-download-page-start` and hands the value to `sendTracked`, the only other
 * place allowed to write a line for it. It replaces the old gate on
 * `pageScope(location.pathname)`, which was never evidence that a Release run was in
 * flight: with the page URL as the only test, ONE hover grab on /i/bookmarks wrote a
 * `clear-download-page-end scope=bookmark items=1 …` — indistinguishable from a real
 * Release terminal — into the durable diagnostics log, and no drain off a list page
 * ever got a terminal at all.
 */
export interface ReleaseRun {
  /** The page's list scope, or `null` off a Likes/Bookmarks list. The drain still
   *  enqueues there (the background's dispatch escalates to a permalink release tab),
   *  so the run is real — it just has no list of its own to release from, and
   *  terminates as a skip. */
  readonly scope: MembershipScope | null
  /** Items handed to the queue: the detection-store size at press time. */
  readonly items: number
  /** Joins this run's start to its one terminal in the export (`releaseRunDetail`). */
  readonly run: string
}

/** What one tracked send actually DID, as opposed to what was asked of it. */
export interface TrackedSendResult {
  /** Every request the background accepted started (`completed === total`). */
  readonly ok: boolean
  /** Items the background scheduled work for. NOT derivable from `ok`: a fully
   *  deduped batch answers `completed:0 total:0`, i.e. `ok === true`, having
   *  scheduled nothing — which is how the popup came to say "Downloading 7 items"
   *  over a background `request-deduped 0 admitted, 7 skipped`. */
  readonly admitted: number
  /** Items the admission gate dropped (dedup / type / size / daily budget). */
  readonly skipped: number
}

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
  /** Hand items to the download queue. ONLY the drain passes `release`, and that
   *  argument is the SOLE authority to write a `clear-download-page-*` terminal —
   *  no other affordance can forge one (see {@link ReleaseRun}). */
  readonly sendTracked: (
    items: ReadonlyArray<MediaItem>,
    release?: ReleaseRun,
  ) => Promise<TrackedSendResult>
  readonly recoverMissingVideos: () => void
  readonly notifyContextLost: () => void
  readonly clearLog: (...args: unknown[]) => void
  /** PRODUCTION-visible trace sink: a `DownloadTraceEvent {source:'clear', stage, t,
   *  itemId?, detail}` runtime message to the background (SW console + session ring),
   *  unlike `clearLog`, which is DEV-only and goes to the page console. */
  readonly reportClear: (stage: string, detail: string, tweetId?: string) => void
  readonly clearScope: (tweetId: string, scope: ClearScope, origin: ClearOrigin) => Promise<boolean>
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

/** Monotonic Release run id, per content-script instance. Per-tab is enough to
 *  identify a run in the export: the background stamps `tabId` on every trace entry
 *  it ingests from a content script (schema `traceFields.tabId`), so two tabs' `run=1`
 *  stay distinguishable in the same interleaved timeline. */
let drainRuns = 0
const nextDrainRun = (): string => String(++drainRuns)

/** The head every `clear-download-page-*` line shares. The `run=` token is the join
 *  key: the export (`composeDiagnosticsExport`) is a flat JSONL timeline of two
 *  producers, so without it a start and its terminal can only be paired by guessing
 *  from adjacency — which is exactly what failed when a hover grab injected a
 *  terminal in between. */
export const releaseRunDetail = (r: ReleaseRun): string =>
  `scope=${r.scope ?? 'none'} run=${r.run} items=${r.items}`

/**
 * The ONE terminal stage that closes a drain's start. `-skip` mirrors
 * `clear-visible-skip` (and `clear-list-skip`): the run reached its end with no list
 * to release from, which is not a failure — the downloads still went out.
 *
 * `ok` is tested FIRST, so a skip is only ever a run that both SUCCEEDED and had no
 * list. Scope-first was wrong for the same reason `sendTracked`'s dead-channel arm
 * writes `-failed` off a list page: the run DID start, and a queue that answers
 * `completed=3 total=7` is a real failure whatever page it ran on. Reported as `-skip`
 * it was invisible to a diagnostician grepping the log for failure stages.
 */
export const releaseTerminalStage = (scope: MembershipScope | null, ok: boolean): string =>
  !ok
    ? 'clear-download-page-failed'
    : scope === null
      ? 'clear-download-page-skip'
      : 'clear-download-page-end'

const compactReason = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : String(error)
  const compact = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return compact || 'unknown'
}

const scopesDetail = (scopes: ReadonlyArray<string>): string => scopes.join(',') || 'none'

const clearResultsDetail = (results: ReadonlyArray<ClearResult>): string =>
  results.map((r) => `${r.scope}:${r.noop === true ? 'noop' : r.ok ? 'ok' : 'failed'}`).join(',') ||
  'none'

const sweepItemCount = (
  posts: ReadonlyArray<{ readonly items: ReadonlyArray<MediaItem> }>,
): number => posts.reduce((sum, post) => sum + post.items.length, 0)

const sweepCandidatesDetail = (
  scope: MembershipScope,
  posts: ReadonlyArray<{ readonly tweetId: string; readonly items: ReadonlyArray<MediaItem> }>,
): string =>
  `scope=${scope} tweets=${posts.length} items=${sweepItemCount(posts)} tweetIds=${
    posts.map((post) => post.tweetId).join(',') || 'none'
  }`

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
 *  clicked. Shared by the one-shot visible clear and the whole-list scroll sweep —
 *  the manual, unledgered click path (spec #59 H5), so `origin=manual` on every
 *  trace line below.
 *
 *  Unlike settle/drain's `tweet-clear.ts`, this loop does NOT poll — "Release the
 *  whole list…" is already the extension's slowest bulk action, and a per-click
 *  poll (up to 1.2s) would make it materially slower. Instead it takes exactly ONE
 *  read at the pace boundary it already waits for (`paceMs`, unchanged), reusing
 *  the SAME `classifyFlip`/`flipConfirmed` vocabulary settle/drain's polled confirm
 *  uses so a `clear-flip`/`clear-attempt-fail` line from `origin=manual` reads
 *  exactly like one from `origin=settle`|`drain` — just with `attempt=1` (an honest
 *  count: only one look was taken, never a claim of six). */
export async function clearMountedForScope(
  document: Document,
  scope: MembershipScope,
  paceMs: number,
  trace: (stage: string, detail: string, tweetId?: string) => void,
): Promise<number> {
  let cleared = 0
  // oxlint-disable no-await-in-loop -- paced one-at-a-time bulk clear
  for (const article of document.querySelectorAll(TWEET_ARTICLE_SEL)) {
    const ctrl = clearControl(article, scope)
    if (ctrl === null) continue
    const button = ctrl.closest('button,[role="button"]') as HTMLElement | null
    const target = button ?? ctrl
    const targetKind = button === null ? 'testid-node' : 'button'
    const disabled =
      target.hasAttribute('disabled') || target.getAttribute('aria-disabled') === 'true'
    // Resolved BEFORE the click, same as tweet-clear.ts's pre-click snapshot — the
    // node the trace line is ABOUT, not whatever `document` shows a tick later.
    const tweetId = Option.getOrNull(tweetIdOfArticle(article))
    target.click()
    cleared++
    await new Promise((r) => setTimeout(r, paceMs))
    // No resolvable id (should not happen — TWEET_ARTICLE_SEL articles always carry a
    // permalink) ⇒ nothing to tag the trace line with; still counts as clicked.
    if (tweetId === null) continue
    if (flipConfirmed(article, scope)) {
      const { arm, reresolved } = classifyFlip(document, article, tweetId, scope)
      const detail = `scope=${scope} arm=${arm} attempt=1 elapsedMs=${paceMs} target=${targetKind} disabled=${disabled} reresolved=${reresolved} origin=manual`
      trace('clear-flip', detail, tweetId)
      // Same "distinct, loud" event `tweet-clear.ts`'s `traceFlip` emits — a detach
      // arm whose fresh re-resolve still shows the post a member is the fabricated-
      // flip smoking gun regardless of which origin produced it.
      if (arm === 'detached' && reresolved === 'member')
        trace('clear-flip-fabricated', detail, tweetId)
    } else {
      trace(
        'clear-attempt-fail',
        `scope=${scope} reason=no-flip attempts=1 elapsedMs=${paceMs} target=${targetKind} disabled=${disabled} testids=${actionTestids(article).join(',')} origin=manual`,
        tweetId,
      )
    }
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
  // Carries `reason` for the same motive as the not-list-page refusal below, and
  // spells it the same way `ClearWholeListResponse` does: the popup renders the
  // Release cluster only on an X tab, so this arm is defence in depth, not copy.
  if (deps.adapter.platform !== 'x') {
    sendResponse({ _tag: 'ClearVisibleResponse', cleared: 0, reason: 'not-x' })
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
  // A skip is a TERMINAL stage (mirrors list-clear's `clear-list-skip`) — emitting
  // `-start` for a run that never begins would leave a dangling start in the trace.
  if (Option.isSome(scope)) deps.reportClear('clear-visible-start', scope.value)
  else deps.reportClear('clear-visible-skip', 'not a Likes/Bookmarks list')
  void (async () => {
    if (Option.isNone(scope)) {
      // A refusal must be MACHINE-READABLE, not a bare count. This handler's only
      // user-visible surface is `releasedPageResult`, and off a list page that
      // control is the ONLY thing in the popup's Release disclosure (spec §2.2) —
      // so a count-only reply makes a permanently dead trigger report "Released 0
      // posts on this page." Same discriminator `handleClearWholeList` already
      // sends, so both Release rows fail through one copy branch.
      sendResponse({ _tag: 'ClearVisibleResponse', cleared: 0, reason: 'not-list-page' })
      return
    }
    const cleared = await clearMountedForScope(deps.document, scope.value, 350, deps.reportClear)
    if (import.meta.env.DEV) deps.clearLog('clear-visible done · cleared', cleared, scope.value)
    deps.reportClear('clear-visible-end', `cleared ${cleared} ${scope.value}`)
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
  // The scope the USER pressed the button on. `makeListClear` pins the same value
  // (its `path()` is this same live pathname, read in the same tick), and every pass
  // below re-checks against it — see `clearVisibleForPage`.
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
    // Re-derive the page scope on EVERY pass rather than closing over the
    // request-time `scope.value`. A whole-list run is minutes long, and a closed-over
    // scope kept clicking `unlike` controls after a Likes→Bookmarks navigation — the
    // clicks landed on whatever the NEW list had mounted. `makeListClear` aborts on
    // the same comparison at the top of each pass; this is the CLICK site's own gate,
    // so no refactor of that loop can ever hand a stale scope to a click.
    clearVisibleForPage: async () => {
      const live = pageScope(deps.location.pathname)
      if (Option.isNone(live) || live.value !== scope.value) return 0
      return clearMountedForScope(deps.document, live.value, 350, deps.reportClear)
    },
    report: (stage, detail) => deps.reportClear(stage, detail),
  })
  void (async () => {
    // `result.reason` ('scope-changed') rides the response so the popup reports an
    // aborted run as aborted instead of presenting its partial count as a done list.
    const result = await listClear.run()
    sendResponse({ _tag: 'ClearWholeListResponse', ...result })
  })()
  return true
}

// "Release this page" (popup): hand every detected item to the download queue;
// clear-on-save then un-likes/un-bookmarks each post (list-scoped) as its
// media truly completes — the list self-empties. Scroll + repeat for more.
//
// The drain is the ONLY producer of `clear-download-page-*`. It mints the run, writes
// the start, and hands the run to `sendTracked`, which writes exactly one terminal for
// it. Off a list page the start is terminated by `-skip`, not left dangling: the
// downloads still go out, this page just owns no list to release from.
//
// The reply is TERMINAL — it lands only once the send settles, carrying what the
// background actually accepted (`admitted`), never the raw detection-store size. The
// old immediate `{ count }` was measured BEFORE any work happened, which is how the
// popup reported "Downloading 7 items — each post releases as it finishes." over a
// background `request-deduped 0 admitted, 7 skipped`.
//
// `onList` rides along for the same honesty reason. The scope decides the terminal
// stage here, but until it also reached the popup the SAME "each post releases as it
// finishes" sentence rendered on a profile or search page — where this handler has
// already resolved `scope` to null and chosen `clear-download-page-skip`, i.e. already
// decided nothing can be released. The popup's own release gate (`willClear`) is the
// SETTING; this is the page, and a release needs both.
export const handleDrainPage: MessageHandler = (_message, deps, sendResponse) => {
  const items = deps.store.values()
  const scope = Option.getOrNull(pageScope(deps.location.pathname))
  const release: ReleaseRun = { scope, items: items.length, run: nextDrainRun() }
  if (import.meta.env.DEV)
    deps.clearLog('drain-page · downloading', items.length, 'items · scope', scope)
  deps.reportClear('clear-download-page-start', releaseRunDetail(release))
  void deps
    .sendTracked(items, release)
    .then((result) => {
      sendResponse({
        _tag: 'DrainPageResponse',
        count: items.length,
        admitted: result.admitted,
        skipped: result.skipped,
        ok: result.ok,
        onList: scope !== null,
      })
      return undefined
    })
    .catch((error: unknown) => {
      // Unreachable through the real `sendTracked` (it rides `safeSend`, which never
      // rejects — packages/kernel/messaging.ts:40-49). Kept because the reply is now
      // what un-busies the popup button: a thrown send must still terminate BOTH the
      // trace and the message channel, or the run has no terminal and the button
      // spins forever.
      deps.reportClear(
        'clear-download-page-failed',
        `${releaseRunDetail(release)} reason=${compactReason(error)}`,
      )
      sendResponse({
        _tag: 'DrainPageResponse',
        count: items.length,
        admitted: 0,
        skipped: 0,
        ok: false,
        onList: scope !== null,
      })
    })
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
  const scopeDetail = Option.getOrElse(scope, () => 'none')
  deps.reportClear('clear-sweep-request', `scope=${scopeDetail}`)
  if (import.meta.env.DEV)
    deps.clearLog(
      'sweep request · page scope =',
      Option.getOrElse(scope, () => '(not a Likes/Bookmarks page)'),
    )
  if (Option.isNone(scope)) {
    deps.reportClear('clear-sweep-failed', 'scope=none reason=not-list-page')
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
  const itemCount = sweepItemCount(posts)
  deps.reportClear('clear-sweep-candidates', sweepCandidatesDetail(scope.value, posts))
  if (import.meta.env.DEV)
    deps.clearLog('sweep · handing', posts.length, 'posts to background on', scope.value)
  void (async () => {
    const out = await safeSend(() =>
      browser.runtime.sendMessage({ _tag: 'SweepEnqueueRequest', scope: scope.value, posts }),
    )
    if (out.status === 'context-invalidated') {
      deps.notifyContextLost()
      deps.reportClear(
        'clear-sweep-failed',
        `scope=${scope.value} reason=context candidates=${posts.length} items=${itemCount}`,
      )
      sendResponse({
        _tag: 'SweepPageResponse',
        ok: false,
        queued: 0,
        skipped: 0,
        reason: 'context',
      })
      return
    }
    if (out.status === 'error') {
      deps.reportClear(
        'clear-sweep-failed',
        `scope=${scope.value} reason=${compactReason(out.error)} candidates=${posts.length} items=${itemCount}`,
      )
      sendResponse({
        _tag: 'SweepPageResponse',
        ok: false,
        queued: 0,
        skipped: 0,
      })
      return
    }
    // A well-formed reply always carries a numeric `queued`. The background router
    // turns any throw inside `handleSweepEnqueue` into `{ ok: false, error: … }`,
    // which `?? 0` would launder into an honest-looking empty sweep: the durable
    // log would assert `ok=true queued=0` for a run that enqueued nothing because
    // the SW crashed, and the popup would blame the list ("No new media detected")
    // for an extension failure. Gate on the field's PRESENCE, never on its value —
    // a genuine zero-queued sweep is a real reply and must stay distinguishable.
    const r = out.reply as { queued?: number; skipped?: number } | undefined
    if (r?.queued === undefined) {
      deps.reportClear(
        'clear-sweep-failed',
        `scope=${scope.value} reason=malformed-reply candidates=${posts.length} items=${itemCount}`,
      )
      sendResponse({
        _tag: 'SweepPageResponse',
        ok: false,
        queued: 0,
        skipped: 0,
        reason: 'malformed-reply',
      })
      return
    }
    const queued = r.queued
    const skipped = r.skipped ?? 0
    deps.reportClear(
      'clear-sweep-response',
      `scope=${scope.value} ok=true queued=${queued} skipped=${skipped}`,
    )
    sendResponse({
      _tag: 'SweepPageResponse',
      ok: true,
      queued,
      skipped,
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
 *
 * `asPageScope` is the background's permalink-release fallback: a `/i/web/status/{id}`
 * page owns NO list scope, so a page-scoped clear there has nothing to be scoped to and
 * membership gating would clear EVERY list the post is in. It is honoured only where the
 * page has no scope of its OWN — a real Likes/Bookmarks tab always wins, so a supplied
 * scope can never widen that page past its one-mutation-per-page rule.
 */
export async function clearMountedTweet(
  deps: Pick<HandlerDeps, 'document' | 'location' | 'clearScope' | 'clearLog'>,
  tweetId: string,
  scopes: ReadonlyArray<ClearScope>,
  allLists: boolean,
  /** WHICH call path fired this clear — threaded straight through to `clearScope`
   *  so the diagnostics log's `clear-flip`/`clear-attempt-fail`/`clear-already-cleared`
   *  lines carry it (see `ClearOrigin`). */
  origin: ClearOrigin,
  asPageScope?: MembershipScope,
): Promise<ClearResult[]> {
  const onScope = clearableScope(deps.location.pathname, deps.document) ?? asPageScope ?? null
  const ordered = [...scopes.filter((s) => s !== onScope), ...scopes.filter((s) => s === onScope)]
  const results: ClearResult[] = []
  // oxlint-disable no-await-in-loop -- pace clicks one scope at a time
  for (const scope of ordered) {
    const live = findArticle(deps.document, tweetId)
    const member =
      scope === 'notInterested' || Option.isNone(live) ? false : isMember(live.value, scope)
    if (shouldClickScope({ scope, onScope, member, allLists })) {
      results.push({ scope, ok: await deps.clearScope(tweetId, scope, origin) })
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
  const req = message as {
    tweetId: string
    scopes: ClearScope[]
    allLists?: boolean
    asPageScope?: MembershipScope
  }
  const allLists = req.allLists === true
  const onList = pageScope(deps.location.pathname)
  const pageScopeDetail = Option.getOrElse(onList, () => 'none')
  const membershipScopes = req.scopes.filter((scope) => scope !== 'notInterested')
  // drainEligible stays keyed off THIS page's own scope: a supplied `asPageScope` names
  // the page the request came FROM, and a permalink page can never auto-scroll a list.
  const drainEligible =
    Option.isSome(onList) &&
    membershipScopes.length > 0 &&
    (allLists || membershipScopes.includes(onList.value))
  deps.reportClear(
    'clear-tweet-request',
    `pageScope=${pageScopeDetail} scopes=${scopesDetail(req.scopes)} allLists=${allLists} drainEligible=${drainEligible}` +
      // Appended only when present (like `clearErrors=` on clear-dispatch) so every
      // ordinary in-page clear keeps the exact detail string it has today.
      (req.asPageScope === undefined ? '' : ` asPageScope=${req.asPageScope}`),
    req.tweetId,
  )
  if (import.meta.env.DEV)
    deps.clearLog('request', req.tweetId, req.scopes, allLists ? '· all-lists' : '')
  void (async () => {
    const article = findArticle(deps.document, req.tweetId)
    if (Option.isNone(article)) {
      const n = deps.document.querySelectorAll('article[data-testid="tweet"]').length
      if (import.meta.env.DEV) deps.clearLog('not mounted.', n, 'articles on page')
      deps.reportClear(
        'clear-tweet-not-mounted',
        `pageScope=${pageScopeDetail} articles=${n} drainEligible=${drainEligible}`,
        req.tweetId,
      )
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
      results = await clearMountedTweet(
        deps,
        req.tweetId,
        req.scopes,
        allLists,
        'settle',
        req.asPageScope,
      )
    } catch (error) {
      results = req.scopes.map((scope) => ({ scope, ok: false }))
      deps.reportClear(
        'clear-tweet-failed',
        `pageScope=${pageScopeDetail} mounted=true drainEligible=${drainEligible} reason=${compactReason(
          error,
        )} results=${clearResultsDetail(results)}`,
        req.tweetId,
      )
      sendResponse({
        _tag: 'ClearTweetResponse',
        mounted: true,
        drainEligible,
        results,
      })
      return
    }
    const pageScopeFailed =
      Option.isSome(onList) && results.some((r) => r.scope === onList.value && r.ok === false)
    const otherMembershipScopeRan =
      Option.isSome(onList) &&
      results.some(
        (r) => r.scope !== onList.value && r.scope !== 'notInterested' && r.noop !== true,
      )
    const needsRemountDrain =
      allLists &&
      drainEligible &&
      pageScopeFailed &&
      otherMembershipScopeRan &&
      Option.isNone(findArticle(deps.document, req.tweetId))
    if (needsRemountDrain) {
      deps.reportClear('clear-tweet-remount-needed', `pageScope=${pageScopeDetail}`, req.tweetId)
      sendResponse({
        _tag: 'ClearTweetResponse',
        mounted: false,
        drainEligible,
        results,
      })
      return
    }
    deps.reportClear(
      'clear-tweet-result',
      `pageScope=${pageScopeDetail} mounted=true drainEligible=${drainEligible} results=${clearResultsDetail(results)}`,
      req.tweetId,
    )
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
