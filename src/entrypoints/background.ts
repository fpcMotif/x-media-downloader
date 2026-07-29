import { Effect } from 'effect'
import { storage } from 'wxt/utils/storage'
import { type MediaItem } from '../core/schema'
import {
  getSettings,
  getSettingsOwnership,
  watchSettingsOwnership,
  type SettingsOwnershipSnapshot,
} from '../core/settings'
import { makeConvexHttpPort, queryDownloadedAmong } from '../core/sync/convex'
import { makeSavedIndex, type QueryConvex } from '../core/sync/saved-index'
import { refreshMediaUrlFromTabs } from '../core/download/media-url-refresh'
import { makeAria2RpcPort, makeAria2Strategy } from '../core/download/aria2'
import { makeFetchServiceLive } from '../core/fetch-service'
import { makeFetchPort, makePermissionsPort } from '../core/download/fetched-strategy'
import type {
  FetchedBootInspection,
  FetchedBootObservation,
  FetchedTransferOwner,
} from '../core/download/fetched-transfer-contract'
import {
  makeBrowserDownloadPort,
  makeFetchedTransferGateway,
} from '../background/fetched-transfer-gateway'
import { makeFetchedBlobLeaseStorage } from '../background/fetched-blob-lease-store'
import { makeOffscreenBlobPort } from '../background/offscreen-blob-port'
import { makeGuardedProbeFetch, makeSizeProbe } from '../core/download/size-probe'
import { type StoredBudgetRecord } from '../core/download/daily-budget'
import { makeSyndicationRecovery } from '../background/syndication-recovery'
import type { TerminalProjection } from '../core/download/terminal-outcome'
import type { LaunchToken, TransferRequest } from '../core/download/transfer-registry'
import { type Scope } from '../core/clear/ledger'
import type { SweepEnqueueResponse, SweepScope } from '../core/schema'
import { isSyncConfigured } from '../background/sync-config'
import { makeTabBroadcaster } from '../background/tab-broadcaster'
import { makeSyncOutbox } from '../background/sync-outbox'
import { makeCloudUpload } from '../background/cloud-upload'
import { makeDownloadHistory } from '../background/download-history'
import { makeDownloadHistoryProjection } from '../background/download-history-projection'
import { settingsWriter } from '../background/settings-writer'
import { makeSavedStatusCoordinator } from '../background/saved-status'
import { makeAdmissionGate } from '../background/admission-gate'
import { makeDailyBudgetStore } from '../background/daily-budget-store'
import {
  ClearCoordinatorCorruptionError,
  makeClearCoordinator,
} from '../background/clear-coordinator'
import { makeClearWorklistStore } from '../background/clear-worklist-store'
import {
  makeSweepReceiptStore,
  SweepReceiptCorruptionError,
} from '../background/sweep-receipt-store'
import { makeSweepHandoffCoordinator } from '../background/sweep-handoff-coordinator'
import {
  SWEEP_HANDOFF_ALARM,
  armSweepHandoffWatchdog,
  reconcileSweepHandoffWake,
} from '../background/sweep-handoff-wake'
import { makeInterruptRetryStarter } from '../background/interrupt-retry-starter'
import { mediaRequestId } from '../core/download/request-identity'
import {
  TRANSFER_REGISTRY_STORAGE_KEY,
  makeTransferRegistry,
  TransferRegistryCorruptionError,
  type BrowserDownloadRow,
  type TransferRegistry,
} from '../background/transfer-registry'
import { migrateLegacyTransferTracker } from '../background/transfer-registry-migration'
import { makeCaptureDb } from '../background/capture-db'
import { makeCaptureArchive } from '../background/capture-archive'
import { makeCaptureExporter } from '../background/capture-export'
import { makeCaptureOutbox } from '../background/capture-outbox'
import { makeTerminalProjector } from '../background/terminal-projector'
import { makeDownloadMonitor } from '../background/download-monitor'
import {
  makeTransferLaunchCoordinator,
  type SweepClearSeedOutcome,
  type SweepLaunchReceipt,
} from '../background/transfer-launch-coordinator'
import { cloudUploadIntentsFor } from '../background/transfer-cloud-admission'
import { assertAllowedMediaUrl, assertAllowedMediaUrls } from '../core/media-url-policy'
import { makeBackgroundMessageListener } from '../background/message-router'
import { makeBackgroundMessageHandlers } from '../background/background-message-handlers'
import { makeSettingsPublisher } from '../background/settings-publisher'
import { registerBackgroundLifecycle } from '../background/runtime-lifecycle'
import { PermanentBackgroundBootError, type BackgroundReadiness } from '../background/readiness'

let transferRegistry: TransferRegistry | undefined

const rethrowTypedBootFailure = (error: unknown): never => {
  if (
    error instanceof TransferRegistryCorruptionError ||
    error instanceof ClearCoordinatorCorruptionError ||
    error instanceof SweepReceiptCorruptionError
  )
    throw new PermanentBackgroundBootError(error)
  throw error
}

// Advisory telemetry only. Transfer Registry and Clear own durable truth.
const downloadMonitor = makeDownloadMonitor({
  log: (event) =>
    console.info(
      `[XMD] ${event.source} ${[
        event.stage,
        event.type,
        event.itemId,
        event.elapsedMs === undefined ? null : `${event.elapsedMs}ms`,
        event.detail,
      ]
        .filter(Boolean)
        .join(' ')}`,
    ),
})

