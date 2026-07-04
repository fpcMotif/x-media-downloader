import { Effect, Option, Result, Schema } from 'effect'
import { storage } from 'wxt/utils/storage'
import {
  Message,
  type DownloadTraceEntry,
  type MediaItem,
  type MetricsSnapshot,
  type Settings,
} from '../core/schema'
import {
  SettingsService,
  SettingsServiceLive,
  getSettings,
  setSettings,
  watchSettings,
} from '../core/settings'
import { queuedEvent, outcomeEvent, type SyncEvent } from '../core/sync/events'
import { makeConvexHttpPort, queryDownloadedAmong } from '../core/sync/convex'
import { makeSavedIndex, type QueryConvex } from '../core/sync/saved-index'
import { refreshMediaUrlFromTabs } from '../core/download/media-url-refresh'
import {
  makeDirectStrategy,
  makeSchemeRoutingStrategy,
  type DownloadStrategy,
} from '../core/download/strategy'
import { makeAria2Strategy, makeAria2RpcPort } from '../core/download/aria2'
import { makeFetchServiceLive } from '../core/fetch-service'
import {
  makeFetchedStrategy,
  makeFetchPort,
  makeOffscreenPort,
  makePermissionsPort,
} from '../core/download/fetched-strategy'
import { makeDownloadQueueCore } from '../core/download/queue'
import { makeSerialQueue } from '../core/serial-queue'
import { isMessageAllowed } from '../core/sender-guard'
import { planDownloads } from '../core/download/destination'
import { makeSizeProbe } from '../core/download/size-probe'
import { type BudgetRecord } from '../core/download/daily-budget'
import { type SkipReason } from '../core/download/admission'
import { bindFetch } from '../core/fetch'
import {
  emptyMetrics,
  extendTotal,
  recordOutcome,
  recordRetry,
  recordSample,
  samplesFromSearch,
  snapshot,
  type MetricsState,
} from '../core/download/metrics'
import { planInterruptRetry, type PendingInterruptRetry } from '../core/download/interrupt-retry'
import { syndicationUrl } from '../core/adapters/x/syndication'
import {
  classifyTransfer,
  emptyTracker,
  partitionOwnership,
  planBootReconcile,
  settleTransfer,
  trackTransfer,
  type ReconcileRow,
  type TrackerState,
} from '../core/download/transfer-tracker'
import { decideTerminalOutcome } from '../core/download/terminal-outcome'
import { decodeStore, emptyStore } from '../core/history/store'
import { planHistory, type HistoryAction } from '../core/history/wiring'
import { type Scope } from '../core/clear/ledger'
import type { ClearScope, SweepEnqueueResponse } from '../core/schema'
import { isSyncConfigured } from '../background/sync-config'
import { makeTabBroadcaster } from '../background/tab-broadcaster'
import { makeSyncOutbox } from '../background/sync-outbox'
import { makeCloudUpload } from '../background/cloud-upload'
import { makeSavedStatusCoordinator } from '../background/saved-status'
import { makeAdmissionGate } from '../background/admission-gate'
import { makeDailyBudgetStore } from '../background/daily-budget-store'
import { makeClearCoordinator, hookScopes } from '../background/clear-coordinator'
import { isClearableTweetId } from '../core/clear/clearer'
import { makeCaptureDb } from '../background/capture-db'
import { makeCaptureOutbox } from '../background/capture-outbox'
import {
  emptyCaptureSummary,
  finishCaptureSummary,
  foldCaptureSummary,
  selectConversation,
} from '../core/capture/store'
import { buildTree } from '../core/capture/tree'
import { toJsonl, toMarkdown, toTreeJson } from '../core/capture/export'

// Ephemeral monitoring snapshot — session storage survives SW recycling but not
// a browser restart (ADR-0005). The popup polls it via `MetricsRequest`.
const metricsItem = storage.defineItem<MetricsSnapshot | null>('session:metrics', {
  fallback: null,
})

const ZERO_SNAPSHOT: MetricsSnapshot = {
  total: 0,
  completed: 0,
  failed: 0,
  active: 0,
  retries: 0,
  concurrencyCap: 0,
  bytesReceived: 0,
  bytesTotal: 0,
  throughputBps: 0,
  elapsedMs: 0,
}

const MAX_TRACE_EVENTS = 12

// Live monitoring accumulator. In-SW memory: best-effort and resets on SW
// recycle; the persisted snapshot is the popup's source of truth. Rehydrating
// the full accumulator across a recycle is the remaining work (ADR-0008).
let live: MetricsState | null = null
const requestIdByDownloadId = new Map<number, string>()
const requestStartedAt = new Map<string, number>()
let traceEvents: DownloadTraceEntry[] = []

// In-flight request ids. A duplicate id (Quick Grab + '⬇ tweet' overlapping on
// the same item) would download twice and corrupt the accumulator: extendTotal
// counts both, the idempotent recordOutcome counts one, and `completed` can
// never reach `total`. Duplicates are dropped while the original is in flight.
const inFlight = new Set<string>()

// Browser download metadata for interrupted auto-retry (url/filename + attempt).
interface RequestMeta {
  readonly url: string
  readonly filename: string
  readonly item?: MediaItem
}
const requestMetaById = new Map<string, RequestMeta>()
const interruptAttemptById = new Map<string, number>()
const pendingRetries = new Map<string, PendingInterruptRetry>()
const retryTimeouts = new Map<string, ReturnType<typeof setTimeout>>()

const retryQueueItem = storage.defineItem<ReadonlyArray<PendingInterruptRetry>>(
  'session:interruptRetries',
  { fallback: [] },
)

const syncPendingRetries = (): void => {
  void retryQueueItem.setValue([...pendingRetries.values()])
}

// Durable in-flight browser-transfer ledger (Transfer Tracker). The in-memory
// `requestIdByDownloadId` correlation dies with the SW (ADR-0002); this survives
// the recycle so an outcome that lands while the worker is dead is recovered by
// reconciling against `downloads.search` on restart. Only browser transfers are
// tracked — aria2 hand-offs are terminal at enqueue (ADR-0006) and never enter it.
let transfersState: TrackerState = emptyTracker
const transfersItem = storage.defineItem<TrackerState>('session:transfers', {
  fallback: emptyTracker,
})

// The single X-tab messaging surface (queryXTabs / broadcast / reportTransferOutcome
// / sendClearToTabs). Owns no module state, so it constructs first — every other
// collaborator and the lifecycle below depend on its seams. (Findings [00]/[36].)
const tabBroadcaster = makeTabBroadcaster()
const { reportTransferOutcome, sendClearToTabs } = tabBroadcaster

/** Re-resolve a CDN url from an open X tab before an interrupt retry. */
const resolveRetryUrl = async (meta: RequestMeta): Promise<string> => {
  if (meta.item === undefined) return meta.url
  const fresh = await refreshMediaUrlFromTabs(meta.item, tabBroadcaster.makeTabMessagingPort())
  return fresh ?? meta.url
}

const clearRetryTimeout = (id: string): void => {
  const handle = retryTimeouts.get(id)
  if (handle !== undefined) {
    clearTimeout(handle)
    retryTimeouts.delete(id)
  }
}

const clearInterruptRetryState = (id: string): void => {
  clearRetryTimeout(id)
  pendingRetries.delete(id)
  interruptAttemptById.delete(id)
  requestMetaById.delete(id)
  syncPendingRetries()
}

const withTraceEvents = (snap: MetricsSnapshot): MetricsSnapshot =>
  traceEvents.length === 0 ? snap : { ...snap, events: traceEvents }

