import type { MediaItem as MediaItemType } from '../schema/media'
import {
  MAX_SWEEP_RECEIPT_ID_LENGTH,
  MAX_TRANSFER_FILENAME_LENGTH,
  MAX_TRANSFER_REGISTRY_ID_LENGTH,
} from '../wire/limits'
import { isJsonWithinByteBudget } from '../wire/json-budget'
import type { BrowserTransferMode } from './transfer-mode'

export type TransferMode = BrowserTransferMode | 'aria2'
export type HistoryProjectionPolicy = 'record' | 'off' | 'transition-only'

/** Durable provenance for one manual Bookmarks/Likes sweep post. */
export interface SweepReceiptRef {
  readonly receiptId: string
  readonly tweetId: string
  readonly scope: 'bookmark' | 'like'
}

/** Durable proof that Clear and its Worklist own a Sweep receipt. */
export interface SweepOwnershipConfirmation {
  readonly receiptId: string
  readonly clearSeedId: number
}

/** Immutable launch intent. `transition-only` is reserved for migrated v2 rows. */
export interface TransferRequest {
  readonly id: string
  /** Stable idempotency key for terminal projections; never inferred at runtime. */
  readonly projectionId: string
  readonly url: string
  readonly filename: string
  readonly mode: TransferMode
  readonly historyPolicy: HistoryProjectionPolicy
  readonly item?: MediaItemType
  /** Present on every artifact derived from one manual sweep post. */
  readonly sweepReceipt?: SweepReceiptRef
}

/** One media save and its optional metadata sibling. Commit it all-or-nothing. */
export interface TransferLaunchGroup {
  /** Canonical main-media request ID. Never a sidecar ID. */
  readonly mainId: string
  readonly requests: readonly TransferRequest[]
}

export interface Aria2ProfileSnapshot {
  readonly profileId: string
  readonly rpcUrl: string
  readonly secret: string
}
export interface Aria2LaunchReservation {
  readonly profile: Aria2ProfileSnapshot
  /** aria2 GID preallocated by the shell before `addUri`. */
  readonly gid: string
  /** Durable call options. Boot recovery never reads changed settings. */
  readonly options: Aria2LaunchOptionsSnapshot
}

export interface Aria2LaunchOptionsSnapshot {
  readonly split: number
  readonly dir?: string
}

export interface Aria2Profile extends Aria2ProfileSnapshot {
  readonly failureCount: number
  readonly nextProbeAt: number
}

export type Aria2UnresolvedReason = 'call-ambiguous' | 'confirmed-unbound' | 'legacy-false-handoff'

export interface Aria2Progress {
  readonly completedLength: string
  readonly totalLength: string
}

export type Aria2LiveStatus = 'active' | 'waiting' | 'paused'

export type TerminalEvidence =
  | { readonly tag: 'start-failed' }
  | {
      readonly tag: 'browser'
      readonly downloadId: number
      readonly state: 'complete' | 'interrupted'
      readonly bytesReceived?: number
      readonly totalBytes?: number
    }
  | {
      readonly tag: 'aria2'
      readonly gid: string
      readonly profileId: string
      readonly status: 'complete' | 'error' | 'removed'
      readonly completedLength: string
      readonly totalLength: string
      readonly errorCode?: string
      readonly errorMessage?: string
    }

