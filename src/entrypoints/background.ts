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
import { planConvexEnvSeed, planCloudEnvSeed } from '../core/settings/env-seed'
import type { SyncEvent } from '../core/sync/events'
import { makeConvexHttpPort, queryDownloadedAmong } from '../core/sync/convex'
import { makeSavedIndex, type QueryConvex } from '../core/sync/saved-index'
import {
  partitionAllowedMediaItems,
  assertAllowedMediaUrl,
  UnsafeUrlError,
} from '../core/sync/url-guard'
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
  recordOutcome,
  recordRetry,
  recordSample,
  samplesFromSearch,
  snapshot,
  type MetricsState,
} from '../core/download/metrics'
import { decideQueueStart } from '../core/download/queue-start'
import type { PendingInterruptRetry } from '../core/download/interrupt-retry'
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
import {
  decideEnqueueOutcome,
  decideTerminalOutcome,
  type EnqueueOutcomeEffects,
  type TerminalOutcome,
} from '../core/download/terminal-outcome'
import {
  decodeRequestMetaStore,
  emptyRequestMetaStore,
  planMetaReconcile,
  type PersistedRequestMeta,
} from '../core/download/request-meta'
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
import { makeClearSession } from '../background/clear-session'
import { applyQueueStartEffects } from '../background/queue-start-applier'
import { makeRetryQueue } from '../core/download/retry-queue'
import { makeCaptureDb } from '../background/capture-db'
import { makeCaptureOutbox } from '../background/capture-outbox'
import {
  emptyCaptureSummary,
  finishCaptureSummary,
  foldCaptureSummary,
} from '../core/capture/store'
import { composeCaptureExport } from '../core/capture/build-export'

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

// Browser download metadata for interrupted auto-retry (url/filename + item).
// Aliased to the persisted codec's decoded type so the in-memory shape and the
// `session:requestMeta` twin below cannot drift apart.
type RequestMeta = PersistedRequestMeta
const requestMetaById = new Map<string, RequestMeta>()
// `requestMetaById`'s durable twin (ADR-0005: session bucket, this SW is the sole
// writer). `session:transfers` re-seeds still-in-progress downloads on boot, but
// `TrackedTransfer` stays narrow (downloadId → terminal outcome only, per its own
// module doc) — it does NOT carry retry meta. Without this record, a re-seeded
// transfer that later interrupts finds no url/filename to retry with and fails
// immediately instead of auto-retrying. Ids the retry queue owns are restored from
// `session:interruptRetries` instead (see `planMetaReconcile`), never from here;
// they stay mirrored while pending and are reaped at settle.
// `unknown` + `decodeRequestMetaStore` at every read (mirrors `historyItem`'s
// `decodeStore` pattern) — a corrupt/foreign value never throws, it decodes empty.
const requestMetaItem = storage.defineItem<unknown>('session:requestMeta', {
  fallback: emptyRequestMetaStore,
})
const retryQueueItem = storage.defineItem<ReadonlyArray<PendingInterruptRetry>>(
  'session:interruptRetries',
  { fallback: [] },
)

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