const currentSnapshot = (now: number): MetricsSnapshot =>
  withTraceEvents(live ? snapshot(live, now) : ZERO_SNAPSHOT)

const persistSnapshot = (now: number): Promise<void> => metricsItem.setValue(currentSnapshot(now))

function recordTrace(event: DownloadTraceEntry): void {
  traceEvents = [...traceEvents, event].slice(-MAX_TRACE_EVENTS)
  const label = [
    event.stage,
    event.type,
    event.itemId,
    event.elapsedMs === undefined ? null : `${event.elapsedMs}ms`,
    event.detail,
  ]
    .filter(Boolean)
    .join(' ')
  console.info(`[XMD] ${event.source} ${label}`)
}

const traceBackground = (
  stage: string,
  opts: Omit<DownloadTraceEntry, 'source' | 'stage' | 't'> = {},
): void => {
  recordTrace({ source: 'background', stage, t: Date.now(), ...opts })
}

// One observable failure path for the serialized RMW queues below. These chains
// each used to end in `.catch(() => {})`, so a thrown drain (storage quota, a
// decode failure, an unexpected reducer throw) vanished. Now it leaves a trace
// instead. Observe-and-log only — never re-throw, or the chain would wedge.
const queueError =
  (label: string) =>
  (err: unknown): void =>
    traceBackground(`queue:${label}`, { detail: err instanceof Error ? err.message : String(err) })

// Every persist of the in-memory transfer ledger goes through one serialized
// chain. The in-memory compose is already race-free (each mutation is a
// synchronous `transfersState = f(transfersState)`); this only orders the
// DURABLE writes, so a late fire-and-forget persist can no longer land a stale
// snapshot after a newer one and diverge the boot reconcile. Each step reads the
// live var at run time, so the last write always reflects the final state.
const transfersQueue = makeSerialQueue(queueError('transfers'))
const persistTransfers = (): void => {
  transfersQueue.push(() => transfersItem.setValue(transfersState))
}
// Awaitable flush for the two terminal handlers that must observe the settle
// land before their durable sync/history writes (closes the recycle re-fire
// window); ordered on the same chain as the fire-and-forget persists.
const flushTransfers = (): Promise<unknown> =>
  transfersQueue.run(() => transfersItem.setValue(transfersState))

// Cloud Sync outbox (ADR-0009) — metadata-only events drained FIFO; owns its
// own queue + storage. `recordSync` mirrors state transitions (fire-and-forget).
const syncOutbox = makeSyncOutbox({ queueError, fetchImpl: fetch })
const { outboxQueue, recordSync, drainOutbox, runSyncConnectionTest } = syncOutbox

// Cloud upload (ADR-0013): client-side OAuth byte path. Owns its UploadJob ledger
// + queue + the SW-side cloud-settings write chain; bytes go extension → provider
// directly (nothing transits Convex). Backfill reads the durable history store.
const cloudUpload = makeCloudUpload({
  queueError,
  getSettings,
  fetchImpl: fetch,
  getBackfillRecords: async () => decodeStore(await historyItem.getValue()).records,
})
const { uploadQueue, drainUploadJobs, recordCloudUploads } = cloudUpload

// Recover a tweet's media JSON from X's public syndication endpoint — the
// fallback the overlay uses when the passive tee never saw a video (SPA cache
// hit / lazy-loaded reply). The host is fixed and the URL is built from a
// digits-only tweet id (`syndicationUrl` guards it), so there's no SSRF surface:
// nothing here is steered by page-supplied data beyond the validated id. Returns
// the raw JSON body for the content script to parse, or null on any failure.
async function recoverSyndicationBody(tweetId: string): Promise<string | null> {
  const url = syndicationUrl(tweetId)
  if (Option.isNone(url)) return null
  try {
    const res = await fetch(url.value)
    return res.ok ? await res.text() : null
  } catch {
    return null
  }
}
// Durable local download history (opt-in `downloadHistoryEnabled`): the
// local-first twin of Convex `media_state`, fed from the SAME outcome points as
// the Sync Events above so the two never diverge. `local:` survives SW recycle.
const historyItem = storage.defineItem<unknown>('local:downloadHistory', { fallback: null })
const historyQueue = makeSerialQueue(queueError('history'))
// Serialized read-modify-write, like the outbox, so interleaved SW events can't
// lose an update. Gated by the toggle; orthogonal to Cloud Sync.
const recordHistory = (settings: Settings, actions: ReadonlyArray<HistoryAction>): void => {
  if (!settings.downloadHistoryEnabled || actions.length === 0) return
  historyQueue.push(async () => {
    let store = decodeStore(await historyItem.getValue())
    for (const a of actions) store = planHistory(store, settings, a)
    await historyItem.setValue(store)
  })
}

// The tab a tweet's download came from, so its clear is sent THERE first (the
// originating tab where the user is looking) — a background Bookmarks/Likes tab
// can't win the broadcast and un-bookmark a post meant only for its feed's clear.
// In-memory; keyed by tweetId; lost on SW recycle (the clear simply falls back to
// the broadcast then). Set at seed time, read when the clear fires. Entries are
// never individually retired (the clear path has no completion hook back here),
// so the map is capped — oldest-inserted evicted first; an evicted tweet's clear
// degrades to the broadcast, same as after a recycle.
const CLEAR_ORIGIN_TAB_CAP = 512
const clearOriginTab = new Map<string, number>()
const rememberClearOrigin = (tweetId: string, tabId: number): void => {
  clearOriginTab.delete(tweetId) // re-insert to refresh its eviction position
  clearOriginTab.set(tweetId, tabId)
  for (const oldest of clearOriginTab.keys()) {
    if (clearOriginTab.size <= CLEAR_ORIGIN_TAB_CAP) break
    clearOriginTab.delete(oldest)
  }
}

// Clear-on-complete coordinator (worklist un-bookmark/un-like). Owns the in-memory
// clear ledger + its serialized chain AND the durable sweep worklist; routes verified
// flips through the tab broadcaster's sendClearToTabs seam. (Findings [00]/[07]/[36].)
const clearCoordinator = makeClearCoordinator({
  queueError,
  getSettings,
  trace: traceBackground,
  // Prefer the originating tab for this tweet's clear (falls back to broadcast).
  // `allLists` (the "Clear from every list" setting) rides into the request.
  sendClearToTabs: (tweetId, scopes, allLists) =>
    sendClearToTabs(tweetId, scopes, clearOriginTab.get(tweetId), allLists),
  // Settle Port: the real `chrome.downloads.search`. Returns the row (or undefined
  // when it's gone), swallowing a teardown-time throw to undefined — `decideSettle`
  // fails that closed, so the irreversible Clear never fires on an unconfirmed byte.
  settleProbe: (downloadId) =>
    browser.downloads
      .search({ id: downloadId })
      .then((rows) => rows[0])
      .catch(() => undefined),
})
const { recordClearComplete, recordClearFailure } = clearCoordinator

