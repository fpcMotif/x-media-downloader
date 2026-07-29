import { Schema } from 'effect'
import { MediaItem, type MediaItem as MediaItemType } from '../schema/media'
import { isTransferProjectionId } from '../wire/identity'
import { isCompatibleMediaRequestId, mediaRequestId } from './request-identity'
import {
  aria2EndpointIdentity,
  emptyTransferRegistryStore,
  isBoundedJson,
  isAria2ErrorCode,
  isAria2ErrorMessage,
  isAria2LaunchOptionsSnapshot,
  isAria2ProfileRpcUrl,
  isAria2ProfileSecret,
  hasExactKeys,
  isAria2Gid,
  isAttempt,
  isCanonicalDecimal,
  isDownloadId,
  isFailureCount,
  isRecord,
  isRegistryTime,
  isSafeId,
  isSweepReceiptId,
  isTransferFilename,
  isTransferUrl,
  isText,
  MAX_TRANSFER_REGISTRY_ENTRIES,
  MAX_TRANSFER_REGISTRY_MEDIA_ITEM_BYTES,
  MAX_TRANSFER_REGISTRY_STORE_BYTES,
  TRANSFER_REGISTRY_VERSION,
  type Aria2Profile,
  type LegacyTransferEntry,
  type LegacyTransferPhase,
  type TerminalEvidence,
  type TransferEntry,
  type TransferPhase,
  type TransferRequest,
  type TransferRegistryStore,
  type SweepOwnershipConfirmation,
} from './transfer-registry-model'

const mediaKeys = [
  'id',
  'platform',
  'postId',
  'author',
  'type',
  'url',
  'previewUrl',
  'ext',
  'index',
  'width',
  'height',
  'bitrate',
] as const
const mediaRequired = ['id', 'platform', 'postId', 'author', 'type', 'url', 'ext', 'index'] as const
const normalizedGid = (value: unknown): string | undefined =>
  isAria2Gid(value) ? value.toLowerCase() : undefined
const decodeMediaItem = (value: unknown): MediaItemType | undefined => {
  if (
    !isRecord(value) ||
    !mediaRequired.every((key) => Object.hasOwn(value, key)) ||
    !Object.keys(value).every((key) => (mediaKeys as readonly string[]).includes(key))
  )
    return undefined
  if (!isBoundedJson(value, MAX_TRANSFER_REGISTRY_MEDIA_ITEM_BYTES)) return undefined
  try {
    return Schema.decodeUnknownSync(MediaItem)(value)
  } catch {
    return undefined
  }
}

export function decodeTransferRequest(value: unknown): TransferRequest | undefined {
  if (!isRecord(value)) return undefined
  const hasItem = Object.hasOwn(value, 'item')
  const hasSweepReceipt = Object.hasOwn(value, 'sweepReceipt')
  if (
    !hasExactKeys(
      value,
      hasItem
        ? [
            'id',
            'projectionId',
            'url',
            'filename',
            'mode',
            'historyPolicy',
            'item',
            ...(hasSweepReceipt ? ['sweepReceipt'] : []),
          ]
        : [
            'id',
            'projectionId',
            'url',
            'filename',
            'mode',
            'historyPolicy',
            ...(hasSweepReceipt ? ['sweepReceipt'] : []),
          ],
    ) ||
    !isSafeId(value.id) ||
    !isSafeId(value.projectionId) ||
    !isTransferProjectionId(value.projectionId) ||
    !isTransferUrl(value.url) ||
    !isTransferFilename(value.filename) ||
    (value.mode !== 'direct' && value.mode !== 'fetched' && value.mode !== 'aria2') ||
    (value.historyPolicy !== 'record' &&
      value.historyPolicy !== 'off' &&
      value.historyPolicy !== 'transition-only')
  )
    return undefined
  const item = hasItem ? decodeMediaItem(value.item) : undefined
  const sweepReceipt = hasSweepReceipt ? decodeSweepReceipt(value.sweepReceipt) : undefined
  if (
    (hasItem && item === undefined) ||
    (hasSweepReceipt && sweepReceipt === undefined) ||
    (item !== undefined && !isCompatibleMediaRequestId(value.id, item))
  )
    return undefined
  return {
    id: value.id,
    projectionId: value.projectionId,
    url: value.url,
    filename: value.filename,
    mode: value.mode,
    historyPolicy: value.historyPolicy,
    ...(item === undefined ? {} : { item }),
    ...(sweepReceipt === undefined ? {} : { sweepReceipt }),
  }
}

const decodeSweepReceipt = (
  value: unknown,
):
  | { readonly receiptId: string; readonly tweetId: string; readonly scope: 'bookmark' | 'like' }
  | undefined => {
  if (
    !hasExactKeys(value, ['receiptId', 'tweetId', 'scope']) ||
    !isSweepReceiptId(value.receiptId) ||
    typeof value.tweetId !== 'string' ||
    !/^[0-9]{1,20}$/.test(value.tweetId) ||
    (value.scope !== 'bookmark' && value.scope !== 'like')
  )
    return undefined
  return { receiptId: value.receiptId, tweetId: value.tweetId, scope: value.scope }
}