// The single tab-messaging surface. Clear uses its read-only Locate seam before
// selecting one destructive target.
const tabBroadcaster = makeTabBroadcaster()
const { reportTransferOutcome } = tabBroadcaster

const traceBackground = (
  stage: string,
  opts: Parameters<typeof downloadMonitor.traceBackground>[1] = {},
): void => {
  downloadMonitor.traceBackground(stage, opts)
}

// One observable failure path for the serialized RMW queues below. These chains
// each used to end in `.catch(() => {})`, so a thrown drain (storage quota, a
// decode failure, an unexpected reducer throw) vanished. Now it leaves a trace
// instead. Observe-and-log only — never re-throw, or the chain would wedge.
const queueError =
  (label: string) =>
  (err: unknown): void =>
    traceBackground(`queue:${label}`, {
      detail: err instanceof Error ? err.message : String(err),
    })

const settingsPublisher = makeSettingsPublisher({
  broadcast: (settings) =>
    tabBroadcaster.broadcastToPlatformTabs({
      _tag: 'SettingsChanged',
      settings,
    }),
  onError: queueError('settings-publication'),
})
const broadcastContentSettings = settingsPublisher.publish
const replayContentSettings = settingsPublisher.replay

// Cloud Sync outbox (ADR-0009) — metadata-only events drained FIFO; owns its
// own queue, storage, and durable wake.
const syncOutbox = makeSyncOutbox({
  queueError,
  fetchImpl: fetch,
  getSettings,
  getSettingsOwnership,
})
// Storage watches are wake-only and may reorder. The sole Settings writer
// supplies ordered, post-persist commands: one fences Sync opt-out; one updates
// every open content script from the committed projection.
settingsWriter.onCommit((settings) => {
  syncOutbox.onSettingsCommitted(settings)
  void broadcastContentSettings(settings).catch(() => {})
})

// One module owns History records, reads, projections, and erase on one FIFO.
const historyItem = storage.defineItem<unknown>('local:downloadHistory', {
  fallback: null,
})
const downloadHistory = makeDownloadHistory({
  storage: {
    get: () => historyItem.getValue(),
    set: (store) => historyItem.setValue(store),
  },
  onError: queueError('history'),
})
const savedIndex = makeSavedIndex()
const savedMediaIndex = makeSavedIndex()
const historyProjection = makeDownloadHistoryProjection({
  history: downloadHistory,
  savedPosts: savedIndex,
  savedRequests: savedMediaIndex,
  requestIdFor: mediaRequestId,
  pendingTerminalProjectionIds: async () => {
    const registry = transferRegistry
    if (registry === undefined) throw new Error('transfer registry is not booted')
    return registry.listPendingTerminalProjectionIds()
  },
})

// Cloud upload (ADR-0013): client-side OAuth byte path. Owns its UploadJob ledger
// + queue; Settings changes use the background's shared writer. Bytes go extension
// → provider directly (nothing transits Convex). Backfill reads durable history.
const cloudUpload = makeCloudUpload({
  queueError,
  getSettings,
  getSettingsOwnership,
  settingsWriter,
  fetchImpl: fetch,
  // BackfillRecord.media keeps its own `handle`-named field (cloud-upload.ts is
  // untouched by the multi-platform rename) — map the generalized author onto it.
  getBackfillRecords: async () =>
    (await historyProjection.listCompleted()).map((r) => ({
      requestId: r.requestId,
      filename: r.filename,
      media: { url: r.media.url, handle: r.media.author, ext: r.media.ext },
    })),
})
const { uploadQueue, drainUploadJobs } = cloudUpload

const syndicationRecovery = makeSyndicationRecovery({ fetchImpl: fetch })
const REGISTRY_ALARM = 'xmd-transfer-registry'
const LEGACY_REGISTRY_ALARM = 'xmd-browser-transfer-registry'
const FETCHED_TERMINAL_CLEANUP_ALARM = 'xmd-fetched-terminal-cleanup'
const CLEAR_COORDINATOR_ALARM = 'xmd-clear-coordinator'
const CLEAR_WORKLIST_PROJECTION_ALARM = 'xmd-clear-worklist-projection'
const READINESS_RETRY_ALARM = 'xmd-readiness:boot-retry'
const readinessRetry = (ownerName: string) => {
  const name = `${ownerName}:boot-retry`
  return {
    name,
    arm: async (): Promise<void> => {
      if ((await browser.alarms.get(name)) !== undefined) return
      await browser.alarms.create(name, { delayInMinutes: 0.5 })
    },
  }
}
const scheduleClearCoordinatorWake = async (at: number): Promise<void> => {
  const current = await browser.alarms.get(CLEAR_COORDINATOR_ALARM)
  if (current !== undefined && current.scheduledTime <= at) return
  await browser.alarms.create(CLEAR_COORDINATOR_ALARM, { when: at })
}
const ensureClearWorklistProjectionWake = async (): Promise<void> => {
  await browser.alarms.create(CLEAR_WORKLIST_PROJECTION_ALARM, {
    delayInMinutes: 0.5,
    periodInMinutes: 30,
  })
}

const clearWorklistStore = makeClearWorklistStore({
  onError: queueError('clear-worklist'),
})
const sweepReceiptStore = makeSweepReceiptStore({
  onError: queueError('sweep-receipt'),
})