// Cross-device "Saved" status (B+C): the local-first SavedIndex answers overlay
// sweeps. Seeded from the durable history (this device's completed downloads), fed
// every local completion (instant + offline), and unioned with Convex truth for
// other devices. `queryConvex` reads settings each call so toggling sync on/off —
// or pasting a deployment URL — takes effect without a restart; sync-off → C-only.
const savedIndex = makeSavedIndex()
const queryConvexSaved: QueryConvex = async (tweetIds) => {
  const s = await getSettings()
  if (!isSyncConfigured(s)) return []
  const port = makeConvexHttpPort({ deploymentUrl: s.convexUrl })
  // The Convex port reads FetchService from R (ADR-0017); cross the Effect
  // boundary here at the airlock. A tagged error reverts to a rejection, which
  // the saved-index caller already treats as "fall back to the local index".
  return Effect.runPromise(
    queryDownloadedAmong(port, s.convexSyncSecret, tweetIds).pipe(
      Effect.provide(makeFetchServiceLive(fetch)),
    ),
  )
}
const savedStatusCoordinator = makeSavedStatusCoordinator({
  index: savedIndex,
  queryConvex: queryConvexSaved,
  // Late cross-device hits (the sweep replied before the backstop answered):
  // push them to every X tab so the chips land without waiting for a re-sweep.
  notifyFresh: (saved) =>
    void tabBroadcaster.broadcastToXTabs({ _tag: 'SavedStatusUpdate', saved }).catch(() => {}),
})
// Seed once on SW startup from the durable history's completed tweetIds.
void (async () => {
  const { records } = decodeStore(await historyItem.getValue())
  savedIndex.seed(records.filter((r) => r.status === 'completed').map((r) => r.media.tweetId))
})()

// Download Admission Gate: a pre-scheduling check that drops duplicates and
// filtered / over-budget media before planDownloads. Size is HEAD-probed via a
// bound fetch (the MV3 SW rejects an unbound one, see bindFetch). The daily-budget
// tally lives in its own durable key, resets per local calendar day, and is
// accrued on completion through a serial queue so concurrent settles don't race.
const dailyBudgetItem = storage.defineItem<BudgetRecord>('local:daily-budget', {
  fallback: { day: '', bytes: 0, count: 0 },
})
const budgetStore = makeDailyBudgetStore({
  storage: {
    get: () => dailyBudgetItem.getValue(),
    set: (record) => dailyBudgetItem.setValue(record),
  },
  now: () => Date.now(),
})
const budgetQueue = makeSerialQueue(queueError('budget'))
const headFetch = bindFetch(fetch)
const admissionGate = makeAdmissionGate({
  getSettings,
  savedIndex,
  queryConvex: queryConvexSaved,
  sizeProbe: makeSizeProbe({ fetch: (url, init) => headFetch(url, init) }),
  readTodayBudget: () => budgetStore.readToday(),
})

// Tweet harvest (spec §8–9): the durable IndexedDB store of harvested tweets and
// its opt-in, fire-and-forget Convex mirror. Both default to their real adapters;
// the seams exist so the merge-on-write and mirror gate are unit-tested.
const captureDb = makeCaptureDb()
const captureOutbox = makeCaptureOutbox()

/** Pick the download strategy for the active settings (Direct default; aria2 opt-in). */
function chooseStrategy(settings: Settings): DownloadStrategy {
  const direct = makeDirectStrategy({ download: (opts) => browser.downloads.download(opts) })
  if (settings.downloadStrategy === 'fetched') {
    return makeSchemeRoutingStrategy(
      makeFetchedStrategy({
        permissions: makePermissionsPort(),
        fetch: makeFetchPort(fetch),
        offscreen: makeOffscreenPort(),
        // Over-cap / unknown-sized video streams to disk via Direct instead of
        // buffering in the SW (OOM guard).
        direct,
      }),
      direct,
    )
  }
  if (settings.downloadStrategy === 'aria2') {
    const port = makeAria2RpcPort({ rpcUrl: settings.aria2RpcUrl, secret: settings.aria2Secret })
    // Sidecar data: URLs go to the browser even under aria2 (which can't fetch
    // them); they land in the browser download dir when aria2Dir points elsewhere.
    return makeSchemeRoutingStrategy(
      makeAria2Strategy(
        port,
        { split: settings.aria2Split, ...(settings.aria2Dir ? { dir: settings.aria2Dir } : {}) },
        makeFetchServiceLive(fetch),
      ),
      direct,
    )
  }
  // 'direct' (default) uses the browser download manager.
  return direct
}

/** The shared terminal path for a browser download (ADR-0014). Branches ONLY on
 *  `outcome` for: the clear-recorder, the durable outcome string (sync event +
 *  history), and the trace stage. Everything else — settle/flush ordering, the
 *  reportTransferOutcome backlink, metrics, sidecar gating — is identical. */
const settleBrowserDownload = async (
  id: string,
  downloadId: number,
  outcome: 'complete' | 'failed',
  now: number,
): Promise<void> => {
  const complete = outcome === 'complete'
  const tweetId = requestMetaById.get(id)?.item?.tweetId
  inFlight.delete(id)
  clearInterruptRetryState(id)
  if (complete) recordClearComplete(tweetId, id, downloadId)
  else recordClearFailure(tweetId, id)
  requestIdByDownloadId.delete(downloadId)
  stopStuckPollIfIdle() // last download settled → let the watchdog go quiet
  // The terminal-outcome fan-out is ONE pure decision (core/download/terminal-outcome):
  // it advances the tracker + metrics and emits the sync/history/backlink intents. This
  // shell only RUNS the returned effects, in order. The settled tracker MUST be flushed
  // before the durable sync/history writes, so a recycle can never leave this id in
  // `session:transfers` after its terminal was mirrored — a later boot reconcile would
  // otherwise re-fire it as a contradictory outcome.
  const settings = await getSettings()
  const fx = decideTerminalOutcome(
    { transfers: transfersState, metrics: live },
    id,
    outcome,
    now,
    settings.cloudDeviceId,
  )
  transfersState = fx.transfers
  live = fx.metrics
  await flushTransfers()
  if (fx.backlink) reportTransferOutcome(fx.backlink.requestId, fx.backlink.outcome, fx.backlink.at)
  // `.json` sidecars yield no sync event (empty → recordSync no-ops) and no backlink, but
  // still get a history transition (a no-op for an unqueued id) — the core owns those
  // asymmetries now, so this shell calls each sink unconditionally.
  recordSync(settings, fx.syncEvents)
  recordHistory(settings, fx.historyActions)
  // Light up the "Saved" status for this post immediately (instant, offline) — the
  // local-first half of the cross-device index; tweetId is unknown for an unqueued
  // sidecar, in which case there is nothing to mark.
  if (complete && tweetId !== undefined) {
    savedStatusCoordinator.onCompleted(tweetId)
    // Accrue the daily-budget tally (media completions only — sidecars carry no
    // tweetId). Prefer the known total size, else last-sampled bytes, else 0.
    const progress = live?.items.get(id)
    const bytes = progress
      ? progress.totalBytes > 0
        ? progress.totalBytes
        : progress.bytesReceived
      : 0
    budgetQueue.push(() => budgetStore.recordCompletion(bytes, 1))
  }
  traceBackground(complete ? 'browser-complete' : 'browser-failed', {
    itemId: id,
    elapsedMs: now - (requestStartedAt.get(id) ?? now),
    detail: `downloadId ${downloadId}`,
  })
  requestStartedAt.delete(id)
  if (fx.persistSnapshot) await persistSnapshot(now)
}

const failBrowserDownload = (id: string, downloadId: number, now: number): Promise<void> =>
  settleBrowserDownload(id, downloadId, 'failed', now)

const completeBrowserDownload = (id: string, downloadId: number, now: number): Promise<void> =>
  settleBrowserDownload(id, downloadId, 'complete', now)

