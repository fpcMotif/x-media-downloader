import {
  emptyCaptureSummary,
  finishCaptureSummary,
  foldCaptureSummary,
} from '../core/capture/store'
import { DEFAULT_CAPTURE_SUMMARY_LIMIT } from '../core/capture/contract'
import { decodeSettingsPatch } from '../core/settings/storage'
import {
  projectContentSettings,
  type CaptureExportKind,
  type CaptureExportResult,
  type MediaItem,
  type Settings,
  type SweepEnqueueResponse,
  type SweepScope,
} from '../core/schema'
import type { CaptureArchive } from './capture-archive'
import type { CaptureDb } from './capture-db'
import type { ClearCoordinator } from './clear-coordinator'
import type { CloudUpload } from './cloud-upload'
import type { DailyBudgetStore } from './daily-budget-store'
import type { DownloadHistoryProjection } from './download-history-projection'
import type { DownloadMonitor } from './download-monitor'
import {
  narrowMessageHandler as route,
  type CompleteBackgroundMessageHandlers,
} from './message-router'
import type { SavedStatusCoordinator } from './saved-status'
import type { SettingsInvariantWriter } from './settings-writer'
import type { SyncOutbox } from './sync-outbox'
import type { SyndicationRecovery } from './syndication-recovery'
import type { TransferRegistry } from './transfer-registry'

interface CaptureExporterPort {
  readonly start: (kind: CaptureExportKind, conversationId?: string) => Promise<CaptureExportResult>
}

export interface BackgroundMessageHandlerDeps {
  readonly getSettings: () => Promise<Settings>
  readonly settingsWriter: Pick<SettingsInvariantWriter, 'update' | 'inspectRecovery' | 'recover'>
  readonly broadcastCaptureEpochChanged: () => Promise<void>
  readonly traceBackground: (stage: string, opts?: { readonly detail?: string }) => void
  readonly budgetStore: Pick<DailyBudgetStore, 'readToday' | 'resetToday'>
  readonly clearCoordinator: Pick<ClearCoordinator, 'listClearLog' | 'onVisibilityPulse'>
  /** Read lazily: boot assigns the registry after this handler table is built. */
  readonly registry: () => Pick<TransferRegistry, 'forgetRecovery' | 'inspectRecovery'> | undefined
  readonly launchDownload: (
    items: ReadonlyArray<MediaItem>,
    clearExpect?: ReadonlyArray<{
      readonly tweetId: string
      readonly requestIds: ReadonlyArray<string>
    }>,
  ) => Promise<unknown>
  readonly enqueueSweep: (
    scope: SweepScope,
    posts: ReadonlyArray<{
      readonly tweetId: string
      readonly items: ReadonlyArray<MediaItem>
    }>,
  ) => Promise<SweepEnqueueResponse>
  readonly clearDownloadMonitor: () => Promise<unknown>
  readonly downloadMonitor: Pick<DownloadMonitor, 'read' | 'recordTrace' | 'persist'>
  readonly downloadHistory: Pick<DownloadHistoryProjection, 'list' | 'erase'>
  readonly savedStatusCoordinator: Pick<SavedStatusCoordinator, 'handle'>
  readonly syncOutbox: Pick<SyncOutbox, 'runSyncConnectionTest' | 'getSyncStatus'>
  readonly cloudUpload: Pick<
    CloudUpload,
    | 'runOAuthConnect'
    | 'disconnectProvider'
    | 'cloudUploadStatus'
    | 'retryDeadUploads'
    | 'backfillCloudUploads'
  >
  readonly syndicationRecovery: Pick<SyndicationRecovery, 'recover'>
  readonly captureArchive: CaptureArchive
  readonly captureDb: Pick<CaptureDb, 'fold'>
  readonly captureExporter: CaptureExporterPort
}

/** Builds business handlers only. Wire decode, sender authority, readiness, and
 * listener timing remain owned by the runtime router and entrypoint. */