// Clear remains independently durable and fail-closed. The coordinator owns
// eligibility; the registry only supplies exact start/terminal evidence.
const clearCoordinator = makeClearCoordinator({
  downloadSearch: {
    // Do not turn a Chrome failure into a missing row: a thrown search retains
    // durable proof and blocks Clear until a later reconciliation.
    search: async (downloadId) => (await browser.downloads.search({ id: downloadId }))[0],
  },
  tabs: {
    locateClearTweet: (tweetId, scopes, preferTabId, allLists) =>
      tabBroadcaster.locateClearTweet(tweetId, scopes, preferTabId, allLists),
    clearTweetInTab: (tabId, tweetId, scopes, allLists) =>
      tabBroadcaster.clearTweetInTab(tabId, tweetId, scopes, allLists),
  },
  // Clear keeps its policy-specific vocabulary at this boundary. The writer's
  // generic snapshot turn is also used by other durable Settings gates.
  settings: { withClearPolicyTurn: settingsWriter.withSnapshotTurn },
  wake: {
    schedule: scheduleClearCoordinatorWake,
  },
  projectionWake: {
    ensure: ensureClearWorklistProjectionWake,
  },
  projectScopeState: async (projection) => {
    await clearWorklistStore.applyProjection(projection)
  },
  trace: (stage, context) =>
    traceBackground(`clear:${stage}`, {
      ...(context?.tweetId === undefined ? {} : { tweetId: context.tweetId }),
      ...(context?.requestId === undefined ? {} : { itemId: context.requestId }),
      ...(context?.detail === undefined ? {} : { detail: context.detail }),
    }),
})

// Cross-device "Saved" status (B+C): the local-first SavedIndex answers overlay
// sweeps. Seeded from the durable history (this device's completed downloads), fed
// every local completion (instant + offline), and unioned with Convex truth for
// other devices. `queryConvex` reads settings each call so toggling sync on/off —
// or pasting a deployment URL — takes effect without a restart; sync-off → C-only.
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
  // push them to every registered-platform tab so chips land without a re-sweep.
  notifyFresh: (saved) =>
    void tabBroadcaster
      .broadcastToPlatformTabs({ _tag: 'SavedStatusUpdate', saved })
      .catch(() => {}),
})
// Per-item duplicate-download check (admission gate only — NOT the post-level
// "Saved" badge above). A separate SavedIndex uses the canonical Save Request
// ID derived from the adapter-local Media Key, so grabbing one item from a
// multi-item post never blocks a different item. Local-only for v1: the backend has
// a `by_request_id` backstop (`queryDownloadedRequestIdsAmong`), but it is
// deliberately NOT wired here — cross-device per-item dedup was never a stated
// requirement, only cross-device post-level "Saved" was. Local history already
// durably answers "did I already grab this exact file."
const queryConvexMedia: QueryConvex = async () => []

// Must run after local storage is restricted to trusted extension contexts.
const seedSavedIndexes = async (): Promise<void> => {
  try {
    await historyProjection.seed()
  } catch {
    // The module already reports storage failure through queueError('history').
  }
}

// Download Admission Gate: a pre-scheduling check that drops duplicates and
// filtered / over-budget media before planDownloads. Size is HEAD-probed through
// the guarded media egress. The daily-budget tally lives in its own durable key,
// resets per local calendar day, and is accrued on completion through a serial
// queue so concurrent settles don't race.
const dailyBudgetItem = storage.defineItem<StoredBudgetRecord | null>('local:daily-budget', {
  fallback: null,
})
const budgetStore = makeDailyBudgetStore({
  storage: {
    get: () => dailyBudgetItem.getValue(),
    set: (record) => dailyBudgetItem.setValue(record),
  },
  now: () => Date.now(),
})
const admissionGate = makeAdmissionGate({
  getSettings,
  savedMediaIndex,
  queryConvexMedia,
  sizeProbe: makeSizeProbe({ fetch: makeGuardedProbeFetch(fetch) }),
  readTodayBudget: () => budgetStore.readTodayForAdmission(),
})

// Tweet harvest (spec §8–9): the durable IndexedDB store of harvested tweets and
// its opt-in, fire-and-forget Convex mirror. Both default to their real adapters;
// the seams exist so the merge-on-write and mirror gate are unit-tested.
const captureDb = makeCaptureDb()
const captureOutbox = makeCaptureOutbox()
const captureArchive = makeCaptureArchive({
  settings: settingsWriter,
  store: captureDb,
  mirror: captureOutbox,
})

// The sole production gateway: it owns the shared offscreen document, durable
// Blob leases, and serialized byte staging for Fetched media and Capture exports.
const fetchedTransferGateway = makeFetchedTransferGateway({
  leases: makeFetchedBlobLeaseStorage(),
  offscreen: makeOffscreenBlobPort(),
  downloads: makeBrowserDownloadPort(),
  scheduleAutonomousTerminalCleanup: async (at) => {
    const current = await browser.alarms.get(FETCHED_TERMINAL_CLEANUP_ALARM)
    if (current?.scheduledTime !== undefined && current.scheduledTime <= at) return
    await browser.alarms.create(FETCHED_TERMINAL_CLEANUP_ALARM, { when: at })
  },
  trace: (detail) => console.warn(`[XMD] ${detail}`),
})
const captureExporter = makeCaptureExporter({
  captureDb,
  gateway: fetchedTransferGateway,
})