const fireInterruptRetry = async (id: string): Promise<void> => {
  const meta = requestMetaById.get(id)
  if (meta === undefined) {
    await failBrowserDownload(id, -1, Date.now())
    return
  }
  const url = await resolveRetryUrl(meta)
  if (url !== meta.url) {
    requestMetaById.set(id, { ...meta, url })
    traceBackground('url-refreshed', { itemId: id, detail: 'cdn url updated before retry' })
  }
  try {
    const downloadId = await browser.downloads.download({
      url,
      filename: meta.filename,
      conflictAction: 'uniquify',
    })
    requestIdByDownloadId.set(downloadId, id)
    ensureStuckPoll() // watchdog recovers a missed terminal onChanged for this retry too
    // Remove from the retry queue BEFORE adding to the transfers ledger (mirrors
    // scheduleInterruptRetry's safe remove-then-add): a crash in this window then
    // leaves the id in NEITHER ledger — a lost retry, never a double-drive where
    // both rehydrate and reconcile fire the same id on the next boot.
    clearRetryTimeout(id)
    pendingRetries.delete(id)
    syncPendingRetries()
    transfersState = trackTransfer(transfersState, {
      id,
      downloadId,
      ...(meta.item?.tweetId ? { tweetId: meta.item.tweetId } : {}),
      startedAt: Date.now(),
    })
    persistTransfers()
    if (live) live = recordSample(live, { id, bytesReceived: 0, totalBytes: -1, t: Date.now() })
    traceBackground('interrupt-retry-started', {
      itemId: id,
      detail: `downloadId ${downloadId}`,
    })
    await persistSnapshot(Date.now())
  } catch {
    const attempt = interruptAttemptById.get(id) ?? 0
    const plan = planInterruptRetry({ reason: 'NETWORK_FAILED', attempt })
    if (plan.schedule) {
      interruptAttemptById.set(id, plan.nextAttempt)
      if (live) live = recordRetry(live, id)
      const nextRetryAt = Date.now() + plan.delayMs
      pendingRetries.set(id, {
        id,
        url,
        filename: meta.filename,
        attempt: plan.nextAttempt,
        nextRetryAt,
        ...(meta.item ? { item: meta.item } : {}),
      })
      syncPendingRetries()
      const handle = setTimeout(() => void fireInterruptRetry(id), plan.delayMs)
      retryTimeouts.set(id, handle)
      traceBackground('interrupt-retry-scheduled', {
        itemId: id,
        detail: `start-failed in ${plan.delayMs}ms attempt ${plan.nextAttempt}`,
      })
      await persistSnapshot(Date.now())
      return
    }
    await failBrowserDownload(id, -1, Date.now())
  }
}

const scheduleInterruptRetry = (
  id: string,
  downloadId: number,
  reason: string | undefined,
  now: number,
): void => {
  const attempt = interruptAttemptById.get(id) ?? 0
  const plan = planInterruptRetry({ reason, attempt })
  const meta = requestMetaById.get(id)
  if (!plan.schedule || meta === undefined) {
    void failBrowserDownload(id, downloadId, now)
    return
  }

  requestIdByDownloadId.delete(downloadId)
  // The dead downloadId leaves the active ledger; the retry is now tracked by the
  // durable retry queue (`session:interruptRetries`) until it fires a fresh one.
  transfersState = settleTransfer(transfersState, id)
  persistTransfers()
  interruptAttemptById.set(id, plan.nextAttempt)
  if (live) live = recordRetry(live, id)

  const nextRetryAt = now + plan.delayMs
  pendingRetries.set(id, {
    id,
    url: meta.url,
    filename: meta.filename,
    attempt: plan.nextAttempt,
    nextRetryAt,
    ...(meta.item ? { item: meta.item } : {}),
  })
  syncPendingRetries()

  clearRetryTimeout(id)
  const handle = setTimeout(() => void fireInterruptRetry(id), plan.delayMs)
  retryTimeouts.set(id, handle)

  traceBackground('interrupt-retry-scheduled', {
    itemId: id,
    detail: `${reason ?? 'unknown'} in ${plan.delayMs}ms attempt ${plan.nextAttempt}`,
  })
  void persistSnapshot(now)
}

const rehydrateInterruptRetries = async (): Promise<void> => {
  const queued = await retryQueueItem.getValue()
  const now = Date.now()
  for (const item of queued) {
    requestMetaById.set(item.id, {
      url: item.url,
      filename: item.filename,
      ...(item.item ? { item: item.item } : {}),
    })
    interruptAttemptById.set(item.id, item.attempt)
    pendingRetries.set(item.id, item)
    inFlight.add(item.id)
    const delay = Math.max(0, item.nextRetryAt - now)
    clearRetryTimeout(item.id)
    const handle = setTimeout(() => void fireInterruptRetry(item.id), delay)
    retryTimeouts.set(item.id, handle)
  }
}

/**
 * Recover the outcomes that landed while the SW was dead (ADR-0002). Load the
 * persisted in-flight ledger, reconcile each tracked transfer against
 * `downloads.search`, then surface the terminals — a transfer that completed or
 * failed in the gap is recorded to metrics/history/sync and announced to the
 * overlays, instead of being silently lost when the in-memory correlation died.
 * In-progress transfers re-seed the correlation + dedup sets so live `onChanged`
 * tracking resumes and a re-request is de-duplicated; a purged record is `unknown`
 * and merely traced (no fabricated outcome).
 *
 * Runs AFTER `rehydrateInterruptRetries`, which is authoritative for ids it owns —
 * a crash could leave an id in both ledgers, so those are deferred to the retry
 * path, never double-driven here. A transfer started by a concurrent
 * `handleDownload` during the (awaited) search window is merged back, never
 * evicted; a transfer whose search THREW (transient, not a purge) is retained for
 * the next boot rather than abandoned.
 */
const reconcileTransfersOnBoot = async (): Promise<void> => {
  const persisted = await transfersItem.getValue()
  transfersState = persisted
  if (persisted.transfers.length === 0) return
  const now = Date.now()
  // The dual-ledger tie-break is now a typed input: rehydrate ran first, so
  // `pendingRetries` is authoritative for the ids it owns and reconcile defers them.
  const retryOwnedIds = new Set(pendingRetries.keys())
  const { owned } = partitionOwnership(persisted.transfers, retryOwnedIds)
  const rows = new Map<number, ReconcileRow>()
  const threw = new Set<number>()
  await Promise.all(
    owned.map(async (t) => {
      try {
        const found = await browser.downloads.search({ id: t.downloadId })
        const row = found[0]
        // Empty result = purged record (terminal-unknown); a thrown search is
        // transient and tracked separately so the transfer is retained, not lost.
        if (row !== undefined) rows.set(t.downloadId, { state: row.state, exists: row.exists })
      } catch {
        threw.add(t.downloadId)
      }
    }),
  )
  // `transfersState` may have grown via a concurrent handleDownload during the search;
  // pass the live snapshot so those transfers are merged back, not evicted.
  const plan = planBootReconcile({
    persisted,
    retryOwnedIds,
    rowByDownloadId: rows,
    threwDownloadIds: threw,
    live: transfersState,
  })
  for (const t of plan.reSeed) {
    requestIdByDownloadId.set(t.downloadId, t.id)
    inFlight.add(t.id)
  }
  transfersState = plan.nextState
  persistTransfers()
  for (const t of plan.unknownToTrace) {
    traceBackground('reconcile-unknown', {
      itemId: t.id,
      detail: `downloadId ${t.downloadId} record gone; outcome unconfirmable`,
    })
  }
  // oxlint-disable no-await-in-loop -- few items; outcome side-effects are serial
  for (const t of plan.toComplete) await completeBrowserDownload(t.id, t.downloadId, now)
  for (const t of plan.toFail) await failBrowserDownload(t.id, t.downloadId, now)
  // oxlint-enable no-await-in-loop
}

