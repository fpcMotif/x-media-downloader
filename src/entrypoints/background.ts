import { Effect, Result, Schema } from 'effect'
import { storage } from 'wxt/utils/storage'
import {
  Message,
  type ArchiveTweet,
  type MediaItem,
  type MetricsSnapshot,
  type Settings,
} from '../core/schema'
import { SettingsService, SettingsServiceLive } from '../core/settings'
import {
  makeDirectStrategy,
  makeSchemeRoutingStrategy,
  type DownloadStrategy,
  type SaveRequest,
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
import {
  decodeLedger,
  hasKey,
  markSaved,
  mediaKey,
  recordKey,
  type Ledger,
} from '../core/archive/ledger'
import { planArchiveRecord } from '../core/archive/record'
import type { TweetCandidate } from '../core/archive/capture'
import { makeRemoteLedgerPort, type SavedEntryPayload } from '../core/archive/remote'
import {
  cleanupCandidates,
  isTweetSaved,
  markCleanup,
  recordUnitOutcome,
  startSession,
  summarize,
  type ArchiveSession,
  type SessionSummary,
} from '../core/archive/session'

// Ephemeral monitoring snapshot — session storage survives SW recycling but not
// a browser restart (ADR-0005). The popup polls it via `MetricsRequest`.
const metricsItem = storage.defineItem<MetricsSnapshot | null>('session:metrics', {
  fallback: null,
})

// Durable idempotency ledger + last job summary (ADR-0010). Local, single-writer.
const ledgerItem = storage.defineItem<unknown>('local:archive-ledger', {
  fallback: { entries: [] },
})
const archiveSummaryItem = storage.defineItem<SessionSummary | null>('local:archive-session', {
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

// --- Archive job state (ADR-0010). One job at a time; the popup gates restart. ---
let archiveSession: ArchiveSession | null = null
let archiveTabId: number | undefined
const archiveKeysByTweet = new Map<string, ReadonlyArray<string>>()
const archiveCommitted = new Set<string>()
let archiveRemovePending = false
let archiveCleanupDispatched = false
let archiveRemote: ReturnType<typeof makeRemoteLedgerPort> | null = null
// Serialize ledger read-modify-writes across concurrent tweet commits (ADR-0005).
let ledgerWrites: Promise<void> = Promise.resolve()

const persistSnapshot = (now: number): Promise<void> =>
  live ? metricsItem.setValue(snapshot(live, now)) : Promise.resolve()

const persistArchiveSummary = (): Promise<void> =>
  archiveSession ? archiveSummaryItem.setValue(summarize(archiveSession)) : Promise.resolve()

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
 * Seed/extend monitoring, fire the queue, and reconcile precise per-request
 * outcomes. Browser transfers go in-flight (tracked by downloadId for the
 * onChanged/search loop); aria2 hand-offs and failures-to-start are terminal
 * here. Each terminal outcome also feeds the archive session (no-op when none).
 * Shared by the ad-hoc download path and the archive job.
 */
const runRequests = (requests: ReadonlyArray<SaveRequest>, settings: Settings) =>
  Effect.gen(function* () {
    const strategy = chooseStrategy(settings)
    const queue = makeDownloadQueueCore({ strategy, concurrency: settings.downloadConcurrency })
    for (const r of requests) inFlight.add(r.id)

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

    const now = Date.now()
    for (const o of res.outcomes) {
      if (!o.ok) {
        inFlight.delete(o.id)
        live = recordOutcome(live, o.id, 'failed', now)
        settleArchiveUnit(o.id, false, now)
      } else if (o.handle?.kind === 'browser') {
        requestIdByDownloadId.set(o.handle.id, o.id)
        live = recordSample(live, { id: o.id, bytesReceived: 0, totalBytes: -1, t: now })
      } else {
        inFlight.delete(o.id)
        live = recordOutcome(live, o.id, 'complete', now)
        settleArchiveUnit(o.id, true, now)
      }
    }
    yield* Effect.promise(() => persistSnapshot(now))
    return res
  })

const handleDownload = (items: ReadonlyArray<MediaItem>) =>
  Effect.gen(function* () {
    const svc = yield* SettingsService
    const settings = yield* svc.get
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
    const res = yield* runRequests(requests, settings)
    return { _tag: 'QueueUpdate' as const, completed: res.completed, total: res.total }
  }).pipe(Effect.provide(SettingsServiceLive))

/** One planned download plus its ledger key (media-url key or record key). */
interface ArchiveUnit {
  readonly request: SaveRequest
  readonly key: string
}

/**
 * Normalize a decoded `ArchiveTweet` (schema optionals are `T | undefined`) into
 * a `TweetCandidate` (optionals strictly absent) so the pure record builder gets
 * exactly the shape it declares under `exactOptionalPropertyTypes`.
 */
function toCandidate(t: ArchiveTweet): TweetCandidate {
  return {
    tweetId: t.tweetId,
    handle: t.handle,
    source: t.source,
    text: t.text,
    links: t.links.map((l) =>
      l.publisher !== undefined
        ? { url: l.url, kind: l.kind, publisher: l.publisher }
        : { url: l.url, kind: l.kind },
    ),
    items: t.items,
    ...(t.createdAt !== undefined ? { createdAt: t.createdAt } : {}),
  }
}

/**
 * Plan a tweet's archive units (media files via the normal path — the record
 * IS the metadata, so no per-file sidecar — plus the history record), and tag
 * each with its canonical ledger key.
 */
function planTweet(t: TweetCandidate, settings: Settings, savedAtIso: string): ArchiveUnit[] {
  const opts = { includeText: settings.archiveIncludeText, linkMode: settings.archiveLinkMode }
  const media: ArchiveUnit[] = t.items.flatMap((item) =>
    planDownloads({ template: settings.filenameTemplate, item, sidecar: false }).map((request) => ({
      request,
      key: mediaKey(request.url),
    })),
  )
  const record = planArchiveRecord(settings.filenameTemplate, t, opts, savedAtIso)
  return [...media, { request: record, key: recordKey(t.tweetId) }]
}

const handleArchiveSave = (msg: {
  source: ArchiveTweet['source']
  tweets: ReadonlyArray<ArchiveTweet>
}) =>
  Effect.gen(function* () {
    const svc = yield* SettingsService
    const settings = yield* svc.get
    const ledger: Ledger = decodeLedger(yield* Effect.promise(() => ledgerItem.getValue()))
    const savedAtIso = new Date().toISOString()

    const allRequests: SaveRequest[] = []
    const sessionTweets: { tweetId: string; unitIds: string[]; skipped: number }[] = []
    const seenInBatch = new Set<string>()

    for (const raw of msg.tweets) {
      const t = toCandidate(raw)
      const units = planTweet(t, settings, savedAtIso)
      const kept = units.filter((u) => {
        if (hasKey(ledger, u.key) || inFlight.has(u.request.id) || seenInBatch.has(u.key)) {
          return false
        }
        seenInBatch.add(u.key)
        return true
      })
      for (const u of kept) allRequests.push(u.request)
      sessionTweets.push({
        tweetId: t.tweetId,
        unitIds: kept.map((u) => u.request.id),
        skipped: units.length - kept.length,
      })
      archiveKeysByTweet.set(
        t.tweetId,
        kept.map((u) => u.key),
      )
    }

    // Reset job state before enqueue: runRequests may settle units synchronously
    // (aria2 / failures), and those settlements must see the live session.
    archiveCommitted.clear()
    archiveCleanupDispatched = false
    archiveRemovePending = settings.archiveRemoveAfterSave
    archiveRemote = makeRemoteLedgerPort(
      {
        kind: settings.archiveSyncKind,
        url: settings.archiveSyncUrl,
        secret: settings.archiveSyncSecret,
      },
      fetch,
    )
    archiveSession = startSession({
      id: crypto.randomUUID(),
      source: msg.source,
      startedAt: Date.now(),
      removeAfterSave: settings.archiveRemoveAfterSave,
      tweets: sessionTweets,
    })
    yield* Effect.promise(() => persistArchiveSummary())

    if (allRequests.length > 0) yield* runRequests(allRequests, settings)
    // Zero-unit tweets (everything ledgered) are saved immediately; commit them.
    reconcileArchive(Date.now())
    yield* Effect.promise(() => persistArchiveSummary())

    return {
      _tag: 'QueueUpdate' as const,
      completed: allRequests.length,
      total: allRequests.length,
    }
  }).pipe(Effect.provide(SettingsServiceLive))

/** Persist ledger keys for one freshly-saved tweet, then mirror them remotely. */
function commitTweet(
  tweetId: string,
  keys: ReadonlyArray<string>,
  source: ArchiveTweet['source'],
  now: number,
): void {
  if (keys.length === 0) return
  ledgerWrites = ledgerWrites.then(async () => {
    const ledger = decodeLedger(await ledgerItem.getValue())
    return ledgerItem.setValue(markSaved(ledger, keys, now))
  })
  void ledgerWrites
  if (archiveRemote) {
    const entries: SavedEntryPayload[] = keys.map((key) => ({ key, tweetId, source, savedAt: now }))
    void archiveRemote.record(entries)
  }
}

/**
 * After any unit settles: commit newly-saved tweets to the ledger (idempotent),
 * and once every unit has settled, dispatch a single cleanup batch to the tab
 * that started the job (only when removal is enabled).
 */
function reconcileArchive(now: number): void {
  if (!archiveSession) return
  for (const t of archiveSession.tweets) {
    if (isTweetSaved(t) && !archiveCommitted.has(t.tweetId)) {
      archiveCommitted.add(t.tweetId)
      commitTweet(t.tweetId, archiveKeysByTweet.get(t.tweetId) ?? [], t.source, now)
    }
  }
  const allSettled = archiveSession.tweets.every(
    (t) => t.savedIds.length + t.failedIds.length === t.unitIds.length,
  )
  if (allSettled && archiveRemovePending && !archiveCleanupDispatched) {
    archiveCleanupDispatched = true
    const requests = cleanupCandidates(archiveSession).map((t) => ({
      tweetId: t.tweetId,
      source: t.source,
    }))
    if (requests.length > 0 && archiveTabId !== undefined) {
      void browser.tabs
        .sendMessage(archiveTabId, { _tag: 'ArchiveCleanupRequest', requests })
        .catch(() => {})
    }
  }
}

/** Feed one terminal unit outcome into the archive session, then reconcile. */
function settleArchiveUnit(id: string, ok: boolean, now: number): void {
  if (!archiveSession) return
  archiveSession = recordUnitOutcome(archiveSession, id, ok)
  reconcileArchive(now)
  void persistArchiveSummary()
}

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
        settleArchiveUnit(id, outcome === 'complete', now)
      }
      await persistSnapshot(now)
    })()
  })

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const decoded = Schema.decodeUnknownResult(Message)(message)
    if (Result.isFailure(decoded)) return false
    const msg = decoded.success
    if (msg._tag === 'DownloadRequest') {
      void Effect.runPromise(handleDownload(msg.items)).then(sendResponse)
      return true // keep the channel open for the async reply
    }
    if (msg._tag === 'ArchiveSaveRequest') {
      archiveTabId = sender.tab?.id
      void Effect.runPromise(handleArchiveSave({ source: msg.source, tweets: msg.tweets })).then(
        sendResponse,
      )
      return true
    }
    if (msg._tag === 'ArchiveCleanupReport') {
      void (async () => {
        for (const r of msg.results) {
          if (archiveSession) archiveSession = markCleanup(archiveSession, r.tweetId, r.ok)
        }
        await persistArchiveSummary()
        sendResponse({ _tag: 'QueueUpdate', completed: 0, total: 0 })
      })()
      return true
    }
    if (msg._tag === 'ArchiveSessionRequest') {
      void archiveSummaryItem.getValue().then((s) => sendResponse(s ?? null))
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