const interruptRetryStarter = makeInterruptRetryStarter({
  download: (opts) => browser.downloads.download(opts),
  permissions: makePermissionsPort(),
  fetch: makeFetchPort(fetch),
  gateway: fetchedTransferGateway,
})

const newAria2Gid = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  if (bytes.every((byte) => byte === 0)) bytes[bytes.length - 1] = 1
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const isUntrackedClear = (error: unknown): boolean =>
  error instanceof Error &&
  (error.message.startsWith('Cannot bind untracked request') ||
    error.message.startsWith('Cannot fail untracked request'))

const bindClearStarted = async (
  request: TransferRequest,
  downloadId: number,
  priorDownloadId?: number,
): Promise<void> => {
  if (request.item === undefined) return
  await clearCoordinator.rebindPersistedHandle({
    tweetId: request.item.postId,
    requestId: request.id,
    downloadId,
    ...(priorDownloadId === undefined ? {} : { priorDownloadId }),
  })
}

const terminalProjector = makeTerminalProjector({
  clear: {
    projectTerminal: async ({ tweetId, requestId, downloadId, outcome, observedAt }) => {
      // Rebind repairs a prior Clear-ledger write failure. Both operations no-op
      // for an unowned request and are idempotent for terminal replay.
      await clearCoordinator.rebindPersistedHandle({
        tweetId,
        requestId,
        downloadId,
        at: observedAt,
      })
      await clearCoordinator.recordTerminal({
        tweetId,
        requestId,
        downloadId,
        outcome,
        at: observedAt,
      })
    },
    projectStartFailure: async ({ tweetId, requestId, observedAt }) => {
      try {
        await clearCoordinator.failUnbound({
          tweetId,
          requestId,
          at: observedAt,
        })
      } catch (error) {
        if (!isUntrackedClear(error)) throw error
      }
    },
  },
  releaseFetched: (downloadId) => fetchedTransferGateway.releaseTerminal(downloadId),
  history: historyProjection,
  sync: syncOutbox,
  settings: { snapshot: getSettings },
  budget: budgetStore,
  metrics: {
    record: (requestId, outcome, observedAt) =>
      downloadMonitor.recordTerminal(requestId, outcome, observedAt),
  },
  broadcast: ({ requestId, outcome, at }) => reportTransferOutcome(requestId, outcome, at),
  trace: (_stage, projection) => {
    downloadMonitor.traceTerminal(projection)
  },
})

const projectTerminal = (projection: TerminalProjection): Promise<void> =>
  terminalProjector.project(projection)

/** Legacy rows retain only an id, browser handle, and sometimes Clear's tweet id. */
const projectLegacyTerminal = async (
  id: string,
  outcome: 'complete' | 'failed',
  downloadId: number,
  observedAt: number,
  tweetId: string | undefined,
): Promise<void> => {
  if (tweetId !== undefined) {
    await clearCoordinator.rebindPersistedHandle({
      tweetId,
      requestId: id,
      downloadId,
      at: observedAt,
    })
    await clearCoordinator.recordTerminal({
      tweetId,
      requestId: id,
      downloadId,
      outcome,
      at: observedAt,
    })
  }
  await downloadMonitor.traceLegacyTerminal({
    requestId: id,
    outcome,
    downloadId,
    at: observedAt,
  })
}

const registryItem = storage.defineItem<unknown | undefined>(TRANSFER_REGISTRY_STORAGE_KEY, {
  fallback: undefined,
})
const legacyTransfersItem = storage.defineItem<unknown | undefined>('session:transfers', {
  fallback: undefined,
})
const legacyRequestMetaItem = storage.defineItem<unknown | undefined>('session:requestMeta', {
  fallback: undefined,
})
const legacyRetriesItem = storage.defineItem<unknown | undefined>('session:interruptRetries', {
  fallback: undefined,
})

const transferOwner = (request: TransferRequest, token: LaunchToken): FetchedTransferOwner => ({
  tag: 'transfer',
  requestId: request.id,
  projectionId: request.projectionId,
  attempt: token.attempt,
  since: token.since,
  ...(token.priorDownloadId === undefined ? {} : { priorDownloadId: token.priorDownloadId }),
})