// A browser download resolves ONLY via a `downloads.onChanged` terminal delta. Under a
// burst of concurrent completions the MV3 worker can miss/drop that delta — the download
// then sits in-flight forever, and a multi-media tweet gated on ALL its media being
// Settled never clears (its un-bookmark / un-like never fires; the post stays liked).
// Boot reconcile recovers this only after a SW restart. This watchdog closes the
// SW-was-alive-but-missed-the-event gap: while downloads are active it polls the source
// of truth (`downloads.search`) for any request that has outlived a generous window and
// drives the missed terminal through the SAME settle path — so the clear (and the
// metrics/history/sync fan-out) finally fire. It never fabricates: only a row that
// search itself reports `complete` clears; `interrupted`/missing-file fails; a still
// downloading or purged row is left alone.
const STUCK_RECONCILE_AFTER_MS = 12_000
const STUCK_RECONCILE_POLL_MS = 6_000
let stuckPollTimer: ReturnType<typeof setInterval> | null = null

const stopStuckPollIfIdle = (): void => {
  if (stuckPollTimer !== null && requestIdByDownloadId.size === 0) {
    clearInterval(stuckPollTimer)
    stuckPollTimer = null
  }
}

const reconcileStuckDownloads = async (): Promise<void> => {
  const now = Date.now()
  // Snapshot first — the settle helpers below mutate requestIdByDownloadId mid-loop.
  const stuck = [...requestIdByDownloadId.entries()].filter(
    ([, id]) =>
      // The durable interrupt-retry queue owns its ids — never double-drive them here.
      !pendingRetries.has(id) &&
      now - (requestStartedAt.get(id) ?? now) >= STUCK_RECONCILE_AFTER_MS,
  )
  // oxlint-disable no-await-in-loop -- few items; outcome side-effects are serial
  for (const [downloadId, id] of stuck) {
    let row: ReconcileRow | undefined
    try {
      row = (await browser.downloads.search({ id: downloadId }))[0]
    } catch {
      continue // transient search failure — try again next tick
    }
    // A live onChanged may have settled it during the await; only act if still mapped.
    if (requestIdByDownloadId.get(downloadId) !== id) continue
    const verdict = classifyTransfer(row)
    if (verdict === 'complete') {
      traceBackground('reconcile-stuck-complete', {
        itemId: id,
        detail: `downloadId ${downloadId}`,
      })
      await completeBrowserDownload(id, downloadId, now)
    } else if (verdict === 'failed') {
      traceBackground('reconcile-stuck-failed', { itemId: id, detail: `downloadId ${downloadId}` })
      await failBrowserDownload(id, downloadId, now)
    }
    // 'in-progress' (genuinely downloading) / 'unknown' (purged record) → leave it.
  }
  // oxlint-enable no-await-in-loop
  stopStuckPollIfIdle()
}

/** Arm the stuck-download watchdog while downloads are active (no-op if already armed).
 *  It self-stops once nothing is in flight, so it never keeps the worker awake idly. */
const ensureStuckPoll = (): void => {
  if (stuckPollTimer === null)
    stuckPollTimer = setInterval(() => void reconcileStuckDownloads(), STUCK_RECONCILE_POLL_MS)
}

/** Aggregate the gate's per-item skips into by-reason counts for the response. */
const summarizeSkipped = (
  skipped: ReadonlyArray<{ readonly reason: SkipReason }>,
): { reason: SkipReason; count: number }[] => {
  const counts = new Map<SkipReason, number>()
  for (const s of skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1)
  return [...counts].map(([reason, count]) => ({ reason, count }))
}

