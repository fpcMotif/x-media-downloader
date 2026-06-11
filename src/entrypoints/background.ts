import { Effect, Result, Schema } from 'effect'
import { storage } from 'wxt/utils/storage'
import {
  Message,
  type ArchiveRequest,
  type ArchiveTweetResult,
  type MediaItem,
  type MetricsSnapshot,
  type Settings,
} from '../core/schema'
import { SettingsService, SettingsServiceLive } from '../core/settings'
import {
  makeDirectStrategy,
  makeSchemeRoutingStrategy,
  type DownloadStrategy,
} from '../core/download/strategy'
import { makeAria2Strategy, makeAria2RpcPort } from '../core/download/aria2'
import { makeDownloadQueueCore } from '../core/download/queue'
import { planDownloads, type PlannedDownload } from '../core/download/destination'
import { makeSessionId } from '../core/archive/record'
import {
  coerceIndex,
  markArchived,
  planArchive,
  sessionManifestDownload,
} from '../core/archive/plan'
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

// Live monitoring accumulator. In-SW memory: best-effort and resets on SW
// recycle; the persisted snapshot is the popup's source of truth. Rehydrating
// the full accumulator across a recycle is the remaining work (ADR-0008).
let live: MetricsState | null = null
const requestIdByDownloadId = new Map<number, string>()

// In-flight request ids. A duplicate id (Quick Grab + '⬇ tweet' overlapping on
// the same item) would download twice and corrupt the accumulator: extendTotal
// counts both, the idempotent recordOutcome counts one, and `completed` can
// never reach `total`. Duplicates are dropped while the original is in flight.
const inFlight = new Set<string>()

const persistSnapshot = (now: number): Promise<void> =>
  live ? metricsItem.setValue(snapshot(live, now)) : Promise.resolve()

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

/**
 * Run planned downloads through the queue with in-flight de-duplication and
 * monitoring (the core both DownloadRequest and ArchiveRequest share). Returns
 * the per-request start outcomes of the requests that were NOT already in
 * flight — callers must treat a missing outcome as "being handled elsewhere".
 */
const runRequests = (planned: ReadonlyArray<PlannedDownload>, settings: Settings) =>
  Effect.gen(function* () {
    const strategy = chooseStrategy(settings)
    const queue = makeDownloadQueueCore({ strategy, concurrency: settings.downloadConcurrency })
    const requests = planned.filter((r) => !inFlight.has(r.id))
    // Everything already in flight: report success without re-downloading.
    if (requests.length === 0) return { completed: 0, total: 0, outcomes: [] }
    for (const r of requests) inFlight.add(r.id)

    // Seed monitoring (B). If a prior batch is still in flight, EXTEND its
    // accumulator (and keep the downloadId map) so the monitor reflects both;
    // only start fresh once everything has settled (D1).
    const startedAt = Date.now()
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

    const res = yield* queue.enqueue(requests)

    // Reconcile precise per-request outcomes: browser transfers go in-flight
    // (tracked by downloadId for the onChanged/search loop), aria2 hand-offs are
    // terminal from our side, and failures-to-start are recorded failed.
    const now = Date.now()
    for (const o of res.outcomes) {
      if (!o.ok) {
        inFlight.delete(o.id)
        live = recordOutcome(live, o.id, 'failed', now)
      } else if (o.handle?.kind === 'browser') {
        requestIdByDownloadId.set(o.handle.id, o.id)
        live = recordSample(live, { id: o.id, bytesReceived: 0, totalBytes: -1, t: now })
      } else {
        inFlight.delete(o.id)
        live = recordOutcome(live, o.id, 'complete', now)
      }
    }
    yield* Effect.promise(() => persistSnapshot(now))

    return { completed: res.completed, total: res.total, outcomes: res.outcomes }
  })

const handleDownload = (items: ReadonlyArray<MediaItem>) =>
  Effect.gen(function* () {
    const svc = yield* SettingsService
    const settings = yield* svc.get
    const planned = items.flatMap((item) =>
      planDownloads({
        template: settings.filenameTemplate,
        item,
        sidecar: settings.sidecarMetadata,
      }),
    )
    const res = yield* runRequests(planned, settings)
    return { _tag: 'QueueUpdate' as const, completed: res.completed, total: res.total }
  }).pipe(Effect.provide(SettingsServiceLive))

// Durable record of archived tweet ids — the cross-session idempotency cut for
// the Bookmarks & Likes archive (ADR-0009 revisits ADR-0005's "no history" for
// this: ids + timestamps only, no captured content). Single-writer: this SW.
const archiveIndexItem = storage.defineItem<unknown>('local:archiveIndex', { fallback: {} })

/**
 * One archive run: download every not-yet-archived tweet's media plus its
 * `.tweet.json` history record, mark the successes in the durable index, and
 * write a session manifest recording what the run did. `ok` per tweet means
 * every download STARTED (the same honesty bar as QueueUpdate) — the caller
 * gates bookmark/like removal on it.
 */
const handleArchive = (req: ArchiveRequest) =>
  Effect.gen(function* () {
    const svc = yield* SettingsService
    const settings = yield* svc.get
    const index = coerceIndex(yield* Effect.promise(() => archiveIndexItem.getValue()))
    const now = Date.now()
    const sessionId = makeSessionId(now)
    const archivedAt = new Date(now).toISOString()
    const options = {
      template: settings.filenameTemplate,
      sidecar: settings.sidecarMetadata,
      includeText: settings.archiveIncludeText,
      linkScope: settings.archiveLinkScope,
    }
    const plan = planArchive({
      tweets: req.tweets,
      source: req.source,
      sessionId,
      archivedAt,
      index,
      options,
    })

    const run = yield* runRequests(plan.downloads, settings)
    const startedById = new Map(run.outcomes.map((o) => [o.id, o.ok]))
    const results: ArchiveTweetResult[] = plan.tweets.map((t) => {
      // A request missing from the outcomes was already in flight from another
      // batch — count it as started rather than failing the tweet for it.
      const started = t.requestIds.map((id) => startedById.get(id) ?? true)
      return {
        tweetId: t.tweetId,
        ok: started.every(Boolean),
        completed: started.filter(Boolean).length,
        total: started.length,
        alreadyArchived: false,
      }
    })
    const skipped: ArchiveTweetResult[] = plan.skipped.map((tweetId) => ({
      tweetId,
      ok: true,
      completed: 0,
      total: 0,
      alreadyArchived: true,
    }))

    yield* Effect.promise(() =>
      archiveIndexItem.setValue(markArchived(index, results, sessionId, archivedAt)),
    )
    // Mark the session — but only when this run actually processed something.
    if (results.length > 0) {
      const manifest = sessionManifestDownload({
        sessionId,
        source: req.source,
        archivedAt,
        options,
        results: [...results, ...skipped],
      })
      yield* runRequests([manifest], settings)
    }

    return { _tag: 'ArchiveResponse' as const, sessionId, results: [...results, ...skipped] }
  }).pipe(Effect.provide(SettingsServiceLive))

export default defineBackground(() => {
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
    if (msg._tag === 'ArchiveRequest') {
      void Effect.runPromise(handleArchive(msg)).then(sendResponse)
      return true
    }
    if (msg._tag === 'MetricsRequest') {
      void metricsItem.getValue().then((snap) => sendResponse(snap ?? ZERO_SNAPSHOT))
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
    return false
  })
})