function decodeEvidence(value: unknown): TerminalEvidence | undefined {
  if (!isRecord(value) || !isText(value.tag)) return undefined
  if (value.tag === 'start-failed')
    return hasExactKeys(value, ['tag']) ? { tag: 'start-failed' } : undefined
  if (value.tag === 'browser') {
    const hasBytes = Object.hasOwn(value, 'bytesReceived')
    const hasTotal = Object.hasOwn(value, 'totalBytes')
    if (
      !hasExactKeys(value, [
        'tag',
        'downloadId',
        'state',
        ...(hasBytes ? ['bytesReceived'] : []),
        ...(hasTotal ? ['totalBytes'] : []),
      ]) ||
      !isDownloadId(value.downloadId) ||
      (value.state !== 'complete' && value.state !== 'interrupted') ||
      (hasBytes && !isDownloadId(value.bytesReceived)) ||
      (hasTotal && !isDownloadId(value.totalBytes))
    )
      return undefined
    return {
      tag: 'browser',
      downloadId: value.downloadId,
      state: value.state,
      ...(hasBytes ? { bytesReceived: value.bytesReceived as number } : {}),
      ...(hasTotal ? { totalBytes: value.totalBytes as number } : {}),
    }
  }
  if (value.tag === 'aria2') {
    const hasCode = Object.hasOwn(value, 'errorCode'),
      hasMessage = Object.hasOwn(value, 'errorMessage')
    const gid = normalizedGid(value.gid)
    if (
      !hasExactKeys(value, [
        'tag',
        'gid',
        'profileId',
        'status',
        'completedLength',
        'totalLength',
        ...(hasCode ? ['errorCode'] : []),
        ...(hasMessage ? ['errorMessage'] : []),
      ]) ||
      gid === undefined ||
      !isSafeId(value.profileId) ||
      (value.status !== 'complete' && value.status !== 'error' && value.status !== 'removed') ||
      !isCanonicalDecimal(value.completedLength) ||
      !isCanonicalDecimal(value.totalLength) ||
      (hasCode && !isAria2ErrorCode(value.errorCode)) ||
      (hasMessage && !isAria2ErrorMessage(value.errorMessage))
    )
      return undefined
    return {
      tag: 'aria2',
      gid,
      profileId: value.profileId,
      status: value.status,
      completedLength: value.completedLength,
      totalLength: value.totalLength,
      ...(hasCode ? { errorCode: value.errorCode as string } : {}),
      ...(hasMessage ? { errorMessage: value.errorMessage as string } : {}),
    }
  }
  return undefined
}

type TransferRegistryWireVersion = 3 | typeof TRANSFER_REGISTRY_VERSION

