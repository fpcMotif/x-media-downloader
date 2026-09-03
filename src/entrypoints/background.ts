import { Effect, Option, Result, Schema } from 'effect'
import { storage } from 'wxt/utils/storage'
import {
  Message,
  type DownloadTraceEntry,
  type MediaItem,
  type MetricsSnapshot,
  type Settings,
} from '@/packages/schema'
import {
  SettingsService,
  SettingsServiceLive,
  getSettings,
  setSettings,
  watchSettings,
} from '@/packages/settings'
import { planConvexEnvSeed, planCloudEnvSeed } from '@/packages/settings/env-seed'
import type { SyncEvent } from '@/packages/sync/events'
import { makeConvexHttpPort, queryDownloadedAmong } from '@/packages/sync/convex'
import { makeSavedIndex, type QueryConvex } from '@/packages/sync/saved-index'
import {
  partitionAllowedMediaItems,
  assertAllowedMediaUrl,
  UnsafeUrlError,
} from '@/packages/sync/url-guard'
import { refreshMediaUrlFromTabs } from '@/packages/download/media-url-refresh'
import {
  makeDirectStrategy,
  makeSchemeRoutingStrategy,
  type DownloadStrategy,
} from '@/packages/download/strategy'
import { makeAria2Strategy, makeAria2RpcPort } from '@/packages/download/aria2'
import { makeFetchServiceLive } from '@/packages/kernel/fetch-service'
import {
  makeFetchedStrategy,
  makeFetchPort,
  makeOffscreenPort,
  makePermissionsPort,
} from '@/packages/download/fetched-strategy'
import { makeDownloadQueueCore } from '@/packages/download/queue'
import { makeSerialQueue } from '@/packages/kernel/serial-queue'
import { isMessageAllowed } from '@/packages/kernel/sender-guard'
import { planDownloads, partitionUsableIds } from '@/packages/download/destination'
import { makeSizeProbe } from '@/packages/download/size-probe'
import { type BudgetRecord } from '@/packages/download/daily-budget'
import { type SkipReason } from '@/packages/download/admission'
import { bindFetch } from '@/packages/kernel/fetch'
import {
  recordRetry,
  recordSample,
  samplesFromSearch,
  snapshot,
  type MetricsState,
} from '@/packages/download/metrics'
import { decideQueueStart } from '@/packages/download/queue-start'
import type { PendingInterruptRetry } from '@/packages/download/interrupt-retry'
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
} from '@/packages/download/transfer-tracker'
import {
  decideEnqueueOutcome,
  decideTerminalOutcome,
  type TerminalOutcome,
} from '@/packages/download/terminal-outcome'
import {
  decodeRequestMetaStore,
  emptyRequestMetaStore,
  planMetaReconcile,
  type PersistedRequestMeta,
} from '@/packages/download/request-meta'
import { decodeStore, emptyStore } from '@/packages/history/store'
import { planHistory, type HistoryAction } from '@/packages/history/wiring'
import { type Scope } from '@/packages/clear/ledger'
import {
  isReleaseDiagnosticsEvent,
  appendManyReleaseDiagnostics,
  decodeReleaseDiagnostics,
  composeDiagnosticsExport,
  type ReleaseDiagnosticsLog,
} from '@/packages/clear/diagnostics'
import {
  computeReleaseCorrelationCounters,
  correlateMutation,
  EMPTY_CORRELATION_STATE,
  formatCorrelationVerdict,
  parseClearResolveEvent,
  parseMutationEvent,
  recordResolve,
  type CorrelationState,
} from '@/packages/clear/correlate'
import { runSerializedRmw } from '@/packages/kernel/durable-store'
import type {
  ClearDownloadMonitorResponse,
  ClearScope,
  JsonValue,
  SweepEnqueueResponse,
} from '@/packages/schema'
import { isSyncConfigured } from '../background/sync-config'
import { makeTabBroadcaster } from '../background/tab-broadcaster'
import { makeSyncOutbox } from '../background/sync-outbox'
import { makeCloudUpload } from '../background/cloud-upload'
import { makeSavedStatusCoordinator } from '../background/saved-status'
import { makeAdmissionGate } from '../background/admission-gate'
import { makeDailyBudgetStore } from '../background/daily-budget-store'
import { makeClearSession } from '../background/clear-session'
import { applyQueueStartEffects } from '../background/queue-start-applier'
import { applyEnqueueOutcomeEffects, applyOutcomeEffects } from '../background/outcome-effects'
import { makeRetryQueue } from '@/packages/download/retry-queue'
import { makeCaptureDb } from '../background/capture-db'
import { makeCaptureOutbox } from '../background/capture-outbox'
import {
  emptyCaptureSummary,
  finishCaptureSummary,
  foldCaptureSummary,
} from '@/packages/capture/store'
import { composeCaptureExport } from '@/packages/capture/build-export'

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
// `JsonValue` + `decodeRequestMetaStore` at every read (mirrors `historyItem`'s
// `decodeStore` pattern) — a corrupt/foreign value never throws, it decodes empty.
const requestMetaItem = storage.defineItem<JsonValue>('session:requestMeta', {
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
// `trace` is a lazy arrow, not a direct `traceBackground` reference: this constructs
// first (above), so naming the function here would be a TDZ error. The arrow only runs
// once a clear is dispatched. Without this sink, `sendClearToTabs`'s four distinct
// failure worlds — no X tab, orphaned content script, a background tab answering
// instead of the user's, and a mounted all-noop answer — all reach the log as the same
// `bookmark:fail`, which is the single most common false diagnosis on this path.
const tabBroadcaster = makeTabBroadcaster(undefined, {
  trace: (stage, detail, tweetId) =>
    traceBackground(stage, { detail, ...(tweetId === undefined ? {} : { tweetId }) }),
})
const { reportTransferOutcome, sendClearToTabs, resolveTabListScope } = tabBroadcaster

/** Re-resolve a CDN url from an open tab before an interrupt retry. Despite the
 *  name (a holdover from the X-only original), this asks whichever open tab's
 *  content script answers first — X, Instagram, or Threads — via the shared
 *  `RefreshMediaUrlRequest` handler (`handleRefreshMediaUrl`). Meta's CDN urls
 *  are believed to expire far faster than X's (unconfirmed — no live TTL
 *  measurement exists yet), which makes a refresh MISS here the prime suspect
 *  for "an interrupted Threads/Instagram download just keeps failing": every
 *  retry attempt silently re-uses the same already-401/403'd `meta.url`, with
 *  no visible difference from a retry that legitimately found nothing better.
 *  `traceBackground` here is the one thing that tells the two apart live. */
const resolveRetryUrl = async (meta: RequestMeta): Promise<string> => {
  if (meta.item === undefined) return meta.url
  const fresh = await refreshMediaUrlFromTabs(meta.item, tabBroadcaster.makeTabMessagingPort())
  traceBackground(fresh ? 'retry-url-refreshed' : 'retry-url-refresh-miss', {
    itemId: meta.item.id,
    type: meta.item.type,
    ...(fresh ? {} : { detail: 'no open tab returned a fresher url — reusing the stale one' }),
  })
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

// Mutation↔clear correlation (spec #59 ticket #65): ephemeral, in-memory, like
// `traceEvents` above — the recent-resolve table only needs to survive the
// correlation window, not a service-worker restart (see correlate.ts's docstring
// on that tradeoff).
let correlationState: CorrelationState = EMPTY_CORRELATION_STATE

function recordTrace(event: DownloadTraceEntry): void {
  traceEvents = [...traceEvents, event].slice(-MAX_TRACE_EVENTS)
  // Correlate BEFORE the label/buffer work below so a verdict's own emitted event
  // (via the recursive `recordTrace` call inside `traceBackground`) lands in the
  // durable log and session ring in the same relative order a live reader expects:
  // the resolve, then the mutation, then (immediately) the correlation verdict.
  const resolveEvent = parseClearResolveEvent(event)
  if (resolveEvent) correlationState = recordResolve(correlationState, resolveEvent, Date.now())
  const mutationEvent = parseMutationEvent(event)
  if (mutationEvent) {
    const verdict = correlateMutation(correlationState, mutationEvent)
    if (verdict) {
      const { stage, detail } = formatCorrelationVerdict(verdict)
      traceBackground(stage, { tweetId: mutationEvent.tweetId, detail })
    }
  }
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
  // Release diagnostics: mirror the subset of trace events belonging to a Release run
  // into the durable capped log — BUFFERED, never one write per event. `recordTrace`
  // runs on EVERY download/clear trace event, so its synchronous callers must never be
  // delayed by a storage round-trip; and `runSerializedRmw` decodes + re-writes the
  // WHOLE log per call, so at the 1000-event cap a 50-post Bookmarks run (~600 events)
  // would do ~600 full-array round-trips of quadratic total work, all queued ahead of
  // the settle path that shares this worker.
  if (isReleaseDiagnosticsEvent(event)) bufferReleaseDiagnostics(event)
}

// A trailing flush window long enough to fold a burst into one write, short enough
// that an SW recycle loses at most this much of the tail.
const RELEASE_DIAGNOSTICS_FLUSH_MS = 250
// Hard flush ceiling: bounds BOTH the loss window and the per-write array size, so a
// dense burst can't sit un-persisted just because events keep arriving.
const RELEASE_DIAGNOSTICS_FLUSH_AT = 32

let releaseDiagnosticsBuffer: DownloadTraceEntry[] = []
let releaseDiagnosticsFlushTimer: ReturnType<typeof setTimeout> | undefined

// The popup's Release summary (ticket #66) is polled every 1-3s
// (POLL_ACTIVE_MS/POLL_IDLE_MS) alongside the UNRELATED, latency-sensitive download
// snapshot — memoized so a quiet popup (nothing new to report) never pays for a
// flush + full log decode on every poll. Invalidated the instant a NEW
// release-diagnostics event is buffered (below); recomputed lazily on the next
// `releaseDiagnosticsSummary()` call, never eagerly.
let releaseDiagnosticsSummaryCache: MetricsSnapshot['releaseDiagnostics']
let releaseDiagnosticsSummaryDirty = true

/** Turns `{ prop?: T | undefined }` into `{ prop?: T }` — same optionality, minus the
 *  explicit `undefined` `exactOptionalPropertyTypes` bakes into every Effect Schema
 *  `.Type` with an optional field (`Schema.optional`). That explicit `undefined` is
 *  what trips `JsonValue`'s index-signature check below, even though the real JSON
 *  shape (an omitted key) is fine either way — a genuinely-absent field and an
 *  `undefined`-valued field serialize identically. Paired with `toJsonValue` below,
 *  which does the matching RUNTIME drop (this type alone only makes the
 *  declaration compile; the value must actually lose the key too). */
type WithoutExplicitUndefined<T> = { [K in keyof T]: T[K] } extends infer O
  ? { [K in keyof O as undefined extends O[K] ? never : K]: O[K] } & {
      [K in keyof O as undefined extends O[K] ? K : never]?: Exclude<O[K], undefined>
    }
  : never

/** A Schema-derived domain value can carry Effect's `exactOptionalPropertyTypes`-
 *  widened optional fields, which fail `JsonValue`'s index-signature check even
 *  though the real JSON shape (an omitted key) is identical to an `undefined`-
 *  valued one. This round-trip is the real fix, not a relabeling: it drops any
 *  genuinely-`undefined`-valued key before the value reaches a `JsonValue`-typed
 *  boundary (durable storage), so the result really does satisfy the type the
 *  caller declares for it. Generic over the caller's own type — never `unknown`. */
const toJsonValue = <T, R extends JsonValue>(value: T & WithoutExplicitUndefined<T>): R =>
  JSON.parse(JSON.stringify(value))

/** Structural twin of `packages/clear/diagnostics.ts`'s `ReleaseDiagnosticsLog` — a
 *  plain `type` alias, not that module's `interface`, so `runSerializedRmw`'s
 *  `S extends JsonValue` constraint can be satisfied: TS never treats a named
 *  `interface` as satisfying an index-signature constraint regardless of its actual
 *  field types, but a structurally identical `type` does. */
type ReleaseDiagnosticsLogValue = {
  readonly events: ReadonlyArray<WithoutExplicitUndefined<DownloadTraceEntry>>
  readonly evicted: number
  readonly appended: number
  readonly decodeDropped: number
}

/** Drain the buffer into the durable log in ONE serialized read-modify-write.
 *  Awaitable so the export handler can flush before it reads — a user clicking
 *  "Export diagnostics" must never race the tail of their own Release run. */
const flushReleaseDiagnostics = async (): Promise<void> => {
  if (releaseDiagnosticsFlushTimer !== undefined) {
    clearTimeout(releaseDiagnosticsFlushTimer)
    releaseDiagnosticsFlushTimer = undefined
  }
  if (releaseDiagnosticsBuffer.length === 0) return
  // Detach the batch BEFORE awaiting: events arriving during the write belong to the
  // next flush, not this one, or they'd be dropped by the reassignment below.
  const batch = releaseDiagnosticsBuffer
  releaseDiagnosticsBuffer = []
  const toLogValue = (log: ReleaseDiagnosticsLog): ReleaseDiagnosticsLogValue => toJsonValue(log)
  await runSerializedRmw(
    releaseDiagnosticsQueue,
    {
      get: () => releaseDiagnosticsItem.getValue(),
      set: (v) => releaseDiagnosticsItem.setValue(v),
    },
    (raw) => toLogValue(decodeReleaseDiagnostics(raw)),
    (log) => toLogValue(appendManyReleaseDiagnostics(log, batch)),
  ).catch(queueError('release-diagnostics'))
}

const bufferReleaseDiagnostics = (event: DownloadTraceEntry): void => {
  releaseDiagnosticsBuffer = [...releaseDiagnosticsBuffer, event]
  releaseDiagnosticsSummaryDirty = true
  if (releaseDiagnosticsBuffer.length >= RELEASE_DIAGNOSTICS_FLUSH_AT) {
    void flushReleaseDiagnostics()
    return
  }
  if (releaseDiagnosticsFlushTimer !== undefined) return
  releaseDiagnosticsFlushTimer = setTimeout(() => {
    releaseDiagnosticsFlushTimer = undefined
    void flushReleaseDiagnostics()
  }, RELEASE_DIAGNOSTICS_FLUSH_MS)
}

/** The popup's Release summary (ticket #66): memoized (see
 *  `releaseDiagnosticsSummaryDirty` above) — a quiet popup poll with nothing new
 *  since the last call returns the cached value with ZERO storage I/O, adversarial-
 *  review finding: this used to flush + decode the whole durable log on every
 *  1-3s poll regardless of whether anything changed. On a cache miss it flushes
 *  first (so it reads the exact same durable state `ExportDiagnosticsRequest`
 *  would, and can never disagree with an export taken moments later), then derives
 *  counters via the SAME `computeReleaseCorrelationCounters` the export's meta line
 *  uses. `undefined` when every counter is zero — the field is `Schema.optional`,
 *  and the popup's zero-state must render exactly as it did before this ticket. */
const releaseDiagnosticsSummary = async (): Promise<MetricsSnapshot['releaseDiagnostics']> => {
  if (!releaseDiagnosticsSummaryDirty) return releaseDiagnosticsSummaryCache
  await flushReleaseDiagnostics()
  const log = await releaseDiagnosticsQueue.run(async () =>
    decodeReleaseDiagnostics(await releaseDiagnosticsItem.getValue()),
  )
  const counters = computeReleaseCorrelationCounters(log.events)
  const hasAny =
    counters.clears > 0 ||
    counters.mutations > 0 ||
    counters.serverRejects > 0 ||
    counters.reAddFingerprints > 0 ||
    counters.reappearances > 0
  releaseDiagnosticsSummaryCache = hasAny ? counters : undefined
  releaseDiagnosticsSummaryDirty = false
  return releaseDiagnosticsSummaryCache
}

const traceBackground = (
  stage: string,
  opts: Omit<DownloadTraceEntry, 'source' | 'stage' | 't'> = {},
): void => {
  recordTrace({ source: 'background', stage, t: Date.now(), ...opts })
}

const traceStageForSweep = (stage: string, sweep: { readonly scope: Scope } | undefined): string =>
  sweep === undefined ? stage : `clear-sweep-${stage}`

const redactTraceDetail = (detail: string): string =>
  detail.replace(/\bhttps?:\/\/\S+|blob:\S+/g, '[url]')

// The queue labels that belong to a Release run. Their failures must reach the DURABLE
// Release log, and a `queue:` stage satisfies NEITHER arm of `isReleaseDiagnosticsEvent`
// (source is 'background', and the stage doesn't start with 'clear-') — so they only
// ever reached the SW console, which is gone by the time a user exports. `clear-settle`
// matters most: its chain wraps the whole settle → decide → dispatch → resolve release,
// so a throw anywhere in the irreversible path was invisible in the export.
const RELEASE_QUEUE_LABELS = new Set(['clear', 'clear-settle', 'worklist', 'release-diagnostics'])

// One observable failure path for the serialized RMW queues below. These chains
// each used to end in `.catch(() => {})`, so a thrown drain (storage quota, a
// decode failure, an unexpected reducer throw) vanished. Now it leaves a trace
// instead. Observe-and-log only — never re-throw, or the chain would wedge.
const queueError =
  (label: string) =>
  // `makeSerialQueue`'s onError always normalizes to `Error` before calling this,
  // but the two direct `.catch(queueError(...))` sites (release-diagnostics flush,
  // the sync alarm IIFE) attach to a raw task promise that can reject with
  // anything JS lets you `throw` — `Error | string` keeps that path honest instead
  // of assuming every rejection is already an `Error`.
  (err: Error | string): void => {
    const detail = err instanceof Error ? err.message : err
    if (RELEASE_QUEUE_LABELS.has(label))
      traceBackground('clear-queue-error', {
        detail: `label=${label} reason=${redactTraceDetail(detail)}`,
      })
    else traceBackground(`queue:${label}`, { detail })
  }

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
const flushTransfers = (): Promise<void> =>
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
const historyItem = storage.defineItem<JsonValue>('local:downloadHistory', { fallback: null })
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
  dispatchClear: (tweetId, scopes, allLists, preferTabId, release) =>
    sendClearToTabs(tweetId, scopes, preferTabId, allLists, release),
  // Seed-time only: the pin the permalink release leg is judged against. The leg itself
  // never reads a tab url, so a mid-download navigation of the origin tab can no longer
  // re-aim an irreversible clear at a list the user never pressed Release for.
  resolveOriginScope: resolveTabListScope,
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

// Durable, capped log of Release (Likes/Bookmarks clear) trace events
// for post-hoc diagnostics. `local:` (not `session:`, unlike `metricsItem` above)
// because a bad Release run is exactly the kind of thing a user notices AFTER
// closing the browser — it must survive a full browser restart, not just an SW
// recycle. Ring-capped by `appendReleaseDiagnostics` (packages/clear/diagnostics.ts),
// so it can't grow unbounded over the extension's lifetime.
const releaseDiagnosticsItem = storage.defineItem<JsonValue>('local:releaseDiagnostics', {
  fallback: [],
})
const releaseDiagnosticsQueue = makeSerialQueue(queueError('release-diagnostics'))

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
  const tweetId = requestMetaById.get(id)?.item?.postId
  inFlight.delete(id)
  clearInterruptRetryState(id)
  requestIdByDownloadId.delete(downloadId)
  stopStuckPollIfIdle() // last download settled → let the watchdog go quiet
  // The terminal-outcome fan-out is ONE pure decision (packages/download/terminal-outcome):
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
    { ...(tweetId === undefined ? {} : { tweetId }), downloadId },
  )
  await applyOutcomeEffects(
    fx,
    {
      recordClearComplete,
      recordClearFailure,
      setTransfers: (next) => {
        transfersState = next
      },
      setMetrics: (next) => {
        live = next
      },
      flushTransfers,
      reportBacklink: (backlink) =>
        reportTransferOutcome(backlink.requestId, backlink.outcome, backlink.at),
      recordSync: (events) => recordSync(settings, events),
      recordHistory: (actions) => recordHistory(settings, actions),
      markPostSaved: savedStatusCoordinator.onCompleted,
      bumpBudget: (bytes, count) =>
        budgetQueue.push(() => budgetStore.recordCompletion(bytes, count)),
      markMediaSaved: savedMediaIndex.markSaved,
      persistSnapshot,
    },
    now,
  )
  traceBackground(outcome === 'complete' ? 'browser-complete' : 'browser-failed', {
    itemId: id,
    elapsedMs: now - (requestStartedAt.get(id) ?? now),
    detail: `downloadId ${downloadId}`,
  })
  requestStartedAt.delete(id)
}

const failBrowserDownload = (id: string, downloadId: number, now: number): Promise<void> =>
  settleBrowserDownload(id, downloadId, 'failed', now)

const completeBrowserDownload = (id: string, downloadId: number, now: number): Promise<void> =>
  settleBrowserDownload(id, downloadId, 'complete', now)

// Retry Scheduler shell (CONTEXT.md's Clock Port entry): the queue owns the
// whole interrupt-retry state machine — attempt counter, queue row, live timer,
// and the durable `session:interruptRetries` mirror move together behind its
// interface (packages/download/retry-queue). `fire` is a forward reference to
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
    traceBackground(traceStageForSweep('request-received', sweep), {
      detail: sweep ? `scope=${sweep.scope} items=${items.length}` : `${items.length} item(s)`,
    })
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
    // Second fail-closed boundary, on the id rather than the URL: every map
    // below is keyed by `item.id`, and `planDownloads` reserves `<id>.json` for
    // sidecars, so a page-supplied `.json` id or a repeat inside one batch would
    // cross-key `inFlight` / `requestMetaById` / transfers / history.
    const idChecked = partitionUsableIds(checked.allowed)
    const rejectFailures = [
      ...checked.rejected.map(({ itemId, reason }) => ({
        itemId,
        reason: `unsafe media URL: ${reason}`,
      })),
      ...idChecked.rejected.map(({ itemId, reason }) => ({
        itemId,
        reason: `unusable: ${reason}`,
      })),
    ]
    const admission = yield* Effect.promise(() => admissionGate.admit(idChecked.allowed))
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
    // A MIXED batch (e.g. Quick-Grab-all on a carousel where some slides are
    // already-saved duplicates) previously left its skip reasons invisible to
    // anyone watching only the background console: the all-skipped branch below
    // ('request-deduped') traces its own skip count, but a batch that still
    // schedules SOME requests fell straight through with no background-side
    // signal at all — the reasons only ever reached the tab's own console via
    // `QueueUpdate.skipped` → `reportSkipped` (index.tsx). Gated on
    // `requests.length > 0` so the all-skipped branch stays the sole source for
    // the zero-requests case (no double-trace of the same batch).
    if (skipped.length > 0 && requests.length > 0) {
      traceBackground('items-skipped', {
        detail: skipped.map((s) => `${s.count} ${s.reason}`).join(', '),
      })
    }
    // Nothing to schedule (all gate-skipped or already in flight): report with the
    // skip summary so the overlay can explain why nothing downloaded.
    if (requests.length === 0) {
      traceBackground(traceStageForSweep('request-deduped', sweep), {
        detail: sweep
          ? `scope=${sweep.scope} items=${items.length} admitted=${admission.admitted.length} skipped=${admission.skipped.length} rejected=${rejectFailures.length}`
          : `${admission.admitted.length} admitted, ${admission.skipped.length} skipped`,
      })
      yield* Effect.promise(() => persistSnapshot(Date.now()))
      return {
        _tag: 'QueueUpdate' as const,
        completed: 0,
        total: rejectFailures.length,
        skipped,
        ...(rejectFailures.length > 0 ? { failures: rejectFailures } : {}),
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
    traceBackground(traceStageForSweep('queue-started', sweep), {
      elapsedMs: startedAt - requestReceivedAt,
      detail: sweep
        ? `scope=${sweep.scope} requests=${requests.length} concurrency=${settings.downloadConcurrency}`
        : `${requests.length} request(s), concurrency ${settings.downloadConcurrency}`,
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
    const failures: { itemId: string; reason: string }[] = [...rejectFailures]
    // Terminal-at-enqueue outcomes (failed-to-start, aria2 hand-off) carry no
    // retry duty — no downloadId ever interrupts — so their retry meta is dead
    // the moment the outcome lands. Drop it here (and mirror below), or the
    // persisted record only ever shrinks via the browser settle path and grows
    // unbounded for non-browser strategies.
    let droppedMeta = false
    const enqueuePorts = {
      setMetrics: (next: MetricsState) => {
        live = next
      },
      recordSyncEvent: (event: SyncEvent) => syncEvents.push(event),
      recordHistoryAction: (action: HistoryAction) => historyActions.push(action),
      markPostSaved: savedStatusCoordinator.onCompleted,
      bumpBudget: (bytes: number, count: number) =>
        budgetQueue.push(() => budgetStore.recordCompletion(bytes, count)),
      markMediaSaved: savedMediaIndex.markSaved,
    }
    for (const o of res.outcomes) {
      const media = mediaById.get(o.id)
      if (!o.ok) {
        inFlight.delete(o.id)
        droppedMeta = requestMetaById.delete(o.id) || droppedMeta
        recordClearFailure(media?.postId, o.id)
        const outcome: TerminalOutcome = 'failed'
        applyEnqueueOutcomeEffects(
          decideEnqueueOutcome({
            metrics: live,
            id: o.id,
            outcome,
            now,
            deviceId: settings.cloudDeviceId,
            ...(media?.postId === undefined ? {} : { tweetId: media.postId }),
          }),
          enqueuePorts,
        )
        const reason = o.error ?? 'unknown'
        failures.push({ itemId: o.id, reason })
        traceBackground(traceStageForSweep('start-failed', sweep), {
          itemId: o.id,
          elapsedMs: now - (requestStartedAt.get(o.id) ?? startedAt),
          detail: sweep ? `scope=${sweep.scope} reason=${redactTraceDetail(reason)}` : reason,
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
        traceBackground(traceStageForSweep('browser-started', sweep), {
          itemId: o.id,
          elapsedMs: now - (requestStartedAt.get(o.id) ?? startedAt),
          detail: sweep
            ? `scope=${sweep.scope} downloadId=${o.handle.id}`
            : `downloadId ${o.handle.id}`,
        })
      } else {
        inFlight.delete(o.id)
        droppedMeta = requestMetaById.delete(o.id) || droppedMeta
        const outcome: TerminalOutcome = 'complete'
        applyEnqueueOutcomeEffects(
          decideEnqueueOutcome({
            metrics: live,
            id: o.id,
            outcome,
            now,
            deviceId: settings.cloudDeviceId,
            ...(media?.postId === undefined ? {} : { tweetId: media.postId }),
            bytes: admission.sizeById.get(o.id) ?? 0,
          }),
          enqueuePorts,
        )
        const externalCompleteDetail = sweep
          ? o.handle
            ? `scope=${sweep.scope} strategy=aria2 gid=${o.handle.gid}`
            : `scope=${sweep.scope} strategy=external`
          : o.handle
            ? `aria2 ${o.handle.gid}`
            : undefined
        traceBackground(traceStageForSweep('external-complete', sweep), {
          itemId: o.id,
          elapsedMs: now - (requestStartedAt.get(o.id) ?? startedAt),
          ...(externalCompleteDetail === undefined ? {} : { detail: externalCompleteDetail }),
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
      total: res.total + rejectFailures.length,
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
  // The list tab the sweep button was pressed on. Recorded as the clear's ORIGIN so the
  // fan-out tries the user's own tab FIRST (the same guarantee DownloadRequest already
  // gets), and so a permalink release can name the list the user consented to empty.
  originTabId?: number,
): Promise<SweepEnqueueResponse> => {
  const requestedItems = posts.reduce((total, post) => total + post.items.length, 0)
  traceBackground('clear-sweep-request', {
    detail: `scope=${scope} posts=${posts.length} items=${requestedItems}`,
  })

  let queuedPosts: { readonly items: ReadonlyArray<MediaItem> }[] = []
  let skipped = 0
  let skippedIds: string[] = []
  try {
    const enqueued = await clearSession.enqueueSweep(scope, posts)
    queuedPosts = enqueued.queuedPosts
    skipped = enqueued.skipped
    skippedIds = enqueued.skippedIds
  } catch (error) {
    traceBackground('clear-sweep-failed', {
      detail: `scope=${scope} phase=enqueue posts=${posts.length} items=${requestedItems} reason=${redactTraceDetail(error instanceof Error ? error.message : String(error))}`,
    })
    throw error
  }

  // Fire into the queue with the sweep's explicit list scope — handleDownload
  // seeds the clear ledger with origin 'sweep' (only this scope), independent of
  // the global clearOnSave/per-scope toggles, which the sweep never mutates.
  const items = queuedPosts.flatMap((p) => [...p.items])
  traceBackground('clear-sweep-candidates', {
    detail: `scope=${scope} posts=${queuedPosts.length} skipped=${skipped} items=${items.length}`,
  })
  // Name the ids the worklist skipped, once per run (not per post — the budget matters).
  // Cross-referenced against the overlay's own candidate id list, any id here that is
  // still mounted AND still a member of this list is direct proof that an earlier
  // Release reported a flip which never stuck: the post is latched 'cleared' durably
  // and will never be retried, which is exactly how "Release silently does nothing on
  // the second run" happens. Ids are numeric post ids, never post content.
  if (skippedIds.length > 0)
    traceBackground('clear-sweep-skipped', {
      detail: `scope=${scope} skipped=${skipped} ids=${skippedIds.join(',')}`,
    })
  if (items.length > 0)
    void Effect.runPromise(handleDownload(items, { scope }, undefined, originTabId)).catch(
      (error) => {
        traceBackground('clear-sweep-failed', {
          detail: `scope=${scope} phase=background posts=${queuedPosts.length} items=${items.length} reason=${redactTraceDetail(error instanceof Error ? error.message : String(error))}`,
        })
      },
    )
  traceBackground('clear-sweep-response', {
    detail: `scope=${scope} queued=${queuedPosts.length} skipped=${skipped} items=${items.length}`,
  })
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
const clearDownloadMonitor = async (): Promise<ClearDownloadMonitorResponse> => {
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
/** Not every `Message['_tag']` has an entry below (broadcast/UI-only tags are
 *  routed elsewhere), so the lookup below is by arbitrary key over a WIDER key
 *  union than the literal keys actually present. A plain object literal can't
 *  express that (indexing it by a tag absent from its own keys is a compile
 *  error, and annotating the binding with a `Partial<Record<...>>` dictionary
 *  type to allow it is its own anti-slop finding: it discards the known,
 *  per-tag return-type evidence `satisfies` would otherwise keep). A `Map` is
 *  the shape built for exactly this: keyed by the full tag union, looked up
 *  with `.get`, no dictionary-typed binding required. */
type MessageHandlerFn = (msg: Message, sender: MsgSender) => Promise<JsonValue>
const handle =
  <T extends Message['_tag']>(
    fn: (msg: Extract<Message, { _tag: T }>, sender: MsgSender) => Promise<JsonValue>,
  ) =>
  (msg: Message, sender: MsgSender): Promise<JsonValue> => {
    // SAFETY: The type parameter T is bound to Message['_tag'], so Extract<Message, { _tag: T }>
    // narrows msg to the specific message type with that tag. The assertion is sound.
    return fn(msg as Extract<Message, { _tag: T }>, sender)
  }

const messageHandlers = new Map<Message['_tag'], MessageHandlerFn>([
  [
    'DownloadRequest',
    handle<'DownloadRequest'>((msg, sender) =>
      Effect.runPromise(handleDownload(msg.items, undefined, msg.clearExpect, sender.tab?.id)),
    ),
  ],
  [
    'MetricsRequest',
    async () => {
      const base = (await metricsItem.getValue()) ?? currentSnapshot(Date.now())
      const releaseDiagnostics = await releaseDiagnosticsSummary()
      return releaseDiagnostics === undefined ? base : { ...base, releaseDiagnostics }
    },
  ],
  // NOTE: this projection is an allowlist — a field added to `traceFields` but NOT
  // added here is silently dropped for every content-script event. `tabId` is taken
  // from `sender`, never from `msg`, so the page can't forge it (and the popup/options
  // legs, which have no `sender.tab`, simply omit it).
  [
    'DownloadTraceEvent',
    handle<'DownloadTraceEvent'>(async (msg, sender) => {
      recordTrace({
        source: msg.source,
        stage: msg.stage,
        t: msg.t,
        ...(msg.itemId !== undefined ? { itemId: msg.itemId } : {}),
        ...(msg.tweetId !== undefined ? { tweetId: msg.tweetId } : {}),
        ...(msg.type !== undefined ? { type: msg.type } : {}),
        ...(msg.elapsedMs !== undefined ? { elapsedMs: msg.elapsedMs } : {}),
        ...(msg.detail !== undefined ? { detail: msg.detail } : {}),
        ...(sender.tab?.id !== undefined ? { tabId: sender.tab.id } : {}),
      })
      await persistSnapshot(Date.now())
      return { ok: true }
    }),
  ],
  ['ClearDownloadMonitorRequest', () => clearDownloadMonitor()],
  // Both of these go through `historyQueue`, like `recordHistory` — reading or
  // erasing outside it races the queued read-modify-write. A `recordHistory`
  // task that already read the store, then an erase, then that task's write:
  // the erased records come back. The read is queued for the weaker reason —
  // otherwise the popup can render a store that a queued write is about to
  // replace.
  [
    'HistoryRequest',
    () =>
      historyQueue.run(async () => ({
        records: decodeStore(await historyItem.getValue()).records,
      })),
  ],
  ['SavedStatusRequest', handle<'SavedStatusRequest'>((msg) => savedStatusCoordinator.handle(msg))],
  [
    'ClearHistoryRequest',
    () =>
      historyQueue.run(async () => {
        await historyItem.setValue(emptyStore)
        return { ok: true } as const
      }),
  ],
  ['SyncTestRequest', async () => runSyncConnectionTest(await getSettings())],
  ['SyncStatusRequest', () => syncOutbox.getSyncStatus()],
  [
    'CloudConnectRequest',
    handle<'CloudConnectRequest'>((msg) => cloudUpload.runOAuthConnect(msg.provider, msg.clientId)),
  ],
  [
    'CloudDisconnectRequest',
    handle<'CloudDisconnectRequest'>((msg) => cloudUpload.disconnectProvider(msg.provider)),
  ],
  ['CloudStatusRequest', () => cloudUpload.cloudUploadStatus()],
  ['CloudRetryRequest', () => cloudUpload.retryDeadUploads()],
  ['CloudBackfillRequest', () => cloudUpload.backfillCloudUploads()],
  [
    'SweepEnqueueRequest',
    handle<'SweepEnqueueRequest'>((msg, sender) =>
      handleSweepEnqueue(msg.scope, msg.posts, sender.tab?.id),
    ),
  ],
  // Recover an un-teed tweet's media via the syndication endpoint (videos the
  // DOM can't expose). Reply with the raw body; the content script parses it.
  [
    'RecoverTweetMediaRequest',
    handle<'RecoverTweetMediaRequest'>(async (msg) => {
      const body = await recoverSyndicationBody(msg.tweetId)
      return { _tag: 'RecoverTweetMediaResponse', ...(body !== null ? { body } : {}) }
    }),
  ],
  // Knowledge Capture (spec §8/§9/§10/§12). The dispatcher persists the batch to
  // the durable IndexedDB store (source of truth), then offers it to the opt-in
  // Convex mirror fire-and-forget — `mirrorCaptures` gates internally and never
  // affects the `{ stored }` reply.
  [
    'CaptureTweets',
    handle<'CaptureTweets'>(async (msg) => {
      await captureDb.putRecords(msg.records)
      const total = await captureDb.count()
      console.info(`[XMD] capture received ${msg.records.length} record(s); store total=${total}`)
      captureOutbox.mirrorCaptures(msg.records)
      return { stored: msg.records.length }
    }),
  ],
  // Streams the store through a cursor fold — the harvest can be tens of
  // thousands of records, and `getAll()` materialized every one of them in SW
  // memory on each popup open just to compute three aggregates.
  [
    'CaptureSummaryRequest',
    handle<'CaptureSummaryRequest'>(async (msg) =>
      finishCaptureSummary(
        await captureDb.fold(emptyCaptureSummary(), foldCaptureSummary),
        msg.limit ?? captureRecentLimit,
      ),
    ),
  ],
  [
    'ExportCaptureRequest',
    handle<'ExportCaptureRequest'>(async (msg) => {
      const records = await captureDb.allRecords()
      const built = composeCaptureExport(records, msg.kind, msg.conversationId, Date.now())
      if (built === null) return { ok: false, filename: '', text: '' }
      console.info(
        `[XMD] capture export ${msg.kind} → ${built.filename} (${built.text.length} bytes)`,
      )
      return { ok: true, filename: built.filename, text: built.text }
    }),
  ],
  [
    'ClearCaptureRequest',
    async () => {
      const cleared = await captureDb.count()
      await captureDb.clear()
      return { cleared }
    },
  ],
  // Build the Release diagnostics export from the durable capped log
  // (mirrors ExportCaptureRequest's SW-builds/options-page-downloads split above).
  [
    'ExportDiagnosticsRequest',
    handle<'ExportDiagnosticsRequest'>(async () => {
      // Flush the trailing buffer FIRST — otherwise the export silently omits the last
      // few hundred ms of the run, which is exactly where a failing Release ends.
      await flushReleaseDiagnostics()
      const log = await releaseDiagnosticsQueue.run(async () =>
        decodeReleaseDiagnostics(await releaseDiagnosticsItem.getValue()),
      )
      return composeDiagnosticsExport(log, Date.now())
    }),
  ],
  // Release diagnostics (spec #59 ticket #63): one observed bookmark/like mutation,
  // already re-validated by the overlay before it ever reached this message (the
  // content script only sends this tag while `releaseMutationDiagnosticsEnabled`
  // is on). `traceBackground` gives it the `clear-` stage prefix that admits it
  // into the durable Release diagnostics log via `isReleaseDiagnosticsEvent`,
  // exactly like every other Release trace line — no separate storage, no
  // separate export path.
  [
    'ReleaseMutationEvent',
    handle<'ReleaseMutationEvent'>(async (msg) => {
      traceBackground('clear-mutation', {
        ...(msg.tweetId !== undefined ? { tweetId: msg.tweetId } : {}),
        detail: `op=${msg.op} status=${msg.status} error=${msg.error}`,
      })
      return { _tag: 'ReleaseMutationAck' }
    }),
  ],
])

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
          url: import.meta.env.WXT_CONVEX_URL,
          secret: import.meta.env.WXT_CONVEX_SECRET,
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
      gdriveClientId: import.meta.env.WXT_GDRIVE_CLIENT_ID,
      dropboxAppKey: import.meta.env.WXT_DROPBOX_APP_KEY,
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
      // Best-effort re-decode against a minimal shape, purely to name the tag in
      // the warning below — `message` already failed the real `Message` decode
      // above, so this can't (and doesn't need to) recover a domain type from it.
      const tagOnly = Schema.decodeUnknownResult(Schema.Struct({ _tag: Schema.String }))(message)
      if (Result.isSuccess(tagOnly))
        console.warn(
          `[XMD] message ${tagOnly.success._tag} FAILED schema decode (dropped):`,
          decoded.failure,
        )
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
    const h = messageHandlers.get(msg._tag)
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