export type TransferPhase =
  | { readonly tag: 'launching'; readonly attempt: number; readonly since: number }
  /** Durable Direct intent still held by its live coordinator. */
  | { readonly tag: 'direct-prepared'; readonly attempt: 0; readonly since: number }
  /** Durable Direct intent. No browser call is armed yet. */
  | { readonly tag: 'direct-ready'; readonly attempt: 0; readonly since: number }
  /** Durable Fetched intent still held by its live coordinator. */
  | { readonly tag: 'fetched-prepared'; readonly attempt: 0; readonly since: number }
  /** Durable Fetched intent. No lease, response, or browser handoff exists yet. */
  | {
      readonly tag: 'ready'
      readonly attempt: number
      readonly since: number
      readonly priorDownloadId?: number
    }
  /** Fetched capacity is full. No response was opened and no browser handoff occurred. */
  | {
      readonly tag: 'fetched-capacity-wait'
      readonly attempt: number
      readonly retryAt: number
      readonly priorDownloadId?: number
    }
  /** The exact durable lease is reserved; `startReserved` may now run once. */
  | {
      readonly tag: 'fetched-call-armed'
      readonly attempt: number
      readonly since: number
      readonly armedAt: number
      readonly leaseId: string
      readonly priorDownloadId?: number
    }
  | {
      readonly tag: 'active'
      readonly downloadId: number
      readonly attempt: number
      readonly startedAt: number
      readonly nextProbeAt: number
    }
  | {
      readonly tag: 'retry-wait'
      readonly attempt: number
      readonly retryAt: number
      readonly priorDownloadId: number
    }
  /** A URL refresh was requested before a retry can reach Chrome. Safe to replay after boot. */
  | {
      readonly tag: 'retry-refreshing'
      readonly attempt: number
      readonly since: number
      readonly priorDownloadId: number
    }
  | {
      readonly tag: 'retry-launching'
      readonly attempt: number
      readonly since: number
      readonly priorDownloadId: number
    }
  | {
      readonly tag: 'unresolved-launch'
      readonly attempt: number
      readonly since: number
      readonly reason: 'worker-restart' | 'handle-bind-failed'
    }
  | {
      readonly tag: 'browser-unresolved'
      readonly attempt: number
      readonly since: number
      readonly reason: 'worker-restart' | 'handle-bind-failed'
      readonly downloadId: number
      readonly nextProbeAt: number
    }
  | {
      readonly tag: 'aria2-launching'
      readonly attempt: number
      readonly since: number
      readonly profileId: string
      readonly gid: string
    }
  /** Durable aria2 intent still held by its live coordinator. */
  | {
      readonly tag: 'aria2-prepared'
      readonly attempt: 0
      readonly since: number
      readonly profileId: string
      readonly gid: string
      readonly options: Aria2LaunchOptionsSnapshot
    }
  /** Durable aria2 intent with every option needed for one fenced boot resume. */
  | {
      readonly tag: 'aria2-ready'
      readonly attempt: 0
      readonly since: number
      readonly profileId: string
      readonly gid: string
      readonly options: Aria2LaunchOptionsSnapshot
    }
  | {
      readonly tag: 'aria2-active'
      readonly gid: string
      readonly profileId: string
      readonly startedAt: number
      readonly status?: Aria2LiveStatus
      readonly progress?: Aria2Progress
    }
  | {
      /** addUri may now have reached aria2; binding remains a separate durable step. */
      readonly tag: 'aria2-call-armed'
      readonly attempt: number
      readonly since: number
      readonly armedAt: number
      readonly profileId: string
      readonly gid: string
    }
  | {
      readonly tag: 'aria2-unresolved'
      readonly since: number
      readonly reason: Aria2UnresolvedReason
      readonly gid?: string
      readonly profileId?: string
    }
  /** A user requested dismissal; retain the exact uncertain row until its Clear fence commits. */
  | {
      readonly tag: 'forget-pending'
      readonly since: number
      readonly recovery: TransferRecoveryPhase
    }
  | {
      readonly tag: 'terminal-pending'
      readonly evidence: TerminalEvidence
      readonly observedAt: number
      readonly projectAt: number
    }