function decodePhase(
  value: unknown,
  version: TransferRegistryWireVersion,
  allowForgetPending = true,
): TransferPhase | undefined {
  if (!isRecord(value) || !isText(value.tag)) return undefined
  switch (value.tag) {
    case 'launching':
      return hasExactKeys(value, ['tag', 'attempt', 'since']) &&
        isAttempt(value.attempt) &&
        isRegistryTime(value.since)
        ? { tag: 'launching', attempt: value.attempt, since: value.since }
        : undefined
    case 'direct-prepared':
      return version === TRANSFER_REGISTRY_VERSION &&
        hasExactKeys(value, ['tag', 'attempt', 'since']) &&
        value.attempt === 0 &&
        isRegistryTime(value.since)
        ? { tag: 'direct-prepared', attempt: 0, since: value.since }
        : undefined
    case 'direct-ready':
      return version === TRANSFER_REGISTRY_VERSION &&
        hasExactKeys(value, ['tag', 'attempt', 'since']) &&
        value.attempt === 0 &&
        isRegistryTime(value.since)
        ? { tag: 'direct-ready', attempt: 0, since: value.since }
        : undefined
    case 'fetched-prepared':
      return version === TRANSFER_REGISTRY_VERSION &&
        hasExactKeys(value, ['tag', 'attempt', 'since']) &&
        value.attempt === 0 &&
        isRegistryTime(value.since)
        ? { tag: 'fetched-prepared', attempt: 0, since: value.since }
        : undefined
    case 'ready': {
      const hasPrior = Object.hasOwn(value, 'priorDownloadId')
      return hasExactKeys(value, [
        'tag',
        'attempt',
        'since',
        ...(hasPrior ? ['priorDownloadId'] : []),
      ]) &&
        isAttempt(value.attempt) &&
        isRegistryTime(value.since) &&
        (hasPrior ? value.attempt > 0 && isDownloadId(value.priorDownloadId) : value.attempt === 0)
        ? {
            tag: 'ready',
            attempt: value.attempt,
            since: value.since,
            ...(hasPrior ? { priorDownloadId: value.priorDownloadId as number } : {}),
          }
        : undefined
    }
    case 'fetched-capacity-wait': {
      const hasPrior = Object.hasOwn(value, 'priorDownloadId')
      return hasExactKeys(value, [
        'tag',
        'attempt',
        'retryAt',
        ...(hasPrior ? ['priorDownloadId'] : []),
      ]) &&
        isAttempt(value.attempt) &&
        isRegistryTime(value.retryAt) &&
        (hasPrior ? value.attempt > 0 && isDownloadId(value.priorDownloadId) : value.attempt === 0)
        ? {
            tag: 'fetched-capacity-wait',
            attempt: value.attempt,
            retryAt: value.retryAt,
            ...(hasPrior ? { priorDownloadId: value.priorDownloadId as number } : {}),
          }
        : undefined
    }
    case 'fetched-call-armed': {
      const hasPrior = Object.hasOwn(value, 'priorDownloadId')
      return hasExactKeys(value, [
        'tag',
        'attempt',
        'since',
        'armedAt',
        'leaseId',
        ...(hasPrior ? ['priorDownloadId'] : []),
      ]) &&
        isAttempt(value.attempt) &&
        isRegistryTime(value.since) &&
        isRegistryTime(value.armedAt) &&
        value.armedAt >= value.since &&
        isSafeId(value.leaseId) &&
        (hasPrior ? value.attempt > 0 && isDownloadId(value.priorDownloadId) : value.attempt === 0)
        ? {
            tag: 'fetched-call-armed',
            attempt: value.attempt,
            since: value.since,
            armedAt: value.armedAt,
            leaseId: value.leaseId,
            ...(hasPrior ? { priorDownloadId: value.priorDownloadId as number } : {}),
          }
        : undefined
    }
    case 'active':
      return hasExactKeys(value, ['tag', 'downloadId', 'attempt', 'startedAt', 'nextProbeAt']) &&
        isDownloadId(value.downloadId) &&
        isAttempt(value.attempt) &&
        isRegistryTime(value.startedAt) &&
        isRegistryTime(value.nextProbeAt) &&
        value.nextProbeAt >= value.startedAt
        ? {
            tag: 'active',
            downloadId: value.downloadId,
            attempt: value.attempt,
            startedAt: value.startedAt,
            nextProbeAt: value.nextProbeAt,
          }
        : undefined
    case 'retry-wait':
      return hasExactKeys(value, ['tag', 'attempt', 'retryAt', 'priorDownloadId']) &&
        isAttempt(value.attempt) &&
        value.attempt > 0 &&
        isRegistryTime(value.retryAt) &&
        isDownloadId(value.priorDownloadId)
        ? {
            tag: 'retry-wait',
            attempt: value.attempt,
            retryAt: value.retryAt,
            priorDownloadId: value.priorDownloadId,
          }
        : undefined
    case 'retry-refreshing':
      return hasExactKeys(value, ['tag', 'attempt', 'since', 'priorDownloadId']) &&
        isAttempt(value.attempt) &&
        value.attempt > 0 &&
        isRegistryTime(value.since) &&
        isDownloadId(value.priorDownloadId)
        ? {
            tag: 'retry-refreshing',
            attempt: value.attempt,
            since: value.since,
            priorDownloadId: value.priorDownloadId,
          }
        : undefined
    case 'retry-launching':
      return hasExactKeys(value, ['tag', 'attempt', 'since', 'priorDownloadId']) &&
        isAttempt(value.attempt) &&
        value.attempt > 0 &&
        isRegistryTime(value.since) &&
        isDownloadId(value.priorDownloadId)
        ? {
            tag: 'retry-launching',
            attempt: value.attempt,
            since: value.since,
            priorDownloadId: value.priorDownloadId,
          }
        : undefined
    case 'unresolved-launch': {
      if (
        !hasExactKeys(value, ['tag', 'attempt', 'since', 'reason']) ||
        !isAttempt(value.attempt) ||
        !isRegistryTime(value.since) ||
        (value.reason !== 'worker-restart' && value.reason !== 'handle-bind-failed')
      )
        return undefined
      return {
        tag: 'unresolved-launch',
        attempt: value.attempt,
        since: value.since,
        reason: value.reason,
      }
    }
    case 'browser-unresolved':
      return hasExactKeys(value, [
        'tag',
        'attempt',
        'since',
        'reason',
        'downloadId',
        'nextProbeAt',
      ]) &&
        isAttempt(value.attempt) &&
        isRegistryTime(value.since) &&
        (value.reason === 'worker-restart' || value.reason === 'handle-bind-failed') &&
        isDownloadId(value.downloadId) &&
        isRegistryTime(value.nextProbeAt) &&
        value.nextProbeAt >= value.since
        ? {
            tag: 'browser-unresolved',
            attempt: value.attempt,
            since: value.since,
            reason: value.reason,
            downloadId: value.downloadId,
            nextProbeAt: value.nextProbeAt,
          }
        : undefined
    case 'aria2-launching': {
      const gid = normalizedGid(value.gid)
      return hasExactKeys(value, ['tag', 'attempt', 'since', 'profileId', 'gid']) &&
        isAttempt(value.attempt) &&
        isRegistryTime(value.since) &&
        isSafeId(value.profileId) &&
        gid !== undefined
        ? {
            tag: 'aria2-launching',
            attempt: value.attempt,
            since: value.since,
            profileId: value.profileId,
            gid,
          }
        : undefined
    }
    case 'aria2-prepared': {
      if (version !== TRANSFER_REGISTRY_VERSION) return undefined
      const gid = normalizedGid(value.gid)
      return hasExactKeys(value, ['tag', 'attempt', 'since', 'profileId', 'gid', 'options']) &&
        value.attempt === 0 &&
        isRegistryTime(value.since) &&
        isSafeId(value.profileId) &&
        gid !== undefined &&
        isAria2LaunchOptionsSnapshot(value.options)
        ? {
            tag: 'aria2-prepared',
            attempt: 0,
            since: value.since,
            profileId: value.profileId,
            gid,
            options: value.options,
          }
        : undefined
    }
    case 'aria2-ready': {
      if (version !== TRANSFER_REGISTRY_VERSION) return undefined
      const gid = normalizedGid(value.gid)
      return hasExactKeys(value, ['tag', 'attempt', 'since', 'profileId', 'gid', 'options']) &&
        value.attempt === 0 &&
        isRegistryTime(value.since) &&
        isSafeId(value.profileId) &&
        gid !== undefined &&
        isAria2LaunchOptionsSnapshot(value.options)
        ? {
            tag: 'aria2-ready',
            attempt: 0,
            since: value.since,
            profileId: value.profileId,
            gid,
            options: value.options,
          }
        : undefined
    }
    case 'aria2-active': {
      const hasStatus = Object.hasOwn(value, 'status'),
        hasProgress = Object.hasOwn(value, 'progress')
      const gid = normalizedGid(value.gid)
      if (
        !hasExactKeys(value, [
          'tag',
          'gid',
          'profileId',
          'startedAt',
          ...(hasStatus ? ['status'] : []),
          ...(hasProgress ? ['progress'] : []),
        ]) ||
        gid === undefined ||
        !isSafeId(value.profileId) ||
        !isRegistryTime(value.startedAt) ||
        (hasStatus &&
          value.status !== 'active' &&
          value.status !== 'waiting' &&
          value.status !== 'paused')
      )
        return undefined
      const progress =
        hasProgress &&
        isRecord(value.progress) &&
        hasExactKeys(value.progress, ['completedLength', 'totalLength']) &&
        isCanonicalDecimal(value.progress.completedLength) &&
        isCanonicalDecimal(value.progress.totalLength)
          ? {
              completedLength: value.progress.completedLength,
              totalLength: value.progress.totalLength,
            }
          : hasProgress
            ? undefined
            : undefined
      if (hasProgress && progress === undefined) return undefined
      return {
        tag: 'aria2-active',
        gid,
        profileId: value.profileId,
        startedAt: value.startedAt,
        ...(hasStatus ? { status: value.status as 'active' | 'waiting' | 'paused' } : {}),
        ...(progress === undefined ? {} : { progress }),
      }
    }
    case 'aria2-call-armed': {
      const gid = normalizedGid(value.gid)
      return hasExactKeys(value, ['tag', 'attempt', 'since', 'armedAt', 'profileId', 'gid']) &&
        isAttempt(value.attempt) &&
        isRegistryTime(value.since) &&
        isRegistryTime(value.armedAt) &&
        value.armedAt >= value.since &&
        isSafeId(value.profileId) &&
        gid !== undefined
        ? {
            tag: 'aria2-call-armed',
            attempt: value.attempt,
            since: value.since,
            armedAt: value.armedAt,
            profileId: value.profileId,
            gid,
          }
        : undefined
    }
    case 'aria2-unresolved': {
      const hasGid = Object.hasOwn(value, 'gid'),
        hasProfile = Object.hasOwn(value, 'profileId')
      const gid = hasGid ? normalizedGid(value.gid) : undefined
      if (
        !hasExactKeys(value, [
          'tag',
          'since',
          'reason',
          ...(hasGid ? ['gid'] : []),
          ...(hasProfile ? ['profileId'] : []),
        ]) ||
        !isRegistryTime(value.since) ||
        (value.reason !== 'call-ambiguous' &&
          value.reason !== 'confirmed-unbound' &&
          value.reason !== 'legacy-false-handoff') ||
        (hasGid && gid === undefined) ||
        (hasProfile && !isSafeId(value.profileId)) ||
        (value.reason === 'legacy-false-handoff' ? hasGid || hasProfile : !hasGid || !hasProfile)
      )
        return undefined
      return {
        tag: 'aria2-unresolved',
        since: value.since,
        reason: value.reason,
        ...(gid === undefined ? {} : { gid }),
        ...(hasProfile ? { profileId: value.profileId as string } : {}),
      }
    }
    case 'forget-pending': {
      if (
        !allowForgetPending ||
        !hasExactKeys(value, ['tag', 'since', 'recovery']) ||
        !isRegistryTime(value.since)
      )
        return undefined
      const recovery = decodePhase(value.recovery, version, false)
      if (
        recovery?.tag !== 'direct-prepared' &&
        recovery?.tag !== 'fetched-prepared' &&
        recovery?.tag !== 'aria2-prepared' &&
        recovery?.tag !== 'unresolved-launch' &&
        recovery?.tag !== 'browser-unresolved' &&
        recovery?.tag !== 'aria2-unresolved'
      )
        return undefined
      return { tag: 'forget-pending', since: value.since, recovery }
    }
    case 'terminal-pending': {
      if (
        !hasExactKeys(value, ['tag', 'evidence', 'observedAt', 'projectAt']) ||
        !isRegistryTime(value.observedAt) ||
        !isRegistryTime(value.projectAt) ||
        value.projectAt < value.observedAt
      )
        return undefined
      const evidence = decodeEvidence(value.evidence)
      return evidence === undefined
        ? undefined
        : {
            tag: 'terminal-pending',
            evidence,
            observedAt: value.observedAt,
            projectAt: value.projectAt,
          }
    }
    default:
      return undefined
  }
}