const handleDownload = (
  items: ReadonlyArray<MediaItem>,
  sweep?: { readonly scope: Scope },
  clearExpect?: ReadonlyArray<{ readonly tweetId: string; readonly ids: ReadonlyArray<string> }>,
  originTabId?: number,
) =>
  Effect.gen(function* () {
    const requestReceivedAt = Date.now()
    traceBackground('request-received', { detail: `${items.length} item(s)` })
    const svc = yield* SettingsService
    const settings = yield* svc.get
    const strategy = chooseStrategy(settings)
    const queue = makeDownloadQueueCore({ strategy, concurrency: settings.downloadConcurrency })
    // Admission gate (dedup + filters/caps): decide which media may be scheduled
    // BEFORE planning, so skipped items are never expanded into requests. A pure
    // pass-through when every gate setting is off.
    const admission = yield* Effect.promise(() => admissionGate.admit(items))
    const skipped = summarizeSkipped(admission.skipped)
    const requests = admission.admitted
      .flatMap((item) =>
        planDownloads({
          template: settings.filenameTemplate,
          item,
          sidecar: settings.sidecarMetadata,
        }),
      )
      .filter((r) => !inFlight.has(r.id))
    // Nothing to schedule (all gate-skipped or already in flight): report with the
    // skip summary so the overlay can explain why nothing downloaded.
    if (requests.length === 0) {
      traceBackground('request-deduped', {
        detail: `${admission.admitted.length} admitted, ${admission.skipped.length} skipped`,
      })
      yield* Effect.promise(() => persistSnapshot(Date.now()))
      return { _tag: 'QueueUpdate' as const, completed: 0, total: 0, skipped }
    }
    const mediaById = new Map(admission.admitted.map((i) => [i.id, i]))
    for (const r of requests) {
      inFlight.add(r.id)
      clearInterruptRetryState(r.id)
      const item = mediaById.get(r.id)
      requestMetaById.set(r.id, {
        url: r.url,
        filename: r.filename,
        ...(item ? { item } : {}),
      })
    }

    // Seed monitoring (B). If a prior batch is still in flight, EXTEND its
    // accumulator (and keep the downloadId map) so the monitor reflects both;
    // only start fresh once everything has settled (D1).
    const startedAt = Date.now()
    for (const r of requests) requestStartedAt.set(r.id, startedAt)
    traceBackground('queue-started', {
      elapsedMs: startedAt - requestReceivedAt,
      detail: `${requests.length} request(s), concurrency ${settings.downloadConcurrency}`,
    })
    if (live === null || snapshot(live, startedAt).active === 0) {
      requestIdByDownloadId.clear()
      live = emptyMetrics({
        total: requests.length,
        concurrencyCap: settings.downloadConcurrency,
        startedAt,
      })
    } else {
      live = extendTotal(live, requests.length, settings.downloadConcurrency)
    }
    yield* Effect.promise(() => persistSnapshot(startedAt))

    // Mirror queued transitions (Cloud Sync). Sidecar data: requests have no
    // MediaItem (their id is `<media-id>.json`) and are never mirrored.
    recordSync(
      settings,
      requests.flatMap((r) => {
        const item = mediaById.get(r.id)
        return item ? [queuedEvent(item, settings.cloudDeviceId, startedAt)] : []
      }),
    )
    // Same derivation, local store: a queued Download Record per Media Item
    // (sidecar `.json` requests have no MediaItem and are skipped, like the mirror).
    recordHistory(
      settings,
      requests.flatMap((r): HistoryAction[] => {
        const item = mediaById.get(r.id)
        return item ? [{ kind: 'queued', item, filename: r.filename, at: startedAt }] : []
      }),
    )

    // Cloud upload (ADR-0013): enqueue the real bytes to each connected provider,
    // in parallel with the local download. Same derivation — sidecar `.json`
    // requests have no MediaItem and are skipped, like the mirror/history.
    recordCloudUploads(
      settings,
      requests.flatMap((r) => {
        const item = mediaById.get(r.id)
        return item ? [{ item, filename: r.filename }] : []
      }),
    )

    // Clear-on-complete ledger: one entry per tweet (expected = its media request
    // ids). Membership is filtered in-page at clear time. Seeded only when enabled,
    // before downloads fire (spec §4.1). aria2 is excluded entirely — an aria2
    // entry is never Truly Complete (hand-off ≠ bytes-to-disk), so it could never
    // clear and would only leak into the in-memory map, never pruned. Every skip
    // logs WHY (clear-skip) so a "nothing happened" is never silent.
    // Clearing is gated by the "Clear after download" option (clearOnSave) for
    // BOTH paths — a sweep only un-likes/un-bookmarks when the user has that
    // option on; otherwise it just downloads. A sweep is strictly list-scoped:
    // seed ONLY the page's scope (origin 'sweep'), so it can never touch the
    // other list. It reads the option but NEVER mutates it. The auto-hook keeps
    // its per-scope toggles; the sweep clears exactly the page's scope.
    const clearScopes: Scope[] = sweep
      ? settings.clearAllListsOnSave
        ? [...new Set([sweep.scope, ...hookScopes(settings).filter((s) => s !== 'notInterested')])]
        : [sweep.scope]
      : hookScopes(settings)
    const clearOrigin = sweep ? 'sweep' : 'hook'
    if (settings.downloadStrategy === 'aria2') {
      traceBackground('clear-skip', { detail: 'aria2 hand-offs are not byte-verifiable; excluded' })
    } else if (!settings.clearOnSave) {
      traceBackground('clear-skip', { detail: 'Clear after download is OFF — download only' })
    } else if (clearScopes.length === 0) {
      traceBackground('clear-skip', { detail: 'both Un-bookmark and Un-like are OFF' })
    } else {
      const byTweet = new Map<string, string[]>()
      const unclearable = new Set<string>()
      for (const r of requests) {
        const item = mediaById.get(r.id)
        if (item === undefined) continue
        // The Clear can only LOCATE a post by its numeric /status/ id (findArticle).
        // The X adapter falls back to the media KEY as tweetId when a photo's tweet
        // context can't be resolved (e.g. a quote-card image, whose id belongs to a
        // DIFFERENT post). Such an id never matches a mounted article, so seeding it
        // would only defer-then-drop and silently leave the post in its lists — and
        // un-liking by a stray match would hit the WRONG post. Skip it: downloads
        // still run (they key off `requests`, not `byTweet`); only the doomed,
        // unsafe clear is dropped, and visibly (trace below) instead of silently.
        if (!isClearableTweetId(item.tweetId)) {
          unclearable.add(item.tweetId)
          continue
        }
        byTweet.set(item.tweetId, [...(byTweet.get(item.tweetId) ?? []), r.id])
      }
      if (unclearable.size > 0)
        traceBackground('clear-skip', {
          detail: `${unclearable.size} tweet(s) without a numeric status id — not DOM-clearable (v1)`,
        })
      // For You: widen `expected` to the post's FULL media set so the clear waits
      // for every photo — a 1-of-4 grab must never mark the post Truly Complete and
      // "Not interested"-hide it, losing the other three. Only widens tweets in this
      // batch; the un-grabbed ids stay pending until they too are downloaded.
      for (const e of clearExpect ?? []) {
        const cur = byTweet.get(e.tweetId)
        if (cur !== undefined) byTweet.set(e.tweetId, [...new Set([...cur, ...e.ids])])
      }
      // Remember which tab this download came from, so the eventual clear is sent
      // there first (the feed the user is actually looking at).
      if (originTabId !== undefined)
        for (const tweetId of byTweet.keys()) rememberClearOrigin(tweetId, originTabId)
      clearCoordinator.seedClearLedger(byTweet, clearScopes, clearOrigin)
    }

    const res = yield* queue.enqueue(requests)

    // Reconcile precise per-request outcomes: browser transfers go in-flight
    // (tracked by downloadId for the onChanged/search loop), aria2 hand-offs are
    // terminal from our side, and failures-to-start are recorded failed.
    const now = Date.now()
    const syncEvents: SyncEvent[] = []
    const historyActions: HistoryAction[] = []
    for (const o of res.outcomes) {
      const media = mediaById.get(o.id)
      if (!o.ok) {
        inFlight.delete(o.id)
        recordClearFailure(media?.tweetId, o.id)
        live = recordOutcome(live, o.id, 'failed', now)
        syncEvents.push(outcomeEvent(o.id, 'failed', settings.cloudDeviceId, now))
        historyActions.push({ kind: 'failed', requestId: o.id, at: now })
        traceBackground('start-failed', {
          itemId: o.id,
          elapsedMs: now - (requestStartedAt.get(o.id) ?? startedAt),
        })
      } else if (o.handle?.kind === 'browser') {
        requestIdByDownloadId.set(o.handle.id, o.id)
        ensureStuckPoll() // watchdog recovers a missed terminal onChanged for this download
        // Only media downloads enter the durable ledger; sidecar `.json` requests
        // carry no badge and are never mirrored, so they need no outcome tracking.
        if (!o.id.endsWith('.json'))
          transfersState = trackTransfer(transfersState, {
            id: o.id,
            downloadId: o.handle.id,
            ...(media?.tweetId ? { tweetId: media.tweetId } : {}),
            startedAt: requestStartedAt.get(o.id) ?? startedAt,
          })
        live = recordSample(live, { id: o.id, bytesReceived: 0, totalBytes: -1, t: now })
        traceBackground('browser-started', {
          itemId: o.id,
          elapsedMs: now - (requestStartedAt.get(o.id) ?? startedAt),
          detail: `downloadId ${o.handle.id}`,
        })
      } else {
        inFlight.delete(o.id)
        live = recordOutcome(live, o.id, 'complete', now)
        syncEvents.push(outcomeEvent(o.id, 'completed', settings.cloudDeviceId, now))
        historyActions.push({ kind: 'completed', requestId: o.id, at: now })
        traceBackground('external-complete', {
          itemId: o.id,
          elapsedMs: now - (requestStartedAt.get(o.id) ?? startedAt),
          detail: o.handle ? `aria2 ${o.handle.gid}` : undefined,
        })
      }
    }
    recordSync(settings, syncEvents)
    recordHistory(settings, historyActions)
    persistTransfers()
    yield* Effect.promise(() => persistSnapshot(now))

    return { _tag: 'QueueUpdate' as const, completed: res.completed, total: res.total, skipped }
  }).pipe(Effect.provide(SettingsServiceLive))

/** The durable one-by-one sweep (content → background). Skip tweets already
 *  cleared (the persistent flag), mark the rest 'queued', and fire their
 *  downloads into the queue — each post then rides the SAME verified clear-on-
 *  save pipeline (Settle confirmed by chrome.downloads.search) and is marked
 *  'cleared' only on a verified flip. Nothing is clicked here; a partial/failed
 *  download never clears. Returns fast so the popup can close while work runs. */
const handleSweepEnqueue = async (
  scope: ClearScope,
  posts: ReadonlyArray<{ readonly tweetId: string; readonly items: ReadonlyArray<MediaItem> }>,
): Promise<SweepEnqueueResponse> => {
  const { queuedPosts, skipped } = await clearCoordinator.enqueueSweepWorklist(scope, posts)
  // Fire into the queue with the sweep's explicit list scope — handleDownload
  // seeds the clear ledger with origin 'sweep' (only this scope), independent of
  // the global clearOnSave/per-scope toggles, which the sweep never mutates.
  const items = queuedPosts.flatMap((p) => [...p.items])
  if (items.length > 0) void Effect.runPromise(handleDownload(items, { scope }))
  return { _tag: 'SweepEnqueueResponse', queued: queuedPosts.length, skipped }
}

/** Byte progress is not carried in the onChanged delta (§d) — pull it from
 *  search and fold each sample into `live`. A gone record / transient search
 *  error drops this tick's progress (best-effort) but is now traced, not fully
 *  swallowed. Closes over `live`/`requestIdByDownloadId` like the terminal helpers. */
