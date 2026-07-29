import { mediaRequestId } from '../core/download/request-identity'
import type { BackgroundRequest } from '../core/schema'

export type MessageReadinessDomain = 'base' | 'fetched' | 'transfer' | 'clear' | 'cloud'

const assertNever = (message: never): never => {
  throw new Error(`Unhandled background message: ${String(message)}`)
}

/** One explicit owner for every decoded message. */
export function messageReadinessDomain(message: BackgroundRequest): MessageReadinessDomain {
  switch (message._tag) {
    case 'DownloadRequest':
    case 'TransferRecoveryRequest':
      return 'transfer'
    case 'ExportCaptureRequest':
      return 'fetched'
    case 'SweepEnqueueRequest':
    case 'ClearVisibilityPulse':
      return 'clear'
    case 'CloudConnectRequest':
    case 'CloudDisconnectRequest':
    case 'CloudStatusRequest':
    case 'CloudRetryRequest':
    case 'CloudBackfillRequest':
      return 'cloud'
    // The verified log is a strict lazy read. Transfer corruption must not hide it.
    case 'ClearLogRequest':
      return 'base'
    case 'SettingsUpdateRequest':
    case 'SettingsReadRequest':
    case 'SettingsRecoveryRequest':
    case 'MetricsRequest':
    case 'DownloadTraceEvent':
    case 'ClearDownloadMonitorRequest':
    case 'HistoryRequest':
    case 'ClearHistoryRequest':
    case 'DailyBudgetReadRequest':
    case 'DailyBudgetResetRequest':
    case 'SyncTestRequest':
    case 'SyncStatusRequest':
    case 'RecoverTweetMediaRequest':
    case 'SavedStatusRequest':
    case 'CaptureEpochRequest':
    case 'CaptureTweets':
    case 'CaptureSummaryRequest':
    case 'ClearCaptureRequest':
      return 'base'
  }
  return assertNever(message)
}

/** Exact wire replies for an unavailable non-base owner. */
export function unavailableMessageReply(
  message: BackgroundRequest,
): { readonly value: unknown } | undefined {
  switch (message._tag) {
    case 'SettingsUpdateRequest':
      return {
        value: {
          _tag: 'SettingsUpdateFailure',
          reason: 'Settings are unavailable.',
        },
      }
    case 'SettingsReadRequest':
      return { value: { _tag: 'SettingsReadUnavailable' } }
    case 'SettingsRecoveryRequest':
      return {
        value: {
          _tag: 'SettingsRecoveryFailure',
          reason: 'unavailable',
        },
      }
    case 'DailyBudgetReadRequest':
    case 'DailyBudgetResetRequest':
      return { value: { _tag: 'DailyBudgetUnavailable' } }
    case 'ClearLogRequest':
      return { value: { _tag: 'ClearLogUnavailable' } }
    case 'DownloadRequest':
      return {
        value: {
          _tag: 'QueueUpdate',
          planned: message.items.map(mediaRequestId),
          started: [],
          deferred: [],
          duplicates: [],
          failures: message.items.map((item) => ({
            requestId: mediaRequestId(item),
            reason: 'transfer unavailable',
          })),
          skipped: [],
        },
      }
    case 'TransferRecoveryRequest':
      return { value: { _tag: 'TransferRecoveryUnavailable' } }
    case 'ExportCaptureRequest':
      return { value: { _tag: 'CaptureExportUnavailable' } }
    case 'SweepEnqueueRequest':
      return { value: { _tag: 'SweepEnqueueUnavailable' } }
    case 'ClearVisibilityPulse':
      return { value: { ok: false } }
    case 'CloudConnectRequest':
      return { value: { ok: false, detail: 'Cloud uploads are unavailable.' } }
    case 'CloudDisconnectRequest':
    case 'CloudRetryRequest':
      return { value: { ok: false } }
    case 'CloudStatusRequest':
      return { value: null }
    case 'CloudBackfillRequest':
      return {
        value: {
          ok: false,
          queued: 0,
          detail: 'Cloud uploads are unavailable.',
        },
      }
    default:
      return undefined
  }
}