const makeRegistry = (fetchedBoot: ReadonlyArray<FetchedBootObservation>): TransferRegistry =>
  makeTransferRegistry({
    storage: {
      get: () => registryItem.getValue(),
      set: (state) => registryItem.setValue(state),
    },
    migrateLegacy: async () => {
      const migrated = migrateLegacyTransferTracker(
        await legacyTransfersItem.getValue(),
        await legacyRequestMetaItem.getValue(),
        await legacyRetriesItem.getValue(),
        Date.now(),
      )
      if (!migrated.ok) throw new Error(migrated.reason)
      return migrated.state
    },
    // v1 commits before this best-effort legacy cleanup runs.
    cleanupLegacy: async () => {
      await Promise.all([
        legacyTransfersItem.removeValue(),
        legacyRequestMetaItem.removeValue(),
        legacyRetriesItem.removeValue(),
      ])
    },
    clock: {
      now: () => Date.now(),
      schedule: (run, delayMs) => {
        const timer = setTimeout(run, delayMs)
        return () => clearTimeout(timer)
      },
    },
    wake: {
      schedule: async (at) => {
        if (at === undefined) {
          await browser.alarms.clear(REGISTRY_ALARM)
          await browser.alarms.clear(LEGACY_REGISTRY_ALARM)
          return
        }
        await browser.alarms.create(REGISTRY_ALARM, { when: at })
        await browser.alarms.clear(LEGACY_REGISTRY_ALARM)
      },
    },
    downloads: {
      search: async (downloadId) =>
        (await browser.downloads.search({ id: downloadId })).map((row): BrowserDownloadRow => {
          const projected: {
            id: number
            state?: string
            exists?: boolean
            error?: string
            bytesReceived?: number
            totalBytes?: number
          } = { id: row.id }
          if (row.state !== undefined) projected.state = row.state
          if (row.exists !== undefined) projected.exists = row.exists
          if (row.error !== undefined) projected.error = row.error
          if (Number.isSafeInteger(row.bytesReceived) && row.bytesReceived >= 0)
            projected.bytesReceived = row.bytesReceived
          if (Number.isSafeInteger(row.totalBytes) && row.totalBytes >= 0)
            projected.totalBytes = row.totalBytes
          return projected
        }),
      cancel: (downloadId) => browser.downloads.cancel(downloadId),
    },
    startRetry: async (mode, request, token) => {
      return interruptRetryStarter.start(mode, request, transferOwner(request, token))
    },
    reserveFetched: (request, token) =>
      interruptRetryStarter.reserveFetched(request, transferOwner(request, token)),
    startReservedFetched: (request, token, leaseId) =>
      interruptRetryStarter.startReservedFetched(request, transferOwner(request, token), leaseId),
    startAria2: async (request, token, profile, options) => {
      try {
        assertAllowedMediaUrl(request.url)
      } catch {
        return { tag: 'failed' }
      }
      if (token.gid === undefined) return { tag: 'failed' }
      try {
        const handle = await Effect.runPromise(
          makeAria2Strategy(
            makeAria2RpcPort(profile),
            options,
            makeFetchServiceLive(fetch),
            () => token.gid,
          ).save(request),
        )
        return handle.kind === 'aria2' && handle.gid === token.gid
          ? { tag: 'started' as const, gid: handle.gid }
          : { tag: 'ambiguous' as const }
      } catch {
        return { tag: 'ambiguous' }
      }
    },
    fetchedBoot,
    discardRecoveredStaging: (leaseIds) => fetchedTransferGateway.discardRecoveredStaging(leaseIds),
    refreshUrl: async (request) => {
      if (request.item === undefined) return request.url
      return (
        (await refreshMediaUrlFromTabs(request.item, tabBroadcaster.makeTabMessagingPort())) ??
        request.url
      )
    },
    observeTerminalFetched: (downloadId) =>
      fetchedTransferGateway.observeTerminalTransfer(downloadId),
    releaseFetched: (downloadId) => fetchedTransferGateway.releaseTerminal(downloadId),
    releaseAutonomousFetched: (downloadId) =>
      fetchedTransferGateway.releaseAutonomousTerminal(downloadId),
    aria2: {
      tellStatus: (profile, gid) =>
        Effect.runPromise(
          makeAria2RpcPort(profile)
            .tellStatus(gid)
            .pipe(Effect.provide(makeFetchServiceLive(fetch))),
        ),
    },
    clear: {
      bindTransfer: bindClearStarted,
      abandonTransfer: (tweetId, requestId, downloadId) =>
        clearCoordinator.abandonTransfer({
          tweetId,
          requestId,
          ...(downloadId === undefined ? {} : { downloadId }),
        }),
    },
    projectTerminal,
    projectLegacyTerminal,
    trace: (stage, detail) => traceBackground(`registry:${stage}`, { detail }),
  })

const transferLaunchCoordinator = makeTransferLaunchCoordinator({
  settings: getSettings,
  admission: admissionGate,
  registry: () => transferRegistry,
  clear: clearCoordinator,
  cloud: cloudUpload,
  monitor: downloadMonitor,
  trace: traceBackground,
  validateMediaUrls: (item) => assertAllowedMediaUrls(item.url, item.previewUrl),
  newProjectionId: () => crypto.randomUUID(),
  newAria2Gid,
  download: (opts) => browser.downloads.download(opts),
  fetchImpl: fetch,
})

const handleDownload = (
  items: ReadonlyArray<MediaItem>,
  sweep?: { readonly scope: Scope },
  sweepReceipts?: ReadonlyArray<SweepLaunchReceipt>,
  clearExpect?: ReadonlyArray<{
    readonly tweetId: string
    readonly requestIds: ReadonlyArray<string>
  }>,
  onClearSeeded?: (
    trackedByTweet: ReadonlyMap<string, ReadonlySet<string>>,
    worklistRevision: number,
  ) => Promise<void | SweepClearSeedOutcome>,
) =>
  transferLaunchCoordinator.launch({
    items,
    ...(sweep === undefined ? {} : { sweep }),
    ...(sweepReceipts === undefined ? {} : { sweepReceipts }),
    ...(clearExpect === undefined ? {} : { clearExpect }),
    ...(onClearSeeded === undefined ? {} : { onClearSeeded }),
  })