const sampleBytes = async (downloadId: number, now: number): Promise<void> => {
  try {
    const rows = await browser.downloads.search({ id: downloadId })
    for (const sample of samplesFromSearch(rows, requestIdByDownloadId, now)) {
      if (live) live = recordSample(live, sample)
    }
  } catch (err) {
    // The record may be gone; drop this tick's byte sample (was silently
    // swallowed before — now at least traced so a search failure is visible).
    traceBackground('sample-search-failed', {
      detail: err instanceof Error ? err.message : String(err),
    })
  }
}

/** The browser-download lifecycle dispatch: sample byte progress, then route the
 *  delta to complete / interrupt-retry / persist. Extracted from the inline
 *  onChanged IIFE; identical control flow. */
const onDownloadChanged = async (delta: Browser.downloads.DownloadDelta): Promise<void> => {
  const id = requestIdByDownloadId.get(delta.id)
  // Process any tracked transfer even when the metrics accumulator is null (e.g.
  // just after a boot reconcile re-seeded the correlation): the durable outcome
  // and badge backlink must still fire; the byte-sample writes stay `live`-guarded.
  if (id === undefined) return
  const now = Date.now()
  await sampleBytes(delta.id, now)
  if (delta.state?.current === 'complete') {
    await completeBrowserDownload(id, delta.id, now)
  } else if (delta.state?.current === 'interrupted') {
    scheduleInterruptRetry(id, delta.id, delta.error?.current, now)
  } else {
    await persistSnapshot(now)
  }
}

/** Manual monitor reset (popup): refuse while downloads are active, else clear
 *  every in-flight/correlation/retry/ledger set and the persisted snapshot.
 *  Kept as a named function (not inlined into the handler table) — large and
 *  stateful. Returns the popup-facing ClearDownloadMonitorResponse. */
const clearDownloadMonitor = async (): Promise<unknown> => {
  const snap = (await metricsItem.getValue()) ?? ZERO_SNAPSHOT
  if (snap.active > 0) {
    return {
      _tag: 'ClearDownloadMonitorResponse',
      ok: false,
      active: snap.active,
      clearedMetrics: false,
      clearedLocks: 0,
      reason: 'active-downloads',
    }
  }
  const clearedLocks = inFlight.size
  inFlight.clear()
  requestIdByDownloadId.clear()
  stopStuckPollIfIdle() // map emptied → tear the watchdog down
  requestStartedAt.clear()
  requestMetaById.clear()
  interruptAttemptById.clear()
  for (const handle of retryTimeouts.values()) clearTimeout(handle)
  retryTimeouts.clear()
  pendingRetries.clear()
  void retryQueueItem.setValue([])
  transfersState = emptyTracker
  persistTransfers()
  clearCoordinator.resetLedger() // the manual reset bounds the in-memory clear ledger too
  traceEvents = []
  live = null
  await metricsItem.setValue(null)
  return {
    _tag: 'ClearDownloadMonitorResponse',
    ok: true,
    active: 0,
    clearedMetrics: true,
    clearedLocks,
  }
}

// Knowledge Capture exports (spec §10). The MV3 service worker can't mint
// `blob:` URLs and `data:` downloads are unreliable, so the SW only BUILDS the
// artifact text; the options page (which has a DOM + URL.createObjectURL) does
// the actual download. Quote text is resolved against the full record set.
const captureRecentLimit = 20

const buildCaptureExport = async (
  kind: 'jsonl' | 'tree' | 'markdown',
  conversationId: string | undefined,
): Promise<{ filename: string; text: string } | null> => {
  if (kind === 'jsonl') {
    const records = await captureDb.allRecords()
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    return { filename: `xharvest-${day}.jsonl`, text: toJsonl(records) }
  }
  if (conversationId === undefined) return null
  const all = await captureDb.allRecords()
  const [tree] = buildTree(selectConversation(all, conversationId))
  if (tree === undefined) return null
  if (kind === 'tree')
    return { filename: `thread-${conversationId}.json`, text: toTreeJson(tree, all) }
  return { filename: `thread-${conversationId}.md`, text: toMarkdown(tree, all) }
}

// Typed message-router table. Each entry returns the value to send back; the
// listener pipes it to sendResponse and keeps the channel open. `handle` narrows
// the union member for the entry while keeping the table's value type uniform.
/** The slice of the message sender the handlers need: the originating tab id, so a
 *  download's clear can be sent back to the tab it came from. */
type MsgSender = { readonly tab?: { readonly id?: number | undefined } | undefined }
type MessageHandlers = Partial<
  Record<Message['_tag'], (msg: Message, sender: MsgSender) => Promise<unknown>>
>
const handle =
  <T extends Message['_tag']>(
    fn: (msg: Extract<Message, { _tag: T }>, sender: MsgSender) => Promise<unknown>,
  ) =>
  (msg: Message, sender: MsgSender): Promise<unknown> =>
    fn(msg as Extract<Message, { _tag: T }>, sender)

const messageHandlers: MessageHandlers = {
  DownloadRequest: handle<'DownloadRequest'>((msg, sender) =>
    Effect.runPromise(handleDownload(msg.items, undefined, msg.clearExpect, sender.tab?.id)),
  ),
  MetricsRequest: async () => (await metricsItem.getValue()) ?? currentSnapshot(Date.now()),
  DownloadTraceEvent: handle<'DownloadTraceEvent'>(async (msg) => {
    recordTrace({
      source: msg.source,
      stage: msg.stage,
      t: msg.t,
      ...(msg.itemId !== undefined ? { itemId: msg.itemId } : {}),
      ...(msg.tweetId !== undefined ? { tweetId: msg.tweetId } : {}),
      ...(msg.type !== undefined ? { type: msg.type } : {}),
      ...(msg.elapsedMs !== undefined ? { elapsedMs: msg.elapsedMs } : {}),
      ...(msg.detail !== undefined ? { detail: msg.detail } : {}),
    })
    await persistSnapshot(Date.now())
    return { ok: true }
  }),
  ClearDownloadMonitorRequest: () => clearDownloadMonitor(),
  HistoryRequest: async () => ({ records: decodeStore(await historyItem.getValue()).records }),
  SavedStatusRequest: handle<'SavedStatusRequest'>((msg) => savedStatusCoordinator.handle(msg)),
  ClearHistoryRequest: async () => {
    await historyItem.setValue(emptyStore)
    return { ok: true }
  },
  SyncTestRequest: async () => runSyncConnectionTest(await getSettings()),
  SyncStatusRequest: () => syncOutbox.getSyncStatus(),
  CloudConnectRequest: handle<'CloudConnectRequest'>((msg) =>
    cloudUpload.runOAuthConnect(msg.provider, msg.clientId),
  ),
  CloudDisconnectRequest: handle<'CloudDisconnectRequest'>((msg) =>
    cloudUpload.disconnectProvider(msg.provider),
  ),
  CloudStatusRequest: () => cloudUpload.cloudUploadStatus(),
  CloudRetryRequest: () => cloudUpload.retryDeadUploads(),
  CloudBackfillRequest: () => cloudUpload.backfillCloudUploads(),
  SweepEnqueueRequest: handle<'SweepEnqueueRequest'>((msg) =>
    handleSweepEnqueue(msg.scope, msg.posts),
  ),
  // Recover an un-teed tweet's media via the syndication endpoint (videos the
  // DOM can't expose). Reply with the raw body; the content script parses it.
  RecoverTweetMediaRequest: handle<'RecoverTweetMediaRequest'>(async (msg) => {
    const body = await recoverSyndicationBody(msg.tweetId)
    return { _tag: 'RecoverTweetMediaResponse', ...(body !== null ? { body } : {}) }
  }),
  // Knowledge Capture (spec §8/§9/§10/§12). The dispatcher persists the batch to
  // the durable IndexedDB store (source of truth), then offers it to the opt-in
  // Convex mirror fire-and-forget — `mirrorCaptures` gates internally and never
  // affects the `{ stored }` reply.
  CaptureTweets: handle<'CaptureTweets'>(async (msg) => {
    await captureDb.putRecords(msg.records)
    const total = await captureDb.count()
    console.info(`[XMD] capture received ${msg.records.length} record(s); store total=${total}`)
    captureOutbox.mirrorCaptures(msg.records)
    return { stored: msg.records.length }
  }),
  // Streams the store through a cursor fold — the harvest can be tens of
  // thousands of records, and `getAll()` materialized every one of them in SW
  // memory on each popup open just to compute three aggregates.
  CaptureSummaryRequest: handle<'CaptureSummaryRequest'>(async (msg) =>
    finishCaptureSummary(
      await captureDb.fold(emptyCaptureSummary(), foldCaptureSummary),
      msg.limit ?? captureRecentLimit,
    ),
  ),
  ExportCaptureRequest: handle<'ExportCaptureRequest'>(async (msg) => {
    const built = await buildCaptureExport(msg.kind, msg.conversationId)
    if (built === null) return { ok: false, filename: '', text: '' }
    console.info(
      `[XMD] capture export ${msg.kind} → ${built.filename} (${built.text.length} bytes)`,
    )
    return { ok: true, filename: built.filename, text: built.text }
  }),
  ClearCaptureRequest: async () => {
    const cleared = await captureDb.count()
    await captureDb.clear()
    return { cleared }
  },
}

