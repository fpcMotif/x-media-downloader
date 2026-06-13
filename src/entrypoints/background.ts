import { Effect, Result, Schema } from 'effect'
import { storage } from 'wxt/utils/storage'
import {
  Message,
  type DownloadTraceEntry,
  type MediaItem,
  type MetricsSnapshot,
  type Settings,
} from '../core/schema'
import { SettingsService, SettingsServiceLive, getSettings, watchSettings } from '../core/settings'
import { queuedEvent, outcomeEvent, type SyncEvent } from '../core/sync/events'
import {
  append,
  decodeOutbox,
  isReady,
  markDrained,
  markFailed,
  takeBatch,
} from '../core/sync/outbox'
import { makeConvexHttpPort } from '../core/sync/convex'
import {
  makeDirectStrategy,
  makeSchemeRoutingStrategy,
  type DownloadStrategy,
} from '../core/download/strategy'
import { makeAria2Strategy, makeAria2RpcPort } from '../core/download/aria2'
import { makeDownloadQueueCore } from '../core/download/queue'
import { planDownloads } from '../core/download/destination'
import {
  emptyMetrics,
  extendTotal,
  recordOutcome,
  recordSample,
  samplesFromSearch,
  outcomeFromState,
  snapshot,
  type MetricsState,
} from '../core/download/metrics'
import { decodeStore, emptyStore } from '../core/history/store'
import { planHistory, type HistoryAction } from '../core/history/wiring'

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

// Cloud Sync outbox (ADR-0009) — metadata-only events, durable until drained.
const outboxItem = storage.defineItem<unknown>('local:syncOutbox', { fallback: null })

// Outbox read-modify-writes are serialized through this chain: SW event
// handlers interleave, and a lost update could drop a drained marker. Re-sent
// batches are harmless regardless — eventIds are idempotent server-side.
let outboxChain: Promise<void> = Promise.resolve()
const withOutbox = (step: () => Promise<void>): void => {
  outboxChain = outboxChain.then(step).catch(() => {})
}

/** Drain FIFO until empty or the first failure; backoff state gates retries. */
const drainOutbox = async (settings: Settings): Promise<void> => {
  const port = makeConvexHttpPort({ deploymentUrl: settings.convexUrl, fetchImpl: fetch })
  // oxlint-disable no-await-in-loop -- FIFO: each batch depends on the previous outcome
  for (;;) {
    const state = decodeOutbox(await outboxItem.getValue())
    if (!isReady(state, Date.now())) return
    const batch = takeBatch(state)
    if (batch.length === 0) return
    try {
      await port.mutation('sync:recordEvents', {
        events: batch,
        ...(settings.convexSyncSecret ? { secret: settings.convexSyncSecret } : {}),
      })
      await outboxItem.setValue(
        markDrained(
          state,
          batch.map((e) => e.eventId),
        ),
      )
    } catch {
      await outboxItem.setValue(markFailed(state, Date.now()))
      return
    }
  }
  // oxlint-enable no-await-in-loop
}

/** Mirror state transitions when Cloud Sync is on. Fire-and-forget: downloads
 *  never block on — or fail because of — the cloud (ADR-0009). */
const recordSync = (settings: Settings, events: ReadonlyArray<SyncEvent>): void => {
  if (!settings.cloudSyncEnabled || settings.convexUrl === '' || events.length === 0) return
  withOutbox(async () => {
    await outboxItem.setValue(append(decodeOutbox(await outboxItem.getValue()), events))
    await drainOutbox(settings)
  })
}

// Durable local download history (opt-in `downloadHistoryEnabled`): the
// local-first twin of Convex `media_state`, fed from the SAME outcome points as
// the Sync Events above so the two never diverge. `local:` survives SW recycle.
const historyItem = storage.defineItem<unknown>('local:downloadHistory', { fallback: null })
let historyChain: Promise<void> = Promise.resolve()
// Serialized read-modify-write, like the outbox, so interleaved SW events can't
// lose an update. Gated by the toggle; orthogonal to Cloud Sync.
const recordHistory = (settings: Settings, actions: ReadonlyArray<HistoryAction>): void => {
  if (!settings.downloadHistoryEnabled || actions.length === 0) return
  historyChain = historyChain
    .then(async () => {
      let store = decodeStore(await historyItem.getValue())
      for (const a of actions) store = planHistory(store, settings, a)
      await historyItem.setValue(store)
    })
    .catch(() => {})
}

/** Pick the download strategy for the active settings (Direct default; aria2 opt-in). */
function chooseStrategy(settings: Settings): DownloadStrategy {
  const direct = makeDirectStrategy({ download: (opts) => browser.downloads.download(opts) })
  if (settings.downloadStrategy === 'aria2') {
    const port = makeAria2RpcPort({
      rpcUrl: settings.aria2RpcUrl,
      secret: settings.aria2Secret,
      fetchImpl: fetch,
    })
    // Sidecar data: URLs go to the browser even under aria2 (which can't fetch
    // them); they land in the browser download dir when aria2Dir points elsewhere.
    return makeSchemeRoutingStrategy(
      makeAria2Strategy(port, {
        split: settings.aria2Split,
        ...(settings.aria2Dir ? { dir: settings.aria2Dir } : {}),
      }),
      direct,
    )
  }
  // 'direct' (default) and 'fetched' (offscreen path not yet built) both go Direct.
  return direct
}