function decodeLegacyPhase(value: unknown): LegacyTransferPhase | undefined {
  if (!isRecord(value) || !isText(value.tag)) return undefined
  if (value.tag === 'active')
    return hasExactKeys(value, ['tag', 'nextProbeAt']) && isRegistryTime(value.nextProbeAt)
      ? { tag: 'active', nextProbeAt: value.nextProbeAt }
      : undefined
  if (value.tag === 'terminal-pending')
    return hasExactKeys(value, ['tag', 'outcome', 'at', 'projectAt']) &&
      (value.outcome === 'complete' || value.outcome === 'failed') &&
      isRegistryTime(value.at) &&
      isRegistryTime(value.projectAt) &&
      value.projectAt >= value.at
      ? {
          tag: 'terminal-pending',
          outcome: value.outcome,
          at: value.at,
          projectAt: value.projectAt,
        }
      : undefined
  if (value.tag === 'forget-pending')
    return hasExactKeys(value, ['tag', 'since']) && isRegistryTime(value.since)
      ? { tag: 'forget-pending', since: value.since }
      : undefined
  return value.tag === 'unresolved' && hasExactKeys(value, ['tag'])
    ? { tag: 'unresolved' }
    : undefined
}
function decodeLegacyEntry(value: unknown): LegacyTransferEntry | undefined {
  if (!isRecord(value)) return undefined
  const hasTweet = Object.hasOwn(value, 'tweetId')
  if (
    !hasExactKeys(
      value,
      hasTweet
        ? ['downloadId', 'startedAt', 'tweetId', 'phase']
        : ['downloadId', 'startedAt', 'phase'],
    ) ||
    !isDownloadId(value.downloadId) ||
    !isRegistryTime(value.startedAt) ||
    (hasTweet && !isSafeId(value.tweetId))
  )
    return undefined
  const phase = decodeLegacyPhase(value.phase)
  if (
    phase === undefined ||
    (phase.tag === 'active' && phase.nextProbeAt < value.startedAt) ||
    (phase.tag === 'terminal-pending' && phase.at < value.startedAt) ||
    (phase.tag === 'forget-pending' && phase.since < value.startedAt)
  )
    return undefined
  return {
    downloadId: value.downloadId,
    startedAt: value.startedAt,
    phase,
    ...(hasTweet ? { tweetId: value.tweetId as string } : {}),
  }
}
function decodeProfile(id: string, value: unknown): Aria2Profile | undefined {
  if (
    !isSafeId(id) ||
    !hasExactKeys(value, ['profileId', 'rpcUrl', 'secret', 'failureCount', 'nextProbeAt']) ||
    !isSafeId(value.profileId) ||
    value.profileId !== id ||
    !isAria2ProfileRpcUrl(value.rpcUrl) ||
    !isAria2ProfileSecret(value.secret) ||
    !isFailureCount(value.failureCount) ||
    !isRegistryTime(value.nextProbeAt)
  )
    return undefined
  return {
    profileId: value.profileId,
    rpcUrl: value.rpcUrl,
    secret: value.secret,
    failureCount: value.failureCount,
    nextProbeAt: value.nextProbeAt,
  }
}
const decodeLegacyFetchedWait = (value: unknown): TransferPhase | undefined => {
  if (
    !hasExactKeys(value, ['tag', 'attempt', 'retryAt']) ||
    value.tag !== 'launch-wait' ||
    !isAttempt(value.attempt) ||
    !isRegistryTime(value.retryAt)
  )
    return undefined
  return value.attempt === 0
    ? { tag: 'fetched-capacity-wait', attempt: 0, retryAt: value.retryAt }
    : {
        tag: 'unresolved-launch',
        attempt: value.attempt,
        since: value.retryAt,
        reason: 'worker-restart',
      }
}
function decodeEntry(
  value: unknown,
  version: TransferRegistryWireVersion,
): TransferEntry | undefined {
  const hasSweepOwnership = isRecord(value) && Object.hasOwn(value, 'sweepOwnership')
  if (
    !isRecord(value) ||
    (version === 3 && hasSweepOwnership) ||
    !hasExactKeys(value, [
      'request',
      'createdAt',
      'phase',
      ...(hasSweepOwnership ? ['sweepOwnership'] : []),
    ]) ||
    !isRegistryTime(value.createdAt)
  )
    return undefined
  const request = decodeTransferRequest(value.request)
  const sweepOwnership = hasSweepOwnership ? decodeSweepOwnership(value.sweepOwnership) : undefined
  let phase = decodePhase(value.phase, version)
  if (request?.mode === 'fetched') {
    if (phase?.tag === 'launching' || phase?.tag === 'retry-launching')
      phase = {
        tag: 'unresolved-launch',
        attempt: phase.attempt,
        since: phase.since,
        reason: 'worker-restart',
      }
    else phase ??= decodeLegacyFetchedWait(value.phase)
  }
  if (
    request === undefined ||
    phase === undefined ||
    (hasSweepOwnership &&
      (sweepOwnership === undefined ||
        request.sweepReceipt?.receiptId !== sweepOwnership.receiptId))
  )
    return undefined
  if (
    (phase.tag === 'launching' ||
      phase.tag === 'direct-prepared' ||
      phase.tag === 'direct-ready' ||
      phase.tag === 'active' ||
      phase.tag === 'retry-wait' ||
      phase.tag === 'retry-refreshing' ||
      phase.tag === 'retry-launching' ||
      phase.tag === 'unresolved-launch' ||
      phase.tag === 'browser-unresolved') &&
    request.mode === 'aria2'
  )
    return undefined
  if (
    (phase.tag === 'fetched-prepared' ||
      phase.tag === 'ready' ||
      phase.tag === 'fetched-capacity-wait' ||
      phase.tag === 'fetched-call-armed') &&
    request.mode !== 'fetched'
  )
    return undefined
  if (
    (phase.tag === 'direct-prepared' || phase.tag === 'direct-ready') &&
    request.mode !== 'direct'
  )
    return undefined
  if ((phase.tag === 'launching' || phase.tag === 'retry-launching') && request.mode === 'fetched')
    return undefined
  if (
    (phase.tag === 'aria2-prepared' ||
      phase.tag === 'aria2-ready' ||
      phase.tag === 'aria2-launching' ||
      phase.tag === 'aria2-call-armed' ||
      phase.tag === 'aria2-active' ||
      phase.tag === 'aria2-unresolved') &&
    request.mode !== 'aria2'
  )
    return undefined
  if (
    phase.tag === 'terminal-pending' &&
    phase.evidence.tag === 'aria2' &&
    request.mode !== 'aria2'
  )
    return undefined
  if (
    phase.tag === 'terminal-pending' &&
    phase.evidence.tag === 'browser' &&
    request.mode === 'aria2'
  )
    return undefined
  if (
    (phase.tag === 'launching' ||
      phase.tag === 'direct-prepared' ||
      phase.tag === 'direct-ready' ||
      phase.tag === 'fetched-prepared' ||
      phase.tag === 'ready' ||
      phase.tag === 'fetched-call-armed' ||
      phase.tag === 'retry-refreshing' ||
      phase.tag === 'retry-launching' ||
      phase.tag === 'unresolved-launch' ||
      phase.tag === 'browser-unresolved' ||
      phase.tag === 'aria2-prepared' ||
      phase.tag === 'aria2-ready' ||
      phase.tag === 'aria2-launching' ||
      phase.tag === 'aria2-call-armed' ||
      phase.tag === 'aria2-unresolved') &&
    phase.since < value.createdAt
  )
    return undefined
  if ((phase.tag === 'active' || phase.tag === 'aria2-active') && phase.startedAt < value.createdAt)
    return undefined
  if (
    (phase.tag === 'retry-wait' || phase.tag === 'fetched-capacity-wait') &&
    phase.retryAt < value.createdAt
  )
    return undefined
  if (phase.tag === 'forget-pending') {
    if (
      phase.since < value.createdAt ||
      phase.recovery.since < value.createdAt ||
      phase.since < phase.recovery.since
    )
      return undefined
    const recovery = phase.recovery
    const prepared =
      recovery.tag === 'direct-prepared' ||
      recovery.tag === 'fetched-prepared' ||
      recovery.tag === 'aria2-prepared'
    if (prepared && request.sweepReceipt !== undefined) return undefined
    if (recovery.tag === 'direct-prepared' && request.mode !== 'direct') return undefined
    if (recovery.tag === 'fetched-prepared' && request.mode !== 'fetched') return undefined
    if (
      (recovery.tag === 'aria2-prepared' || recovery.tag === 'aria2-unresolved') &&
      request.mode !== 'aria2'
    )
      return undefined
    if (
      recovery.tag !== 'aria2-prepared' &&
      recovery.tag !== 'aria2-unresolved' &&
      request.mode === 'aria2'
    )
      return undefined
  }
  if (phase.tag === 'terminal-pending' && phase.observedAt < value.createdAt) return undefined
  return {
    request,
    createdAt: value.createdAt,
    phase,
    ...(sweepOwnership === undefined ? {} : { sweepOwnership }),
  }
}