export type TransferRecoveryPhase =
  | { readonly tag: 'direct-prepared'; readonly attempt: 0; readonly since: number }
  | { readonly tag: 'fetched-prepared'; readonly attempt: 0; readonly since: number }
  | {
      readonly tag: 'aria2-prepared'
      readonly attempt: 0
      readonly since: number
      readonly profileId: string
      readonly gid: string
      readonly options: Aria2LaunchOptionsSnapshot
    }
  | {
      readonly tag: 'unresolved-launch'
      readonly attempt: number
      readonly since: number
      readonly reason: 'worker-restart' | 'handle-bind-failed'
    }
  | {
      readonly tag: 'browser-unresolved'
      readonly attempt: number
      readonly since: number
      readonly reason: 'worker-restart' | 'handle-bind-failed'
      readonly downloadId: number
      readonly nextProbeAt: number
    }
  | {
      readonly tag: 'aria2-unresolved'
      readonly since: number
      readonly reason: Aria2UnresolvedReason
      readonly gid?: string
      readonly profileId?: string
    }

export interface TransferEntry {
  readonly request: TransferRequest
  readonly createdAt: number
  readonly phase: TransferPhase
  readonly sweepOwnership?: SweepOwnershipConfirmation
}

export type LegacyTransferPhase =
  | { readonly tag: 'active'; readonly nextProbeAt: number }
  | {
      readonly tag: 'terminal-pending'
      readonly outcome: 'complete' | 'failed'
      readonly at: number
      readonly projectAt: number
    }
  | { readonly tag: 'forget-pending'; readonly since: number }
  | { readonly tag: 'unresolved' }

export interface LegacyTransferEntry {
  readonly downloadId: number
  readonly startedAt: number
  readonly tweetId?: string
  readonly phase: LegacyTransferPhase
}

export interface TransferRegistryStore {
  readonly version: 4
  readonly entries: Readonly<Record<string, TransferEntry>>
  readonly profiles: Readonly<Record<string, Aria2Profile>>
  readonly legacy: Readonly<Record<string, LegacyTransferEntry>>
}

export const TRANSFER_REGISTRY_VERSION = 4 as const
export const MAX_TRANSFER_REGISTRY_ENTRIES = 5000
/** Shared durable-field limits. Fetched lease ownership reuses the ID bound. */
/** Bounds service-worker decode and storage work below Chrome's default local quota. */
export const MAX_TRANSFER_REGISTRY_STORE_BYTES = 8 * 1024 * 1024
export const MAX_TRANSFER_REGISTRY_URL_LENGTH = 8_192
export const MAX_TRANSFER_REGISTRY_FILENAME_LENGTH = MAX_TRANSFER_FILENAME_LENGTH
/** Caps all Media Item fields without giving each persisted source field a new limit. */
export const MAX_TRANSFER_REGISTRY_MEDIA_ITEM_BYTES = 16_384
export const MAX_ARIA2_PROFILE_RPC_URL_LENGTH = 2_048
export const MAX_ARIA2_PROFILE_SECRET_LENGTH = 1_024
export const MAX_ARIA2_LAUNCH_DIR_LENGTH = 4_096
export const MAX_TRANSFER_ATTEMPTS = 3
/** Retry a durable Fetched-capacity wait without retaining an MV3 promise/body. */
export const FETCHED_CAPACITY_RETRY_MS = 5_000
export const MAX_ARIA2_PROFILE_FAILURES = 8
/** Kept equal to the aria2 protocol decoder bounds. */
export const ARIA2_DECIMAL_MAX_DIGITS = 32
export const ARIA2_ERROR_CODE_MAX_LENGTH = 32
export const ARIA2_ERROR_MESSAGE_MAX_LENGTH = 1_024
export const ARIA2_PROFILE_BACKOFF_BASE_MS = 1_000
export const ARIA2_PROFILE_BACKOFF_MAX_MS = 300_000
export const TERMINAL_PROJECT_RETRY_MS = 6_000
export const emptyTransferRegistryStore: TransferRegistryStore = {
  version: TRANSFER_REGISTRY_VERSION,
  entries: {},
  profiles: {},
  legacy: {},
}

