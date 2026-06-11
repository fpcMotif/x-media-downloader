import { Effect, Result, Schema } from 'effect'
import { storage } from 'wxt/utils/storage'
import { Message, type MediaItem, type MetricsSnapshot, type Settings } from '../core/schema'
import { SettingsService, SettingsServiceLive } from '../core/settings'
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
import { makeCloudClient } from '../core/cloud/client'
import type { CloudJobRecord } from '../core/cloud/types'

// Ephemeral monitoring snapshot — session storage survives SW recycling but not
// a browser restart (ADR-0005). The popup polls it via `MetricsRequest`.
const metricsItem = storage.defineItem<MetricsSnapshot | null>('session:metrics', {
  fallback: null,
})

// Stable anonymous user ID persisted across browser restarts for cloud history.
const cloudUserIdItem = storage.defineItem<string | null>('local:cloudUserId', {
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

// Maps requestId → jobId so the onChanged listener can report item-level
// outcomes to the cloud without re-reading settings on every event.
const requestIdToJobId = new Map<string, string>()

// Last-known Worker URL, cached from settings so the async onChanged listener
// can call the cloud client without an extra settings read per event.
let cachedWorkerUrl = ''

const persistSnapshot = (now: number): Promise<void> =>
  live ? metricsItem.setValue(snapshot(live, now)) : Promise.resolve()

// ─── cloud user ID ────────────────────────────────────────────────────────────

const getOrCreateCloudUserId = async (): Promise<string> => {
  const id = await cloudUserIdItem.getValue()
  if (id !== null) return id
  const fresh = crypto.randomUUID()
  await cloudUserIdItem.setValue(fresh)
  return fresh
}

// ─── cloud sync helpers (fire-and-forget; never block downloads) ──────────────

const syncJobStart = async (
  workerUrl: string,
  jobId: string,
  items: ReadonlyArray<MediaItem>,
  template: string,
  planned: number,
): Promise<void> => {
  try {
    const userId = await getOrCreateCloudUserId()
    await makeCloudClient(workerUrl).createJob({
      id: jobId,
      userId,
      sourceKind: 'tweet',
      total: planned,
      items: items.map((item) => ({
        id: item.id,
        mediaId: item.id,
        tweetId: item.tweetId,
        handle: item.handle,
        type: item.type,
        url: item.url,
        ext: item.ext,
        filename: template,
      })),
    })
  } catch {
    // cloud sync is best-effort; never surface errors to the download path
  }
}

const syncJobFinish = async (
  workerUrl: string,
  jobId: string,
  snap: MetricsSnapshot,
): Promise<void> => {
  try {
    const done = snap.completed + snap.failed
    const status =
      done >= snap.total
        ? snap.failed === 0
          ? ('complete' as const)
          : snap.completed === 0
            ? ('failed' as const)
            : ('partial' as const)
        : ('running' as const)
    await makeCloudClient(workerUrl).updateJob(jobId, {
      status,
      completed: snap.completed,
      failed: snap.failed,
      bytesReceived: snap.bytesReceived,
      bytesTotal: snap.bytesTotal,
      throughputBps: snap.throughputBps,
      etaSeconds: snap.etaSeconds ?? null,
    })
  } catch {
    // best-effort
  }
}

// ─── download pipeline ────────────────────────────────────────────────────────

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
    if (requests.length === 0) return { _tag: 'QueueUpdate' as const, completed: 0, total: 0 }
    for (const r of requests) inFlight.add(r.id)

    // Fire cloud job creation before local metrics so history starts even if the
    // SW recycles mid-batch. This is intentionally fire-and-forget.
    const jobId = crypto.randomUUID()
    cachedWorkerUrl = settings.cloudWorkerUrl
    if (settings.cloudWorkerUrl) {
      // Register requestId → jobId for the onChanged listener.
      for (const r of requests) {
        if (!r.id.endsWith('.json')) requestIdToJobId.set(r.id, jobId)
      }
      void syncJobStart(settings.cloudWorkerUrl, jobId, items, settings.filenameTemplate, requests.length)
    }

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
        requestIdToJobId.delete(o.id)
        live = recordOutcome(live, o.id, 'failed', now)
        // Aria2 failures-to-start: report item outcome immediately.
        if (cachedWorkerUrl && !o.id.endsWith('.json')) {
          void makeCloudClient(cachedWorkerUrl)
            .updateItem(jobId, o.id, { status: 'failed', attemptCount: 1 })
            .catch(() => {})
        }
      } else if (o.handle?.kind === 'browser') {
        requestIdByDownloadId.set(o.handle.id, o.id)
        live = recordSample(live, { id: o.id, bytesReceived: 0, totalBytes: -1, t: now })
      } else {
        // Aria2 hand-off: terminal success from our side.
        inFlight.delete(o.id)
        requestIdToJobId.delete(o.id)
        live = recordOutcome(live, o.id, 'complete', now)
        if (cachedWorkerUrl && !o.id.endsWith('.json')) {
          void makeCloudClient(cachedWorkerUrl)
            .updateItem(jobId, o.id, { status: 'downloaded', attemptCount: 1 })
            .catch(() => {})
        }
      }
    }
    yield* Effect.promise(() => persistSnapshot(now))

    // Push terminal status to cloud after local metrics are settled.
    if (settings.cloudWorkerUrl && live) {
      void syncJobFinish(settings.cloudWorkerUrl, jobId, snapshot(live, now))
    }

    return { _tag: 'QueueUpdate' as const, completed: res.completed, total: res.total }
  }).pipe(Effect.provide(SettingsServiceLive))

// ─── history handler ──────────────────────────────────────────────────────────

const handleHistory = (): Promise<CloudJobRecord[]> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const svc = yield* SettingsService
      const settings = yield* svc.get
      if (!settings.cloudWorkerUrl) return [] as CloudJobRecord[]
      const userId = yield* Effect.promise(getOrCreateCloudUserId)
      return yield* Effect.promise(() =>
        makeCloudClient(settings.cloudWorkerUrl).listJobs(userId),
      )
    }).pipe(Effect.provide(SettingsServiceLive)),
  ).catch((): CloudJobRecord[] => [])

// ─── background entry point ───────────────────────────────────────────────────

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

        // Report individual item outcome to cloud (browser download path).
        const jobId = requestIdToJobId.get(id)
        if (jobId && cachedWorkerUrl && !id.endsWith('.json')) {
          requestIdToJobId.delete(id)
          void makeCloudClient(cachedWorkerUrl)
            .updateItem(jobId, id, {
              status: outcome === 'complete' ? 'downloaded' : 'failed',
              attemptCount: 1,
            })
            .catch(() => {})
        }
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
      void metricsItem.getValue().then((snap) => sendResponse(snap ?? ZERO_SNAPSHOT))
      return true
    }
    if (msg._tag === 'HistoryRequest') {
      void handleHistory().then(sendResponse)
      return true
    }
    return false
  })
})