export const makeBackgroundMessageHandlers = (
  deps: BackgroundMessageHandlerDeps,
): CompleteBackgroundMessageHandlers => ({
  SettingsReadRequest: async () => ({
    _tag: 'SettingsReadSuccess',
    settings: projectContentSettings(await deps.getSettings()),
  }),
  DailyBudgetReadRequest: async () => ({
    _tag: 'DailyBudgetReadSuccess',
    usage: await deps.budgetStore.readToday(),
  }),
  DailyBudgetResetRequest: async () => ({
    _tag: 'DailyBudgetResetSuccess',
    usage: await deps.budgetStore.resetToday(),
  }),
  ClearLogRequest: async () => ({
    _tag: 'ClearLogSuccess',
    records: await deps.clearCoordinator.listClearLog(),
  }),
  SettingsUpdateRequest: route<'SettingsUpdateRequest'>(async (message) => {
    try {
      const settings = await deps.settingsWriter.update(decodeSettingsPatch(message.patch))
      return { _tag: 'SettingsUpdateSuccess' as const, settings }
    } catch (error) {
      deps.traceBackground('settings-update-failed', {
        detail: error instanceof Error ? error.message : String(error),
      })
      return {
        _tag: 'SettingsUpdateFailure' as const,
        reason: 'Settings were not saved.',
      }
    }
  }),
  SettingsRecoveryRequest: route<'SettingsRecoveryRequest'>(async (message) => {
    try {
      if (message.action === 'inspect') return await deps.settingsWriter.inspectRecovery()
      return await deps.settingsWriter.recover(message.action, message.fingerprint)
    } catch (error) {
      deps.traceBackground('settings-recovery-failed', {
        detail: error instanceof Error ? error.message : String(error),
      })
      return {
        _tag: 'SettingsRecoveryFailure' as const,
        reason: 'unavailable' as const,
      }
    }
  }),
  DownloadRequest: route<'DownloadRequest'>((message) =>
    deps.launchDownload(message.items, message.clearExpect),
  ),
  TransferRecoveryRequest: route<'TransferRecoveryRequest'>(async (message) => {
    const registry = deps.registry()
    if (registry === undefined) return { _tag: 'TransferRecoveryUnavailable' as const }
    if (message.action === 'forget') await registry.forgetRecovery(message.id)
    return {
      _tag: 'TransferRecovery' as const,
      items: await registry.inspectRecovery(),
    }
  }),
  MetricsRequest: () => deps.downloadMonitor.read(Date.now()),
  DownloadTraceEvent: route<'DownloadTraceEvent'>(async (message) => {
    deps.downloadMonitor.recordTrace({
      source: message.source,
      stage: message.stage,
      t: message.t,
      ...(message.itemId !== undefined ? { itemId: message.itemId } : {}),
      ...(message.tweetId !== undefined ? { tweetId: message.tweetId } : {}),
      ...(message.type !== undefined ? { type: message.type } : {}),
      ...(message.elapsedMs !== undefined ? { elapsedMs: message.elapsedMs } : {}),
      ...(message.detail !== undefined ? { detail: message.detail } : {}),
    })
    await deps.downloadMonitor.persist(Date.now())
    return { ok: true }
  }),
  ClearDownloadMonitorRequest: () => deps.clearDownloadMonitor(),
  HistoryRequest: async () => ({ records: await deps.downloadHistory.list() }),
  SavedStatusRequest: route<'SavedStatusRequest'>((message) =>
    deps.savedStatusCoordinator.handle(message),
  ),
  ClearHistoryRequest: async () => {
    await deps.downloadHistory.erase()
    return { ok: true }
  },
  SyncTestRequest: async () => deps.syncOutbox.runSyncConnectionTest(await deps.getSettings()),
  SyncStatusRequest: () => deps.syncOutbox.getSyncStatus(),
  CloudConnectRequest: route<'CloudConnectRequest'>((message) =>
    deps.cloudUpload.runOAuthConnect(message.provider, message.clientId),
  ),
  CloudDisconnectRequest: route<'CloudDisconnectRequest'>((message) =>
    deps.cloudUpload.disconnectProvider(message.provider),
  ),
  CloudStatusRequest: () => deps.cloudUpload.cloudUploadStatus(),
  CloudRetryRequest: () => deps.cloudUpload.retryDeadUploads(),
  CloudBackfillRequest: () => deps.cloudUpload.backfillCloudUploads(),
  SweepEnqueueRequest: route<'SweepEnqueueRequest'>((message) =>
    deps.enqueueSweep(message.scope, message.posts),
  ),
  ClearVisibilityPulse: route<'ClearVisibilityPulse'>(async (message, sender) => {
    const tabId = sender.tab?.id
    if (tabId === undefined) return { ok: false }
    await deps.clearCoordinator.onVisibilityPulse(tabId, message.tweetIds)
    return { ok: true }
  }),
  RecoverTweetMediaRequest: route<'RecoverTweetMediaRequest'>(async (message) => {
    const body = await deps.syndicationRecovery.recover(message.tweetId)
    return {
      _tag: 'RecoverTweetMediaResponse',
      ...(body === undefined ? {} : { body }),
    }
  }),
  CaptureEpochRequest: async () => ({
    _tag: 'CaptureEpoch',
    epoch: await deps.captureArchive.epoch(),
  }),
  CaptureTweets: route<'CaptureTweets'>((message) =>
    deps.captureArchive.accept(message.epoch, message.records),
  ),
  CaptureSummaryRequest: route<'CaptureSummaryRequest'>(async (message) =>
    finishCaptureSummary(
      await deps.captureDb.fold(emptyCaptureSummary(), foldCaptureSummary),
      message.limit ?? DEFAULT_CAPTURE_SUMMARY_LIMIT,
    ),
  ),
  ExportCaptureRequest: route<'ExportCaptureRequest'>((message) =>
    deps.captureExporter.start(message.kind, message.conversationId),
  ),
  ClearCaptureRequest: async () => {
    const result = await deps.captureArchive.erase()
    await deps.broadcastCaptureEpochChanged().catch(() => {})
    return result
  },
})