const decodeSweepOwnership = (value: unknown): SweepOwnershipConfirmation | undefined =>
  isRecord(value) &&
  hasExactKeys(value, ['receiptId', 'clearSeedId']) &&
  isSweepReceiptId(value.receiptId) &&
  isRegistryTime(value.clearSeedId) &&
  value.clearSeedId > 0
    ? { receiptId: value.receiptId, clearSeedId: value.clearSeedId }
    : undefined

export type DecodeTransferRegistryResult =
  | { readonly ok: true; readonly state: TransferRegistryStore }
  | { readonly ok: false; readonly state: TransferRegistryStore; readonly reason: string }
export function decodeTransferRegistryStore(raw: unknown): DecodeTransferRegistryResult {
  if (isRecord(raw) && !isBoundedJson(raw, MAX_TRANSFER_REGISTRY_STORE_BYTES))
    return { ok: false, state: emptyTransferRegistryStore, reason: 'registry size' }
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ['version', 'entries', 'profiles', 'legacy']) ||
    (raw.version !== 3 && raw.version !== TRANSFER_REGISTRY_VERSION) ||
    !isRecord(raw.entries) ||
    !isRecord(raw.profiles) ||
    !isRecord(raw.legacy)
  )
    return { ok: false, state: emptyTransferRegistryStore, reason: 'expected v3/v4 registry store' }
  const entryRows = Object.entries(raw.entries),
    profileRows = Object.entries(raw.profiles),
    legacyRows = Object.entries(raw.legacy)
  if (
    entryRows.length + legacyRows.length > MAX_TRANSFER_REGISTRY_ENTRIES ||
    profileRows.length > MAX_TRANSFER_REGISTRY_ENTRIES
  )
    return { ok: false, state: emptyTransferRegistryStore, reason: 'registry limit' }
  const entries: Record<string, TransferEntry> = {},
    profiles: Record<string, Aria2Profile> = {},
    legacy: Record<string, LegacyTransferEntry> = {}
  const browserIds = new Set<number>(),
    gids = new Set<string>(),
    fetchedLeaseIds = new Set<string>(),
    projectionIds = new Set<string>(),
    logicalRequestIds = new Set<string>(),
    referencedProfiles = new Set<string>()
  const sweepGroups = new Map<
    string,
    {
      readonly tweetId: string
      readonly scope: 'bookmark' | 'like'
      readonly owned: boolean
      readonly clearSeedId?: number
    }
  >()
  const aria2Claims: Array<{ readonly profileId: string; readonly gid: string }> = []
  const profileOwnerBySnapshot = new Map<string, string>()
  const reserveBrowser = (id: number): boolean => !browserIds.has(id) && (browserIds.add(id), true)
  for (const [id, rawEntry] of entryRows) {
    if (!isSafeId(id))
      return { ok: false, state: emptyTransferRegistryStore, reason: 'invalid entry key' }
    const entry = decodeEntry(rawEntry, raw.version)
    if (
      entry === undefined ||
      entry.request.id !== id ||
      projectionIds.has(entry.request.projectionId)
    )
      return { ok: false, state: emptyTransferRegistryStore, reason: `invalid entry: ${id}` }
    const logicalRequestId =
      entry.request.item === undefined ? entry.request.id : mediaRequestId(entry.request.item)
    if (logicalRequestIds.has(logicalRequestId))
      return {
        ok: false,
        state: emptyTransferRegistryStore,
        reason: `duplicate logical request: ${logicalRequestId}`,
      }
    logicalRequestIds.add(logicalRequestId)
    projectionIds.add(entry.request.projectionId)
    const sweepReceipt = entry.request.sweepReceipt
    if (sweepReceipt !== undefined) {
      if (entry.request.item !== undefined && entry.request.item.postId !== sweepReceipt.tweetId)
        return {
          ok: false,
          state: emptyTransferRegistryStore,
          reason: `Sweep receipt post mismatch: ${sweepReceipt.receiptId}`,
        }
      const owned = entry.sweepOwnership !== undefined
      const group = sweepGroups.get(sweepReceipt.receiptId)
      if (
        group !== undefined &&
        (group.tweetId !== sweepReceipt.tweetId ||
          group.scope !== sweepReceipt.scope ||
          group.owned !== owned ||
          (owned && group.clearSeedId !== entry.sweepOwnership?.clearSeedId))
      )
        return {
          ok: false,
          state: emptyTransferRegistryStore,
          reason: `invalid Sweep receipt group: ${sweepReceipt.receiptId}`,
        }
      if (group === undefined)
        sweepGroups.set(sweepReceipt.receiptId, {
          tweetId: sweepReceipt.tweetId,
          scope: sweepReceipt.scope,
          owned,
          ...(entry.sweepOwnership === undefined
            ? {}
            : { clearSeedId: entry.sweepOwnership.clearSeedId }),
        })
    }
    const phase = entry.phase
    if (phase.tag === 'fetched-call-armed') {
      if (fetchedLeaseIds.has(phase.leaseId))
        return {
          ok: false,
          state: emptyTransferRegistryStore,
          reason: 'duplicate fetched leaseId',
        }
      fetchedLeaseIds.add(phase.leaseId)
    }
    const browserId =
      phase.tag === 'active'
        ? phase.downloadId
        : phase.tag === 'retry-wait' ||
            phase.tag === 'retry-refreshing' ||
            phase.tag === 'retry-launching' ||
            phase.tag === 'ready' ||
            phase.tag === 'fetched-capacity-wait' ||
            phase.tag === 'fetched-call-armed'
          ? phase.priorDownloadId
          : phase.tag === 'browser-unresolved'
            ? phase.downloadId
            : phase.tag === 'forget-pending' && phase.recovery.tag === 'browser-unresolved'
              ? phase.recovery.downloadId
              : phase.tag === 'terminal-pending' && phase.evidence.tag === 'browser'
                ? phase.evidence.downloadId
                : undefined
    if (browserId !== undefined && !reserveBrowser(browserId))
      return {
        ok: false,
        state: emptyTransferRegistryStore,
        reason: 'duplicate browser downloadId',
      }
    const profileId =
      phase.tag === 'aria2-prepared' ||
      phase.tag === 'aria2-ready' ||
      phase.tag === 'aria2-launching' ||
      phase.tag === 'aria2-call-armed' ||
      phase.tag === 'aria2-active'
        ? phase.profileId
        : phase.tag === 'aria2-unresolved'
          ? phase.profileId
          : phase.tag === 'forget-pending' &&
              (phase.recovery.tag === 'aria2-prepared' || phase.recovery.tag === 'aria2-unresolved')
            ? phase.recovery.profileId
            : phase.tag === 'terminal-pending' && phase.evidence.tag === 'aria2'
              ? phase.evidence.profileId
              : undefined
    if (profileId !== undefined) referencedProfiles.add(profileId)
    const gid =
      phase.tag === 'aria2-prepared' ||
      phase.tag === 'aria2-ready' ||
      phase.tag === 'aria2-launching' ||
      phase.tag === 'aria2-call-armed'
        ? phase.gid
        : phase.tag === 'aria2-active'
          ? phase.gid
          : phase.tag === 'aria2-unresolved'
            ? phase.gid
            : phase.tag === 'forget-pending' &&
                (phase.recovery.tag === 'aria2-prepared' ||
                  phase.recovery.tag === 'aria2-unresolved')
              ? phase.recovery.gid
              : phase.tag === 'terminal-pending' && phase.evidence.tag === 'aria2'
                ? phase.evidence.gid
                : undefined
    if (gid !== undefined) {
      const key = `${profileId ?? '?'}:${gid}`
      if (gids.has(key))
        return { ok: false, state: emptyTransferRegistryStore, reason: 'duplicate aria2 gid' }
      gids.add(key)
      if (profileId === undefined)
        return { ok: false, state: emptyTransferRegistryStore, reason: 'missing aria2 profile' }
      aria2Claims.push({ profileId, gid })
    }
    entries[id] = entry
  }
  for (const [id, rawProfile] of profileRows) {
    const profile = decodeProfile(id, rawProfile)
    if (profile === undefined || !referencedProfiles.has(id))
      return {
        ok: false,
        state: emptyTransferRegistryStore,
        reason: `orphan or invalid profile: ${id}`,
      }
    const snapshotKey = JSON.stringify([aria2EndpointIdentity(profile.rpcUrl), profile.secret])
    const snapshotOwner = profileOwnerBySnapshot.get(snapshotKey)
    if (snapshotOwner !== undefined)
      return {
        ok: false,
        state: emptyTransferRegistryStore,
        reason: `duplicate aria2 profile snapshot: ${snapshotOwner}, ${id}`,
      }
    profileOwnerBySnapshot.set(snapshotKey, id)
    profiles[id] = profile
  }
  for (const profileId of referencedProfiles)
    if (!Object.hasOwn(profiles, profileId))
      return {
        ok: false,
        state: emptyTransferRegistryStore,
        reason: `missing profile: ${profileId}`,
      }
  const endpointGids = new Set<string>()
  for (const claim of aria2Claims) {
    const profile = profiles[claim.profileId]
    if (profile === undefined)
      return {
        ok: false,
        state: emptyTransferRegistryStore,
        reason: `missing profile: ${claim.profileId}`,
      }
    const key = `${aria2EndpointIdentity(profile.rpcUrl) ?? profile.rpcUrl}:${claim.gid}`
    if (endpointGids.has(key))
      return { ok: false, state: emptyTransferRegistryStore, reason: 'duplicate aria2 gid' }
    endpointGids.add(key)
  }
  for (const [id, rawLegacy] of legacyRows) {
    const entry = decodeLegacyEntry(rawLegacy)
    if (
      !isSafeId(id) ||
      entry === undefined ||
      Object.hasOwn(entries, id) ||
      !reserveBrowser(entry.downloadId)
    )
      return { ok: false, state: emptyTransferRegistryStore, reason: `invalid legacy: ${id}` }
    legacy[id] = entry
  }
  return { ok: true, state: { version: TRANSFER_REGISTRY_VERSION, entries, profiles, legacy } }
}