let sweepHandoff: ReturnType<typeof makeSweepHandoffCoordinator>
const handleSweepEnqueue = async (
  scope: SweepScope,
  posts: ReadonlyArray<{ readonly tweetId: string; readonly items: ReadonlyArray<MediaItem> }>,
): Promise<SweepEnqueueResponse> => await sweepHandoff.enqueue(scope, posts)

const releaseRecoveredSweepStarts = async (): Promise<void> => {
  const registry = transferRegistry
  if (registry === undefined) throw new Error('transfer registry is not booted')
  const cloudAdmission = await cloudUpload.recordCloudUploads(
    cloudUploadIntentsFor(await registry.listPreparedSweepIntents()),
  )
  if (cloudAdmission.tag === 'unavailable')
    traceBackground('cloud-admission-unavailable', { detail: cloudAdmission.reason })
  await registry.releaseConfirmedSweepStarts()
}

const reconcileSweepHandoffAlarm = async (): Promise<void> => {
  const registry = transferRegistry
  await reconcileSweepHandoffWake({
    wake: {
      create: (name, when) => browser.alarms.create(name, { when }),
      clear: (name) => browser.alarms.clear(name).then(() => undefined),
    },
    pendingReceipts: (await sweepReceiptStore.listRecoverable()).length > 0,
    pendingRegistryStarts:
      registry === undefined || (await registry.listPreparedSweepIntents()).length > 0,
    now: Date.now(),
    report: (error) =>
      traceBackground('sweep-handoff-wake-failed', {
        detail: error instanceof Error ? error.message : String(error),
      }),
  })
}

const armSweepHandoffAlarm = async (): Promise<void> =>
  await armSweepHandoffWatchdog({
    wake: {
      create: (name, when) => browser.alarms.create(name, { when }),
      clear: (name) => browser.alarms.clear(name).then(() => undefined),
    },
    now: Date.now(),
  })

const recoverSweepHandoffThroughRelease = async (
  release: Parameters<typeof sweepHandoff.recoverThroughRelease>[0],
): Promise<void> => {
  try {
    await sweepHandoff.recoverThroughRelease(release)
  } finally {
    await reconcileSweepHandoffAlarm()
  }
}

sweepHandoff = makeSweepHandoffCoordinator({
  receipts: sweepReceiptStore,
  worklist: clearWorklistStore,
  clear: clearCoordinator,
  registry: () => transferRegistry,
  settings: getSettings,
  launch: transferLaunchCoordinator.launch,
  armWatchdog: armSweepHandoffAlarm,
  requestSameLifeRepair: () => {
    queueMicrotask(() => {
      void reconcileSweepHandoffAlarm()
        .catch((error) =>
          traceBackground('sweep-handoff-wake-failed', {
            detail: error instanceof Error ? error.message : String(error),
          }),
        )
        .then(async () => await recoverSweepHandoffThroughRelease(releaseRecoveredSweepStarts))
        .catch((error) =>
          traceBackground('sweep-handoff-repair-failed', {
            detail: error instanceof Error ? error.message : String(error),
          }),
        )
    })
  },
  onError: queueError('sweep-handoff'),
})

/** The registry owns durable browser-transfer state and terminal fan-out. */
const onDownloadChanged = async (delta: Browser.downloads.DownloadDelta): Promise<void> => {
  const now = Date.now()
  const state = delta.state?.current
  const error = delta.error?.current
  await downloadMonitor.onBrowserDelta({
    downloadId: delta.id,
    terminal: state === 'complete' || state === 'interrupted',
    at: now,
    commitDurable: async () => {
      const registry = transferRegistry
      if (registry === undefined) throw new Error('transfer registry is not booted')
      await registry.onDownloadChanged({
        id: delta.id,
        ...(state === undefined ? {} : { state: { current: state } }),
        ...(error === undefined ? {} : { error: { current: error } }),
      })
    },
  })
}

/** Manual monitor reset is Tier 0 telemetry only. Durable transfer/Clear proof stays. */
const clearDownloadMonitor = async (): Promise<unknown> => {
  const reset = await downloadMonitor.reset()
  if (!reset.cleared) {
    return {
      _tag: 'ClearDownloadMonitorResponse',
      ok: false,
      active: reset.active,
      clearedMetrics: false,
      clearedLocks: 0,
      reason: reset.pending ? 'queued-downloads' : 'active-downloads',
    }
  }
  return {
    _tag: 'ClearDownloadMonitorResponse',
    ok: true,
    active: 0,
    clearedMetrics: true,
    clearedLocks: 0,
  }
}

const messageHandlers = makeBackgroundMessageHandlers({
  getSettings,
  settingsWriter,
  broadcastCaptureEpochChanged: () =>
    tabBroadcaster.broadcastToPlatformTabs({ _tag: 'CaptureEpochChanged' }),
  traceBackground,
  budgetStore,
  clearCoordinator,
  registry: () => transferRegistry,
  launchDownload: (items, clearExpect) =>
    Effect.runPromise(handleDownload(items, undefined, undefined, clearExpect)),
  enqueueSweep: handleSweepEnqueue,
  clearDownloadMonitor,
  downloadMonitor,
  downloadHistory: historyProjection,
  savedStatusCoordinator,
  syncOutbox,
  cloudUpload,
  syndicationRecovery,
  captureArchive,
  captureDb,
  captureExporter,
})