export interface LaunchToken {
  readonly id: string
  readonly attempt: number
  readonly since: number
  readonly gid?: string
  readonly priorDownloadId?: number
}
/** Fences one URL-refresh reply to one exact interrupted browser transfer. */
export interface RetryRefreshToken {
  readonly id: string
  readonly projectionId: string
  readonly createdAt: number
  readonly attempt: number
  readonly since: number
  readonly priorDownloadId: number
}
/** Fences a forget completion from an older row or an earlier user action. */
export interface ForgetTransferToken {
  readonly id: string
  readonly projectionId: string
  readonly createdAt: number
  readonly since: number
}
/** Fences one legacy recovery dismissal across a Clear-side write. */
export interface LegacyForgetTransferToken {
  readonly id: string
  readonly downloadId: number
  readonly startedAt: number
  readonly since: number
}
export interface RegistryMutation {
  readonly state: TransferRegistryStore
  readonly changed: boolean
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
export const hasExactKeys = (
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> =>
  isRecord(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key))
export const isBoundedText = (value: unknown, maxLength: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength
export const isText = (value: unknown): value is string =>
  isBoundedText(value, MAX_TRANSFER_REGISTRY_ID_LENGTH)
export const isSafeId = (value: unknown): value is string =>
  isText(value) && !Object.hasOwn(Object.prototype, value)
export const isSweepReceiptId = (value: unknown): value is string =>
  isBoundedText(value, MAX_SWEEP_RECEIPT_ID_LENGTH) && !Object.hasOwn(Object.prototype, value)
export const isTransferUrl = (value: unknown): value is string =>
  isBoundedText(value, MAX_TRANSFER_REGISTRY_URL_LENGTH)
export const isTransferFilename = (value: unknown): value is string =>
  isBoundedText(value, MAX_TRANSFER_REGISTRY_FILENAME_LENGTH)
/** Canonical daemon endpoint key. Secrets authenticate; they do not scope aria2 GIDs. */
export const aria2EndpointIdentity = (value: unknown): string | undefined => {
  if (!isBoundedText(value, MAX_ARIA2_PROFILE_RPC_URL_LENGTH)) return
  try {
    const url = new URL(value)
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username !== '' ||
      url.password !== ''
    )
      return
    url.username = ''
    url.password = ''
    url.hash = ''
    return url.href
  } catch {
    return
  }
}
export const isAria2ProfileRpcUrl = (value: unknown): value is string =>
  aria2EndpointIdentity(value) !== undefined
export const isAria2ProfileSecret = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= MAX_ARIA2_PROFILE_SECRET_LENGTH
export const isAria2LaunchOptionsSnapshot = (
  value: unknown,
): value is Aria2LaunchOptionsSnapshot => {
  if (!isRecord(value)) return false
  const hasDir = Object.hasOwn(value, 'dir')
  return (
    hasExactKeys(value, ['split', ...(hasDir ? ['dir'] : [])]) &&
    typeof value.split === 'number' &&
    Number.isSafeInteger(value.split) &&
    value.split >= 1 &&
    value.split <= 16 &&
    (!hasDir || (typeof value.dir === 'string' && value.dir.length <= MAX_ARIA2_LAUNCH_DIR_LENGTH))
  )
}
export const isBoundedJson = (value: unknown, maxBytes: number): boolean =>
  isJsonWithinByteBudget(value, maxBytes)
export const isRegistryTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
export const isAttempt = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= MAX_TRANSFER_ATTEMPTS
export const isFailureCount = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= MAX_ARIA2_PROFILE_FAILURES
export const isDownloadId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
/** aria2 numeric fields are unrounded decimal integers. */
export const isCanonicalDecimal = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= ARIA2_DECIMAL_MAX_DIGITS &&
  /^(0|[1-9][0-9]*)$/.test(value)
export const isAria2ErrorCode = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= ARIA2_ERROR_CODE_MAX_LENGTH &&
  /^(0|[1-9][0-9]*)$/.test(value)
export const isAria2ErrorMessage = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= ARIA2_ERROR_MESSAGE_MAX_LENGTH
export const isAria2Gid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-fA-F]{16}$/.test(value) && value !== '0000000000000000'