// `retryQueue` is built further down (its deps aren't declared yet — TDZ), but
// `clearInterruptRetryState` is only ever CALLED at runtime, never at
// module-eval time, so the forward reference is safe.
const clearInterruptRetryState = (id: string): void => {
  retryQueue.forget(id)
  // Persist gated on the delete: the admit loop calls this per request before
  // seeding meta, and an unconditional write there would be N+1 identical snapshots.
  if (requestMetaById.delete(id)) persistRequestMeta()
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

// Same serialized-write shape as `transfersQueue`, for `requestMetaById`'s durable
// twin. Reads `requestMetaById` at run time (not a captured snapshot), so the last
// queued write always reflects whatever the map holds when it actually runs.
const requestMetaQueue = makeSerialQueue(queueError('requestMeta'))
const persistRequestMeta = (): void => {
  requestMetaQueue.push(() => requestMetaItem.setValue(Object.fromEntries(requestMetaById)))
}

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
  // BackfillRecord.media keeps its own `handle`-named field (cloud-upload.ts is
  // untouched by the multi-platform rename) — map the generalized author onto it.
  getBackfillRecords: async () =>
    decodeStore(await historyItem.getValue()).records.map((r) => ({
      requestId: r.requestId,
      filename: r.filename,
      media: { url: r.media.url, handle: r.media.author, ext: r.media.ext },
    })),
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

// One worker-owned Clear lifecycle: planned seed, settle timers, origin tab,
// ledger, durable sweep worklist, and tab/Drain dispatch.
const clearSession = makeClearSession({
  queueError,
  getSettings,
  trace: traceBackground,
  dispatchClear: (tweetId, scopes, allLists, preferTabId) =>
    sendClearToTabs(tweetId, scopes, preferTabId, allLists),
  // Settle Port: the real `chrome.downloads.search`. Returns the row (or undefined
  // when it's gone), swallowing a teardown-time throw to undefined — `decideSettle`
  // fails that closed, so the irreversible Clear never fires on an unconfirmed byte.
  settleProbe: (downloadId) =>
    browser.downloads
      .search({ id: downloadId })
      .then((rows) => rows[0])
      .catch(() => undefined),
})
const { recordComplete: recordClearComplete, recordFailure: recordClearFailure } = clearSession

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
// Per-item duplicate-download check (admission gate only — NOT the post-level
// "Saved" badge above). A separate SavedIndex instance keyed on item.id (the
// media key), so grabbing one item from a multi-item post never blocks a
// DIFFERENT item from the same post. Local-only for v1: the backend has a
// `by_request_id` backstop available (queryDownloadedMediaIdsAmong) but it is
// deliberately NOT wired here — cross-device per-item dedup was never a stated
// requirement, only cross-device post-level "Saved" was. Local history already
// durably answers "did I already grab this exact file."
const savedMediaIndex = makeSavedIndex()
const queryConvexMedia: QueryConvex = async () => []

// Seed once on SW startup from the durable history's completed tweetIds.
void (async () => {
  const { records } = decodeStore(await historyItem.getValue())
  const completed = records.filter((r) => r.status === 'completed')
  savedIndex.seed(completed.map((r) => r.media.postId))
  savedMediaIndex.seed(completed.map((r) => r.requestId)) // requestId === item.id
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
  savedMediaIndex,
  queryConvexMedia,
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
  const tweetId = requestMetaById.get(id)?.item?.postId
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
  // Per-item dedup index (admission gate only, see the `savedMediaIndex` comment
  // above): `id` here is the request id, which always equals item.id/requestId
  // regardless of whether a postId was resolvable for the badge above. Marking a
  // sidecar's own id is harmless — sidecar ids are never reused as a photo/video's
  // item.id, so this can never wrongly dedup real media.
  if (complete) savedMediaIndex.markSaved(id)
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

// Retry Scheduler shell (CONTEXT.md's Clock Port entry): the queue owns the
// whole interrupt-retry state machine — attempt counter, queue row, live timer,
// and the durable `session:interruptRetries` mirror move together behind its
// interface (core/download/retry-queue). `fire` is a forward reference to
// `fireInterruptRetry` (declared next) — legal JS: the closure only resolves it
// when actually CALLED, long after every module-level `const` here has run at
// SW startup.
const retryQueue = makeRetryQueue({
  store: {
    get: () => retryQueueItem.getValue(),
    set: (rows) => void retryQueueItem.setValue([...rows]),
  },
  recordRetry: (id) => {
    if (live) live = recordRetry(live, id)
  },
  trace: traceBackground,
  persistSnapshot,
  failBrowserDownload,
  fire: (id) => void fireInterruptRetry(id),
})

const fireInterruptRetry = async (id: string): Promise<void> => {
  const meta = requestMetaById.get(id)
  if (meta === undefined) {
    await failBrowserDownload(id, -1, Date.now())
    return
  }
  const url = await resolveRetryUrl(meta)
  // Fail closed: a refreshed retry URL (e.g. re-read from a hostile page's DOM)
  // must pass the same CDN allow-list before persistence or download.
  try {
    assertAllowedMediaUrl(url)
  } catch (cause) {
    traceBackground('interrupt-retry-blocked', {
      itemId: id,
      detail: cause instanceof UnsafeUrlError ? cause.reason : 'unsafe media URL',
    })
    await failBrowserDownload(id, -1, Date.now())
    return
  }
  if (url !== meta.url) {
    requestMetaById.set(id, { ...meta, url })
    persistRequestMeta() // a recycle mid-retry must restore the refreshed url, not the stale one
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
    // both rehydrate and reconcile fire the same id on the next boot. `drop`
    // deliberately KEEPS the attempt counter (it only resets at settle, via
    // `forget`) — see the queue's own contract.
    retryQueue.drop(id)
    transfersState = trackTransfer(transfersState, {
      id,
      downloadId,
      ...(meta.item?.postId ? { tweetId: meta.item.postId } : {}),
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
    // No live download handle exists yet (the browser.downloads.download call
    // above already threw), so `downloadId` is the sentinel -1 — mirrors the
    // `failBrowserDownload(id, -1, ...)` sentinel usage elsewhere in this file.
    // This path never had a transfer-ledger entry, so unlike scheduleInterruptRetry
    // there is nothing to settle on the scheduled branch (decision 4 in the handoff).
    await retryQueue.schedule({
      id,
      downloadId: -1,
      url,
      filename: meta.filename,
      ...(meta.item ? { item: meta.item } : {}),
      reason: 'NETWORK_FAILED',
      traceLabel: 'start-failed',
      now: Date.now(),
    })
  }
}

const scheduleInterruptRetry = (
  id: string,
  downloadId: number,
  reason: string | undefined,
  now: number,
): void => {
  const meta = requestMetaById.get(id)
  if (meta === undefined) {
    void failBrowserDownload(id, downloadId, now)
    return
  }
  // The queue computes `attempt` + decides via planInterruptRetry internally,
  // so the scheduled-vs-exhausted branch can't be pre-checked here without
  // duplicating that decision (out of scope). Instead, the ledger-settle
  // — which ONLY ever ran on the schedule branch — is passed in as `onScheduled`,
  // a synchronous hook `schedule()` invokes the instant it decides to schedule,
  // before its own state mutation and internal `await persistSnapshot`. This
  // preserves the original fully-synchronous, atomic ordering (ledger-settle
  // still runs in the same tick as the decision, ahead of any await) rather than
  // deferring it into a post-await `.then()`. `scheduleInterruptRetry` itself
  // stays synchronous/non-blocking — its `onDownloadChanged` caller does not and
  // should not await it.
  void retryQueue.schedule({
    id,
    downloadId,
    url: meta.url,
    filename: meta.filename,
    ...(meta.item ? { item: meta.item } : {}),
    reason,
    now,
    onScheduled: () => {
      requestIdByDownloadId.delete(downloadId)
      // The dead downloadId leaves the active ledger; the retry is now tracked by
      // the durable retry queue (`session:interruptRetries`) until it fires a fresh one.
      transfersState = settleTransfer(transfersState, id)
      persistTransfers()
    },
  })
}

const rehydrateInterruptRetries = async (): Promise<void> => {
  // The queue restores its own attempt/row/timer state and returns the rows so
  // the broader-than-retry side state (request meta, in-flight dedup) can be
  // seeded here, where it lives.
  const queued = await retryQueue.rehydrate(Date.now())
  for (const item of queued) {
    requestMetaById.set(item.id, {
      url: item.url,
      filename: item.filename,
      ...(item.item ? { item: item.item } : {}),
    })
    inFlight.add(item.id)
  }
  if (queued.length > 0) persistRequestMeta()
}

/**
 * Recover the outcomes that landed while the SW was dead (ADR-0002). Load the
 * persisted in-flight ledger, reconcile each tracked transfer against
 * `downloads.search`, then surface the terminals — a transfer that completed or
 * failed in the gap is recorded to metrics/history/sync and announced to the
 * overlays, instead of being silently lost when the in-memory correlation died.
 * In-progress transfers re-seed the correlation + dedup sets so live `onChanged`
 * tracking resumes and a re-request is de-duplicated; a purged record is `unknown`
 * and merely traced (no fabricated outcome). Re-seeded transfers also get their
 * retry meta restored from `session:requestMeta` (`planMetaReconcile`) and the
 * stuck-download watchdog re-armed — without these two, a re-seeded transfer that
 * later interrupts has no url/filename to retry with and no watchdog covering it.
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
  // The dual-ledger tie-break is now a typed input: rehydrate ran first, so
  // the retry queue is authoritative for the ids it owns and reconcile defers them.
  const retryOwnedIds = retryQueue.ownedIds()
  if (persisted.transfers.length === 0) {
    // No transfers to reconcile, but the sibling meta record still needs its boot
    // GC — orphaned entries must die on ANY boot, not only one with in-flight
    // transfers. Nothing re-seeds, so the plan is prune-only (restore is empty by
    // construction) and applying it is just rewriting the store from the live map.
    const store = decodeRequestMetaStore(await requestMetaItem.getValue())
    const gc = planMetaReconcile({ reSeedIds: [], retryOwnedIds, persisted: store })
    if (gc.prune.length > 0) persistRequestMeta()
    return
  }
  const now = Date.now()
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
  // Restore retry meta for what was just re-seeded (the actual fix: without this,
  // a re-seeded transfer that later interrupts has no url/filename to retry with).
  // The persist also GCs true orphans (entries with no live owner) so the record
  // can't grow unbounded across recycles. Retry-owned ids are excluded from
  // restore — rehydrate already restored them from `session:interruptRetries` —
  // but stay mirrored while pending, reaped at settle (`planMetaReconcile`'s doc).
  const metaPlan = planMetaReconcile({
    reSeedIds: plan.reSeed.map((t) => t.id),
    retryOwnedIds,
    persisted: decodeRequestMetaStore(await requestMetaItem.getValue()),
  })
  for (const [id, meta] of metaPlan.restore) requestMetaById.set(id, meta)
  if (metaPlan.restore.length > 0 || metaPlan.prune.length > 0) persistRequestMeta()
  if (plan.reSeed.length > 0) ensureStuckPoll() // re-seeded in-flight downloads need the watchdog armed too
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
      !retryQueue.has(id) && now - (requestStartedAt.get(id) ?? now) >= STUCK_RECONCILE_AFTER_MS,
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
    // Fail-closed URL boundary (before admission, probes, persistence, or any
    // strategy): page-derived items may carry forged URLs; a mixed batch keeps
    // its valid items and reports the rejected ones as failures.
    const checked = partitionAllowedMediaItems(items)
    const urlFailures = checked.rejected.map(({ itemId, reason }) => ({
      itemId,
      reason: `unsafe media URL: ${reason}`,
    }))
    const admission = yield* Effect.promise(() => admissionGate.admit(checked.allowed))
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
      return {
        _tag: 'QueueUpdate' as const,
        completed: 0,
        total: urlFailures.length,
        skipped,
        ...(urlFailures.length > 0 ? { failures: urlFailures } : {}),
      }
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
    persistRequestMeta()

    // One pure start decision owns monitoring, queued mirrors/uploads, and B's
    // Clear seed verdict. The shell applies those effects before queue hand-off.
    const startedAt = Date.now()
    for (const r of requests) requestStartedAt.set(r.id, startedAt)
    traceBackground('queue-started', {
      elapsedMs: startedAt - requestReceivedAt,
      detail: `${requests.length} request(s), concurrency ${settings.downloadConcurrency}`,
    })
    const startFx = decideQueueStart({
      metrics: live,
      requests,
      mediaById,
      settings,
      startedAt,
      ...(sweep ? { sweep } : {}),
      ...(clearExpect ? { clearExpect } : {}),
      ...(originTabId === undefined ? {} : { originTabId }),
    })
    live = yield* Effect.promise(() =>
      applyQueueStartEffects(startFx, startedAt, {
        resetCorrelation: () => requestIdByDownloadId.clear(),
        setMetrics: (metrics) => {
          live = metrics
        },
        persistSnapshot,
        recordSync: (events) => recordSync(settings, events),
        recordHistory: (actions) => recordHistory(settings, actions),
        recordUploads: (uploadItems) =>
          recordCloudUploads(
            settings,
            uploadItems.map(({ item, filename }) => ({
              item: { id: item.id, url: item.url, handle: item.author, ext: item.ext },
              filename,
            })),
          ),
        seedClear: clearSession.seedLedger,
      }),
    )

    const res = yield* queue.enqueue(requests)

    // Reconcile precise per-request outcomes: browser transfers go in-flight
    // (tracked by downloadId for the onChanged/search loop), aria2 hand-offs are
    // terminal from our side, and failures-to-start are recorded failed.
    const now = Date.now()
    const syncEvents: SyncEvent[] = []
    const historyActions: HistoryAction[] = []
    // Per-request start failures, WITH the strategy's own reason (a 403/network/
    // CDN error) — sent back in the reply so "why didn't this download?" is
    // answerable from the requesting tab's own console, not just the SW's.
    const failures: { itemId: string; reason: string }[] = [...urlFailures]
    // Terminal-at-enqueue outcomes (failed-to-start, aria2 hand-off) carry no
    // retry duty — no downloadId ever interrupts — so their retry meta is dead
    // the moment the outcome lands. Drop it here (and mirror below), or the
    // persisted record only ever shrinks via the browser settle path and grows
    // unbounded for non-browser strategies.
    let droppedMeta = false
    const applyEnqueueFx = (fx: EnqueueOutcomeEffects): void => {
      if (fx.syncEvent) syncEvents.push(fx.syncEvent)
      historyActions.push(fx.historyAction)
    }
    for (const o of res.outcomes) {
      const media = mediaById.get(o.id)
      if (!o.ok) {
        inFlight.delete(o.id)
        droppedMeta = requestMetaById.delete(o.id) || droppedMeta
        recordClearFailure(media?.postId, o.id)
        const outcome: TerminalOutcome = 'failed'
        live = recordOutcome(live, o.id, outcome, now)
        applyEnqueueFx(
          decideEnqueueOutcome({ id: o.id, outcome, now, deviceId: settings.cloudDeviceId }),
        )
        const reason = o.error ?? 'unknown'
        failures.push({ itemId: o.id, reason })
        traceBackground('start-failed', {
          itemId: o.id,
          elapsedMs: now - (requestStartedAt.get(o.id) ?? startedAt),
          detail: reason,
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
            ...(media?.postId ? { tweetId: media.postId } : {}),
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
        droppedMeta = requestMetaById.delete(o.id) || droppedMeta
        const outcome: TerminalOutcome = 'complete'
        live = recordOutcome(live, o.id, outcome, now)
        applyEnqueueFx(
          decideEnqueueOutcome({ id: o.id, outcome, now, deviceId: settings.cloudDeviceId }),
        )
        traceBackground('external-complete', {
          itemId: o.id,
          elapsedMs: now - (requestStartedAt.get(o.id) ?? startedAt),
          detail: o.handle ? `aria2 ${o.handle.gid}` : undefined,
        })
      }
    }
    if (droppedMeta) persistRequestMeta()
    recordSync(settings, syncEvents)
    recordHistory(settings, historyActions)
    persistTransfers()
    yield* Effect.promise(() => persistSnapshot(now))

    return {
      _tag: 'QueueUpdate' as const,
      completed: res.completed,
      total: res.total + urlFailures.length,
      skipped,
      ...(failures.length > 0 ? { failures } : {}),
    }
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
  const { queuedPosts, skipped } = await clearSession.enqueueSweep(scope, posts)
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
  persistRequestMeta()
  // Timer/row/attempt/mirror teardown is atomic inside the queue — no
  // cross-module iterate-then-clear invariant to keep in sync here anymore.
  retryQueue.cancelAll()
  transfersState = emptyTracker
  persistTransfers()
  await clearSession.reset()
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

// Typed message-router table. Each entry returns the value to send back; the
// listener pipes it to sendResponse and keeps the channel open. `handle` narrows
// the union member for the entry while keeping the table's value type uniform.
//
// SEAM INVARIANT: every content-script-visible handler here must reply a
// defined object on every code path — never legitimately resolve `undefined`.
// The router's own `.catch` below upholds this on the failure path too (it
// turns a rejection into `{ ok: false, ... }`, not a bare `undefined`). This is
// what lets the caller treat `reply === undefined` as uniquely meaning
// "unclaimed" (guard-dropped or decode-rejected) — see `expectReply` in
// `../core/messaging`, the caller-side half of this same invariant.
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
    const records = await captureDb.allRecords()
    const built = composeCaptureExport(records, msg.kind, msg.conversationId, Date.now())
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
  // Rehydrate the retry queue FIRST so its owned ids are populated before the
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
      const p = planConvexEnvSeed(
        s,
        {
          url: import.meta.env.WXT_CONVEX_URL as string | undefined,
          secret: import.meta.env.WXT_CONVEX_SECRET as string | undefined,
        },
        () => crypto.randomUUID(),
      )
      if (p) s = await setSettings(p)
    }
    if (isSyncConfigured(s)) outboxQueue.push(() => drainOutbox(s))
    // Dev convenience (ADR-0013): a gitignored `.env` may pre-seed the Cloud
    // Upload OAuth client IDs (public, not secrets). Gated on an empty field so a
    // user edit is never overridden; a normal build has neither var.
    const cloudPatch = planCloudEnvSeed(s, {
      gdriveClientId: import.meta.env.WXT_GDRIVE_CLIENT_ID as string | undefined,
      dropboxAppKey: import.meta.env.WXT_DROPBOX_APP_KEY as string | undefined,
    })
    if (cloudPatch) s = await setSettings(cloudPatch)
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
    if (alarm.name === syncOutbox.syncAlarm) {
      void (async () => {
        const settings = await getSettings()
        if (isSyncConfigured(settings)) outboxQueue.push(() => drainOutbox(settings))
      })().catch(queueError('syncAlarm'))
    }
  })
  browser.downloads.onChanged.addListener((delta) => void onDownloadChanged(delta))

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Returning `false` here without calling `sendResponse` is a GUARD DROP, not a
    // reply: Chrome resolves the sender's `safeSend` with `{status: 'ok', reply:
    // undefined}` — structurally identical to a handler that legitimately replied
    // with nothing. Two shipped incidents had exactly this signature (a missing
    // CONTENT_SCRIPT_TAGS entry, then a missing sender-guard origin) and were only
    // diagnosed live in a browser. Warn on every dropped tag — not just Capture
    // ones — so the next hole is visible in the SW console instead. See
    // `expectReply` in `../core/messaging` for the caller-side half of this
    // invariant.
    const decoded = Schema.decodeUnknownResult(Message)(message)
    if (Result.isFailure(decoded)) {
      const rawTag = (message as { _tag?: unknown } | null)?._tag
      if (typeof rawTag === 'string')
        console.warn(`[XMD] message ${rawTag} FAILED schema decode (dropped):`, decoded.failure)
      return false
    }
    const msg = decoded.success
    // Sender authorization: drop anything from another extension, an off-origin
    // content script, or a content script reaching for a UI-only tag — before
    // any download / OAuth / cloud-egress / clear handler runs.
    if (!isMessageAllowed(msg._tag, sender, browser.runtime.id)) {
      console.warn(
        `[XMD] message ${msg._tag} BLOCKED by sender guard (contentScript=${sender?.tab !== undefined && sender?.tab !== null})`,
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