export default defineBackground(() => {
  let fetchedBoot: FetchedBootInspection = {
    tag: 'unavailable',
    reason: 'not inspected',
  }
  let resolveReadiness!: (readiness: BackgroundReadiness) => void
  const readinessAvailable = new Promise<BackgroundReadiness>((resolve) => {
    resolveReadiness = resolve
  })
  const applySettingsChange = async (snapshot: SettingsOwnershipSnapshot): Promise<void> => {
    syncOutbox.onWake()
    const settings = snapshot.runtime
    captureOutbox.resumeWhenEnabled()
    if (settings.cloudUploadEnabled) cloudUpload.resumeWhenEnabled()
    else void cloudUpload.pauseWhenDisabled()
  }
  // Event listeners must register during initial worker evaluation. Only their
  // effects wait for the current base attempt, including a recovery attempt.
  watchSettingsOwnership((snapshot) => {
    void readinessAvailable
      .then(async (readiness) => await readiness.base)
      .then(async (state) => {
        if (state.tag === 'available') await applySettingsChange(snapshot)
        return undefined
      })
      .catch(queueError('settings-lifecycle'))
  })

  const bootBase = async (): Promise<void> => {
    await browser.storage.local.setAccessLevel({
      accessLevel: 'TRUSTED_CONTEXTS',
    })
    await clearCoordinator.onProjectionWake()
    await seedSavedIndexes().catch((error) =>
      traceBackground('saved-index-seed-failed', {
        detail: error instanceof Error ? error.message : String(error),
      }),
    )
  }

  const bootFetched = async (): Promise<void> => {
    fetchedBoot = await fetchedTransferGateway.inspectOnBoot()
    await captureExporter.discardStaleStaging().catch((error) =>
      traceBackground('capture-export-staging-discard-failed', {
        detail: error instanceof Error ? error.message : String(error),
      }),
    )
    if (fetchedBoot.tag === 'unavailable') throw new Error(fetchedBoot.reason)
    // Transfer may already be available from an earlier Direct-only boot.
    // Adopt newly recovered gateway evidence without waiting for worker recycle.
    await transferRegistry?.reconcileFetchedBoot(fetchedBoot.observations)
  }

  const bootTransferDomain = async (): Promise<void> => {
    const registry = makeRegistry(fetchedBoot.tag === 'available' ? fetchedBoot.observations : [])
    await registry.ready()
    transferRegistry = registry

    const recovery = await registry.clearRecovery()
    for (const active of recovery.active)
      downloadMonitor.restoreBrowserTransfer(active.downloadId, active.request.id)
    for (const legacy of recovery.legacyActive)
      downloadMonitor.restoreBrowserTransfer(legacy.downloadId, legacy.id)
  }

  const bootClearDomain = async (startupObserved: boolean): Promise<void> => {
    await recoverSweepHandoffThroughRelease(async (sweepRepair) => {
      const registry = transferRegistry
      if (registry === undefined) throw new Error('transfer registry is not booted')
      const recovery = await registry.clearRecovery()
      const unresolved = new Set((await registry.inspectRecovery()).map((entry) => entry.id))
      await Promise.all(
        recovery.active.map((active) => bindClearStarted(active.request, active.downloadId)),
      )
      await Promise.all(
        recovery.legacyActive.flatMap((legacy) =>
          legacy.tweetId === undefined
            ? []
            : [
                clearCoordinator.rebindPersistedHandle({
                  tweetId: legacy.tweetId,
                  requestId: legacy.id,
                  downloadId: legacy.downloadId,
                }),
              ],
        ),
      )
      await clearCoordinator.resumeOnBoot({
        retryOwnedRequestIds: new Set([
          ...recovery.retryOwnedRequestIds,
          ...[...sweepRepair.protectedRequestIds].filter((requestId) => unresolved.has(requestId)),
        ]),
        adoptExternalSession: !startupObserved,
      })
      await releaseRecoveredSweepStarts()
    })
  }

  const bootTransfer = (): Promise<void> => bootTransferDomain().catch(rethrowTypedBootFailure)
  const bootClear = (startupObserved: boolean): Promise<void> =>
    bootClearDomain(startupObserved).catch(rethrowTypedBootFailure)

  const bootCloud = async (): Promise<void> => {
    await startCloud()
    const settings = await getSettings()
    console.info(
      `[XMD] background booted · clearOnSave=${settings.clearOnSave} unbookmark=${settings.autoUnbookmarkOnSave} unlike=${settings.autoUnlikeOnSave} strategy=${settings.downloadStrategy}`,
    )
  }

  // Cloud Sync reconciliation: drain anything left over from a previous SW
  // life / offline period; clear the outbox whenever the user turns sync off.
  const startCloud = async (): Promise<void> => {
    let s = await settingsWriter.ensureInvariants()
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
        s = (
          await settingsWriter.updateWhen(
            (current) => current.convexUrl === '' && current.convexSyncSecret === '',
            {
              convexUrl: envUrl,
              convexSyncSecret: envSecret,
              cloudSyncEnabled: true,
            },
          )
        ).settings
      }
    }
    await syncOutbox.reconcileSettings()
    captureOutbox.resumeOnBoot()
    // Dev convenience (ADR-0013): a gitignored `.env` may pre-seed the Cloud
    // Upload OAuth client IDs (public, not secrets). Gated on an empty field so a
    // user edit is never overridden; a normal build has neither var.
    const envGdriveClientId = import.meta.env.WXT_GDRIVE_CLIENT_ID as string | undefined
    const envDropboxAppKey = import.meta.env.WXT_DROPBOX_APP_KEY as string | undefined
    if (envGdriveClientId && s.gdriveClientId === '')
      s = (
        await settingsWriter.updateWhen((current) => current.gdriveClientId === '', {
          gdriveClientId: envGdriveClientId,
        })
      ).settings
    if (envDropboxAppKey && s.dropboxClientId === '')
      s = (
        await settingsWriter.updateWhen((current) => current.dropboxClientId === '', {
          dropboxClientId: envDropboxAppKey,
        })
      ).settings
    // Recover provider ownership before readiness opens alarm work. Then resume
    // or pause uploads from the same serialized turn.
    await cloudUpload.resumeOnBoot()
    // A worker can die after a durable Settings commit but before its tab
    // broadcast completes. Replay the live safe projection on every boot so
    // already-open content scripts recover without another user edit.
    await replayContentSettings(await getSettings()).catch(queueError('settings-publication'))
  }

  const readiness = registerBackgroundLifecycle({
    listeners: {
      addAlarmListener: (listener) => browser.alarms.onAlarm.addListener(listener),
      addDownloadChangedListener: (listener) => browser.downloads.onChanged.addListener(listener),
      addStartupListener: (listener) => browser.runtime.onStartup.addListener(listener),
      addMessageListener: (listener) => browser.runtime.onMessage.addListener(listener),
    },
    boot: {
      base: bootBase,
      fetched: bootFetched,
      transfer: bootTransfer,
      clear: bootClear,
      cloud: bootCloud,
      trace: (domain, detail) => traceBackground(`${domain}-boot-failed`, { detail }),
    },
    bootRetry: {
      name: READINESS_RETRY_ALARM,
      arm: async () => {
        if ((await browser.alarms.get(READINESS_RETRY_ALARM)) !== undefined) return
        await browser.alarms.create(READINESS_RETRY_ALARM, { delayInMinutes: 0.5 })
      },
    },
    makeMessageListener: (waitFor) =>
      makeBackgroundMessageListener({
        ownId: browser.runtime.id,
        handlers: messageHandlers,
        waitFor,
        trace: (stage, error) =>
          traceBackground(stage, {
            detail: error instanceof Error ? error.message : String(error),
          }),
        warn: (message, detail) => console.warn(message, detail),
      }),
    alarms: [
      {
        names: [FETCHED_TERMINAL_CLEANUP_ALARM],
        domain: 'fetched',
        retry: readinessRetry(FETCHED_TERMINAL_CLEANUP_ALARM),
        wake: () => fetchedTransferGateway.retryAutonomousTerminalCleanup(),
      },
      {
        names: [REGISTRY_ALARM, LEGACY_REGISTRY_ALARM],
        domain: 'transfer',
        retry: readinessRetry(REGISTRY_ALARM),
        wake: async () => {
          const registry = transferRegistry
          if (registry === undefined) throw new Error('transfer registry is not booted')
          await registry.onWake()
        },
      },
      {
        names: [SWEEP_HANDOFF_ALARM],
        domain: 'clear',
        retry: readinessRetry(SWEEP_HANDOFF_ALARM),
        wake: async () => await recoverSweepHandoffThroughRelease(releaseRecoveredSweepStarts),
      },
      {
        names: [CLEAR_COORDINATOR_ALARM],
        domain: 'clear',
        retry: readinessRetry(CLEAR_COORDINATOR_ALARM),
        wake: async () => {
          const registry = transferRegistry
          if (registry === undefined) throw new Error('transfer registry is not booted')
          const recovery = await registry.clearRecovery()
          await clearCoordinator.onSafetyWake({
            retryOwnedRequestIds: recovery.retryOwnedRequestIds,
          })
        },
      },
      {
        names: [CLEAR_WORKLIST_PROJECTION_ALARM],
        domain: 'base',
        retry: readinessRetry(CLEAR_WORKLIST_PROJECTION_ALARM),
        wake: () => clearCoordinator.onProjectionWake(),
      },
      {
        names: [syncOutbox.syncAlarm],
        domain: 'base',
        retry: readinessRetry(syncOutbox.syncAlarm),
        wake: () => syncOutbox.onWake(),
      },
      {
        names: [captureOutbox.captureAlarm],
        domain: 'base',
        retry: readinessRetry(captureOutbox.captureAlarm),
        wake: () => captureOutbox.onWake(),
      },
      {
        names: [cloudUpload.uploadAlarm],
        domain: 'cloud',
        retry: readinessRetry(cloudUpload.uploadAlarm),
        wake: () => uploadQueue.push(() => drainUploadJobs()),
      },
    ],
    downloads: {
      releaseCaptureTerminal: (downloadId) =>
        fetchedTransferGateway.releaseCaptureTerminal(downloadId),
      onTransferChanged: onDownloadChanged,
    },
    clear: {
      onBrowserStartup: () => clearCoordinator.onBrowserStartup(),
    },
    trace: (stage, error) =>
      traceBackground(stage, {
        detail: error instanceof Error ? error.message : String(error),
      }),
  })
  resolveReadiness(readiness)
})