export default defineBackground(() => {
  // Boot marker: prints on every service-worker start. If you DON'T see this line
  // in the SW console, the new build isn't loaded (reload the extension / check it
  // points at .output/chrome-mv3). It also prints the clear-on-save settings so
  // "why didn't it un-like?" is answerable at a glance — no commands needed.
  void getSettings().then((s) =>
    console.info(
      `[XMD] background booted · clearOnSave=${s.clearOnSave} unbookmark=${s.autoUnbookmarkOnSave} unlike=${s.autoUnlikeOnSave} strategy=${s.downloadStrategy}`,
    ),
  )
  // Rehydrate the retry queue FIRST so `pendingRetries` is populated before the
  // reconcile decides ownership — an id the retry queue owns must not also be
  // driven to a terminal by reconcile (the dual-ledger tie-break).
  void (async () => {
    await rehydrateInterruptRetries()
    await reconcileTransfersOnBoot()
  })()

  // Cloud Sync reconciliation: drain anything left over from a previous SW
  // life / offline period; clear the outbox whenever the user turns sync off.
  void (async () => {
    let s = await getSettings()
    // Dev convenience: a gitignored `.env` (WXT_CONVEX_URL/SECRET) pre-seeds the
    // popup's Convex config on first run so there's nothing to paste. Gated on
    // an empty config (never overrides a user edit) AND on the vars existing —
    // a normal build has neither, so it stays opt-in/default-off (ADR-0009).
    //
    // The `import.meta.env.DEV` guard is load-bearing security, not cosmetics:
    // `WXT_CONVEX_SECRET` is the deployment's write capability and Vite INLINES
    // `import.meta.env.*` at build time, so without this guard a `wxt build` run
    // with a populated `.env` would bake the live secret into the shipped
    // `background.js`. In a production build `DEV` is `false`, so Vite tree-shakes
    // this whole branch — and the secret reference — out of the bundle. The
    // real per-user auth path is the options page (each user pastes their own
    // secret), which this only short-circuits for a single developer's dev build.
    if (import.meta.env.DEV) {
      const envUrl = import.meta.env.WXT_CONVEX_URL as string | undefined
      const envSecret = import.meta.env.WXT_CONVEX_SECRET as string | undefined
      if (envUrl && envSecret && s.convexUrl === '' && s.convexSyncSecret === '') {
        s = await setSettings({
          convexUrl: envUrl,
          convexSyncSecret: envSecret,
          cloudSyncEnabled: true,
          ...(s.cloudDeviceId === '' ? { cloudDeviceId: crypto.randomUUID() } : {}),
        })
      }
    }
    if (isSyncConfigured(s)) outboxQueue.push(() => drainOutbox(s))
    // Dev convenience (ADR-0013): a gitignored `.env` may pre-seed the Cloud
    // Upload OAuth client IDs (public, not secrets). Gated on an empty field so a
    // user edit is never overridden; a normal build has neither var.
    const envGdriveClientId = import.meta.env.WXT_GDRIVE_CLIENT_ID as string | undefined
    const envDropboxAppKey = import.meta.env.WXT_DROPBOX_APP_KEY as string | undefined
    if (envGdriveClientId && s.gdriveClientId === '')
      s = await setSettings({ gdriveClientId: envGdriveClientId })
    if (envDropboxAppKey && s.dropboxClientId === '')
      s = await setSettings({ dropboxClientId: envDropboxAppKey })
    // Resume any cloud byte-uploads left pending from a previous SW life, and
    // compact a historically-grown ledger once on boot (ADR-0013).
    if (s.cloudUploadEnabled) cloudUpload.resumeOnBoot()
  })()
  watchSettings((s) => {
    if (!s.cloudSyncEnabled) syncOutbox.clearOutbox()
    // Clear the upload-failure badge when Cloud upload is switched off.
    if (!s.cloudUploadEnabled) cloudUpload.clearUploadBadge()
  })

  // Listeners registered synchronously at the top of main() (grounding §b).
  // Backoff wake-up: a due upload-retry alarm re-kicks the serialized drain so
  // failed jobs retry autonomously without waiting for the next download.
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === cloudUpload.uploadAlarm) uploadQueue.push(() => drainUploadJobs())
  })
  browser.downloads.onChanged.addListener((delta) => void onDownloadChanged(delta))

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const decoded = Schema.decodeUnknownResult(Message)(message)
    if (Result.isFailure(decoded)) {
      const rawTag = (message as { _tag?: unknown } | null)?._tag
      if (typeof rawTag === 'string' && rawTag.startsWith('Capture'))
        console.warn(
          `[XMD] capture message ${rawTag} FAILED schema decode (dropped):`,
          decoded.failure,
        )
      return false
    }
    const msg = decoded.success
    // Sender authorization: drop anything from another extension, an off-origin
    // content script, or a content script reaching for a UI-only tag — before
    // any download / OAuth / cloud-egress / clear handler runs.
    if (!isMessageAllowed(msg._tag, sender, browser.runtime.id)) {
      if (msg._tag.startsWith('Capture'))
        console.warn(
          `[XMD] capture message ${msg._tag} BLOCKED by sender guard (contentScript=${sender?.tab !== undefined && sender?.tab !== null})`,
        )
      return false
    }
    const h = messageHandlers[msg._tag]
    if (!h) return false
    // A rejected handler must still resolve the channel: without this `.catch` the
    // reply never lands, the port closes, and the caller sees a generic "port
    // closed" while the real error vanishes. Trace it and reply a failure so the
    // error is observable and the caller is unblocked.
    void h(msg, sender)
      .then(sendResponse)
      .catch((err) => {
        traceBackground('message-handler-failed', {
          detail: `${msg._tag}: ${err instanceof Error ? err.message : String(err)}`,
        })
        sendResponse({ ok: false, error: 'handler failed' })
      })
    return true // keep the channel open for the async reply
  })
})