const handleDownload = (items: ReadonlyArray<MediaItem>) =>
  Effect.gen(function* () {
    const requestReceivedAt = Date.now()
    traceBackground('request-received', { detail: `${items.length} item(s)` })
    const svc = yield* SettingsService
    const settings = yield* svc.get
    const strategy = chooseStrategy(settings)
    const queue = makeDownloadQueueCore({ strategy, concurrency: settings.downloadConcurrency })
    const requests = items
      .flatMap((item) =>
        planDownloads({
          template: settings.filenameTemplate,
          item,
          sidecar: settings.sidecarMetadata,
        }),
      )
      .filter((r) => !inFlight.has(r.id))
    // Everything already in flight: report success without re-downloading.
    if (requests.length === 0) {
      traceBackground('request-deduped', { detail: 'all items already in flight' })
      yield* Effect.promise(() => persistSnapshot(Date.now()))
      return { _tag: 'QueueUpdate' as const, completed: 0, total: 0 }
    }
    for (const r of requests) inFlight.add(r.id)

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
    const mediaById = new Map(items.map((i) => [i.id, i]))
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

    const res = yield* queue.enqueue(requests)

    // Reconcile precise per-request outcomes: browser transfers go in-flight
    // (tracked by downloadId for the onChanged/search loop), aria2 hand-offs are
    // terminal from our side, and failures-to-start are recorded failed.
    const now = Date.now()
    const syncEvents: SyncEvent[] = []
    const historyActions: HistoryAction[] = []
    for (const o of res.outcomes) {
      if (!o.ok) {
        inFlight.delete(o.id)
        live = recordOutcome(live, o.id, 'failed', now)
        syncEvents.push(outcomeEvent(o.id, 'failed', settings.cloudDeviceId, now))
        historyActions.push({ kind: 'failed', requestId: o.id, at: now })
        traceBackground('start-failed', {
          itemId: o.id,
          elapsedMs: now - (requestStartedAt.get(o.id) ?? startedAt),
        })
      } else if (o.handle?.kind === 'browser') {
        requestIdByDownloadId.set(o.handle.id, o.id)
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
    yield* Effect.promise(() => persistSnapshot(now))

    return { _tag: 'QueueUpdate' as const, completed: res.completed, total: res.total }
  }).pipe(Effect.provide(SettingsServiceLive))

export default defineBackground(() => {
  // Cloud Sync reconciliation: drain anything left over from a previous SW
  // life / offline period; clear the outbox whenever the user turns sync off.
  void (async () => {
    const s = await getSettings()
    if (s.cloudSyncEnabled && s.convexUrl !== '') withOutbox(() => drainOutbox(s))
  })()
  watchSettings((s) => {
    if (!s.cloudSyncEnabled) withOutbox(() => outboxItem.setValue(null))
  })

  // Listeners registered synchronously at the top of main() (grounding §b).
  browser.downloads.onChanged.addListener((delta) => {
    const id = requestIdByDownloadId.get(delta.id)
    if (id === undefined || !live) return
    void (async () => {
      const now = Date.now()
      // Byte progress is not in onChanged (§d) — pull it from search.
      try {
        const rows = await browser.downloads.search({ id: delta.id })
        for (const sample of samplesFromSearch(rows, requestIdByDownloadId, now)) {
          if (live) live = recordSample(live, sample)
        }
      } catch {
        /* the record may be gone; ignore */
      }
      const outcome = outcomeFromState(delta.state?.current)
      if (outcome) {
        inFlight.delete(id)
        if (live) live = recordOutcome(live, id, outcome, now)
        const settings = await getSettings()
        recordSync(settings, [
          outcomeEvent(
            id,
            outcome === 'complete' ? 'completed' : 'failed',
            settings.cloudDeviceId,
            now,
          ),
        ])
        recordHistory(settings, [
          { kind: outcome === 'complete' ? 'completed' : 'failed', requestId: id, at: now },
        ])
        traceBackground(outcome === 'complete' ? 'browser-complete' : 'browser-failed', {
          itemId: id,
          elapsedMs: now - (requestStartedAt.get(id) ?? now),
          detail: `downloadId ${delta.id}`,
        })
        requestStartedAt.delete(id)
      }
      await persistSnapshot(now)
    })()
  })

  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const decoded = Schema.decodeUnknownResult(Message)(message)
    if (Result.isFailure(decoded)) return false
    const msg = decoded.success
    if (msg._tag === 'DownloadRequest') {
      void Effect.runPromise(handleDownload(msg.items)).then(sendResponse)
      return true // keep the channel open for the async reply
    }
    if (msg._tag === 'MetricsRequest') {
      void metricsItem.getValue().then((snap) => sendResponse(snap ?? currentSnapshot(Date.now())))
      return true
    }
    if (msg._tag === 'DownloadTraceEvent') {
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
      void persistSnapshot(Date.now()).then(() => sendResponse({ ok: true }))
      return true
    }
    if (msg._tag === 'ClearDownloadMonitorRequest') {
      void (async () => {
        const snap = (await metricsItem.getValue()) ?? ZERO_SNAPSHOT
        if (snap.active > 0) {
          sendResponse({
            _tag: 'ClearDownloadMonitorResponse',
            ok: false,
            active: snap.active,
            clearedMetrics: false,
            clearedLocks: 0,
            reason: 'active-downloads',
          })
          return
        }
        const clearedLocks = inFlight.size
        inFlight.clear()
        requestIdByDownloadId.clear()
        requestStartedAt.clear()
        traceEvents = []
        live = null
        await metricsItem.setValue(null)
        sendResponse({
          _tag: 'ClearDownloadMonitorResponse',
          ok: true,
          active: 0,
          clearedMetrics: true,
          clearedLocks,
        })
      })()
      return true
    }
    if (msg._tag === 'HistoryRequest') {
      void historyItem.getValue().then((raw) => sendResponse({ records: decodeStore(raw).records }))
      return true
    }
    if (msg._tag === 'ClearHistoryRequest') {
      void historyItem.setValue(emptyStore).then(() => sendResponse({ ok: true }))
      return true
    }
    return false
  })
})
