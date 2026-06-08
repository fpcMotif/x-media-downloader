import { Effect, Result, Schema } from 'effect'
import { storage } from 'wxt/utils/storage'
import { Message, type MediaItem, type MetricsSnapshot, type Settings } from '../core/schema'
import { SettingsService, SettingsServiceLive } from '../core/settings'
import { makeDirectStrategy, type DownloadStrategy } from '../core/download/strategy'
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

const persistSnapshot = (now: number): Promise<void> =>
  live ? metricsItem.setValue(snapshot(live, now)) : Promise.resolve()

/** Pick the download strategy for the active settings (Direct default; aria2 opt-in). */
function chooseStrategy(settings: Settings): DownloadStrategy {
  if (settings.downloadStrategy === 'aria2') {
    const port = makeAria2RpcPort({
      rpcUrl: settings.aria2RpcUrl,
      secret: settings.aria2Secret,
      fetchImpl: fetch,
    })
    return makeAria2Strategy(port, {
      split: settings.aria2Split,
      ...(settings.aria2Dir ? { dir: settings.aria2Dir } : {}),
    })
  }
  // 'direct' (default) and 'fetched' (offscreen path not yet built) both go Direct.
  return makeDirectStrategy({ download: (opts) => browser.downloads.download(opts) })
}

const handleDownload = (items: ReadonlyArray<MediaItem>) =>
  Effect.gen(function* () {
    const svc = yield* SettingsService
    const settings = yield* svc.get
    const strategy = chooseStrategy(settings)
    const queue = makeDownloadQueueCore({ strategy, concurrency: settings.downloadConcurrency })
    const requests = items.flatMap((item) =>
      planDownloads({
        template: settings.filenameTemplate,
        item,
        sidecar: settings.sidecarMetadata,
      }),
    )

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
        live = recordOutcome(live, o.id, 'failed', now)
      } else if (o.handle?.kind === 'browser') {
        requestIdByDownloadId.set(o.handle.id, o.id)
        live = recordSample(live, { id: o.id, bytesReceived: 0, totalBytes: -1, t: now })
      } else {
        live = recordOutcome(live, o.id, 'complete', now)
      }
    }
    yield* Effect.promise(() => persistSnapshot(now))

    return { _tag: 'QueueUpdate' as const, completed: res.completed, total: res.total }
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
      if (outcome && live) live = recordOutcome(live, id, outcome, now)
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
      void metricsItem.getValue().then((snap) => sendResponse(snap ?? ZERO_SNAPSHOT))
      return true
    }
    return false
  })
})
