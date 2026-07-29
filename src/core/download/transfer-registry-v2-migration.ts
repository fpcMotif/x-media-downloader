import { Schema } from 'effect'
import { MediaItem, type MediaItem as MediaItemType } from '../schema/media'
import {
  emptyTransferRegistryStore,
  isBoundedJson,
  hasExactKeys,
  isAttempt,
  isDownloadId,
  isRecord,
  isRegistryTime,
  isSafeId,
  isText,
  isTransferFilename,
  isTransferUrl,
  MAX_TRANSFER_REGISTRY_ENTRIES,
  MAX_TRANSFER_REGISTRY_MEDIA_ITEM_BYTES,
  MAX_TRANSFER_REGISTRY_STORE_BYTES,
  TRANSFER_REGISTRY_VERSION,
  type LegacyTransferEntry,
  type LegacyTransferPhase,
  type TransferEntry,
  type TransferRegistryStore,
} from './transfer-registry-model'

type V2Request = {
  readonly id: string
  readonly url: string
  readonly filename: string
  readonly mode: 'direct' | 'fetched' | 'aria2'
  readonly item?: MediaItemType
}
type V2Phase =
  | { readonly tag: 'launching'; readonly attempt: number; readonly since: number }
  | {
      readonly tag: 'active'
      readonly downloadId: number
      readonly attempt: number
      readonly startedAt: number
      readonly nextProbeAt: number
    }
  | { readonly tag: 'retry-wait'; readonly attempt: number; readonly retryAt: number }
  | {
      readonly tag: 'unresolved-launch'
      readonly attempt: number
      readonly since: number
      readonly reason: 'worker-restart' | 'handle-bind-failed'
      readonly downloadId?: number
    }
  | {
      readonly tag: 'terminal-pending'
      readonly outcome: 'complete' | 'failed'
      readonly downloadId?: number
      readonly at: number
      readonly projectAt: number
    }
type V2Entry = { readonly request: V2Request; readonly createdAt: number; readonly phase: V2Phase }
export type V2TransferRegistryStore = {
  readonly version: 2
  readonly entries: Readonly<Record<string, V2Entry>>
  readonly legacy: Readonly<Record<string, LegacyTransferEntry>>
}

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
const media = (value: unknown): MediaItemType | undefined => {
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
const request = (value: unknown): V2Request | undefined => {
  if (!isRecord(value)) return undefined
  const hasItem = Object.hasOwn(value, 'item')
  if (
    !hasExactKeys(
      value,
      hasItem ? ['id', 'url', 'filename', 'mode', 'item'] : ['id', 'url', 'filename', 'mode'],
    ) ||
    !isSafeId(value.id) ||
    !isTransferUrl(value.url) ||
    !isTransferFilename(value.filename) ||
    (value.mode !== 'direct' && value.mode !== 'fetched' && value.mode !== 'aria2')
  )
    return undefined
  const item = hasItem ? media(value.item) : undefined
  return (hasItem && item === undefined) || (item !== undefined && item.id !== value.id)
    ? undefined
    : {
        id: value.id,
        url: value.url,
        filename: value.filename,
        mode: value.mode,
        ...(item === undefined ? {} : { item }),
      }
}
const phase = (value: unknown): V2Phase | undefined => {
  if (!isRecord(value) || !isText(value.tag)) return undefined
  if (value.tag === 'launching')
    return hasExactKeys(value, ['tag', 'attempt', 'since']) &&
      isAttempt(value.attempt) &&
      isRegistryTime(value.since)
      ? { tag: 'launching', attempt: value.attempt, since: value.since }
      : undefined
  if (value.tag === 'active')
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
  if (value.tag === 'retry-wait')
    return hasExactKeys(value, ['tag', 'attempt', 'retryAt']) &&
      isAttempt(value.attempt) &&
      value.attempt > 0 &&
      isRegistryTime(value.retryAt)
      ? { tag: 'retry-wait', attempt: value.attempt, retryAt: value.retryAt }
      : undefined
  if (value.tag === 'unresolved-launch') {
    const hasId = Object.hasOwn(value, 'downloadId')
    return hasExactKeys(
      value,
      hasId
        ? ['tag', 'attempt', 'since', 'reason', 'downloadId']
        : ['tag', 'attempt', 'since', 'reason'],
    ) &&
      isAttempt(value.attempt) &&
      isRegistryTime(value.since) &&
      (value.reason === 'worker-restart' || value.reason === 'handle-bind-failed') &&
      (!hasId || isDownloadId(value.downloadId))
      ? {
          tag: 'unresolved-launch',
          attempt: value.attempt,
          since: value.since,
          reason: value.reason,
          ...(hasId ? { downloadId: value.downloadId as number } : {}),
        }
      : undefined
  }
  if (value.tag === 'terminal-pending') {
    const hasId = Object.hasOwn(value, 'downloadId')
    return hasExactKeys(
      value,
      hasId
        ? ['tag', 'outcome', 'downloadId', 'at', 'projectAt']
        : ['tag', 'outcome', 'at', 'projectAt'],
    ) &&
      (value.outcome === 'complete' || value.outcome === 'failed') &&
      isRegistryTime(value.at) &&
      isRegistryTime(value.projectAt) &&
      value.projectAt >= value.at &&
      (!hasId || isDownloadId(value.downloadId))
      ? {
          tag: 'terminal-pending',
          outcome: value.outcome,
          at: value.at,
          projectAt: value.projectAt,
          ...(hasId ? { downloadId: value.downloadId as number } : {}),
        }
      : undefined
  }
  return undefined
}
const legacyPhase = (value: unknown): LegacyTransferPhase | undefined => {
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
  return value.tag === 'unresolved' && hasExactKeys(value, ['tag'])
    ? { tag: 'unresolved' }
    : undefined
}
const legacy = (value: unknown): LegacyTransferEntry | undefined => {
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
  const decoded = legacyPhase(value.phase)
  return decoded === undefined ||
    (decoded.tag === 'active' && decoded.nextProbeAt < value.startedAt) ||
    (decoded.tag === 'terminal-pending' && decoded.at < value.startedAt)
    ? undefined
    : {
        downloadId: value.downloadId,
        startedAt: value.startedAt,
        phase: decoded,
        ...(hasTweet ? { tweetId: value.tweetId as string } : {}),
      }
}
export type DecodeV2Result =
  | { readonly ok: true; readonly state: V2TransferRegistryStore }
  | { readonly ok: false; readonly reason: string }
export function decodeV2TransferRegistryStore(raw: unknown): DecodeV2Result {
  if (isRecord(raw) && !isBoundedJson(raw, MAX_TRANSFER_REGISTRY_STORE_BYTES))
    return { ok: false, reason: 'registry size' }
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ['version', 'entries', 'legacy']) ||
    raw.version !== 2 ||
    !isRecord(raw.entries) ||
    !isRecord(raw.legacy)
  )
    return { ok: false, reason: 'expected v2 registry store' }
  const entryRows = Object.entries(raw.entries),
    legacyRows = Object.entries(raw.legacy)
  if (entryRows.length + legacyRows.length > MAX_TRANSFER_REGISTRY_ENTRIES)
    return { ok: false, reason: 'registry limit' }
  const entries: Record<string, V2Entry> = {},
    legacyEntries: Record<string, LegacyTransferEntry> = {}
  const browserIds = new Set<number>()
  const reserve = (id: number): boolean => !browserIds.has(id) && (browserIds.add(id), true)
  for (const [id, rawEntry] of entryRows) {
    if (
      !isSafeId(id) ||
      !isRecord(rawEntry) ||
      !hasExactKeys(rawEntry, ['request', 'createdAt', 'phase']) ||
      !isRegistryTime(rawEntry.createdAt)
    )
      return { ok: false, reason: `invalid entry: ${id}` }
    const req = request(rawEntry.request),
      rowPhase = phase(rawEntry.phase)
    if (
      req === undefined ||
      rowPhase === undefined ||
      req.id !== id ||
      ((rowPhase.tag === 'launching' || rowPhase.tag === 'unresolved-launch') &&
        rowPhase.since < rawEntry.createdAt) ||
      (rowPhase.tag === 'active' && rowPhase.startedAt < rawEntry.createdAt) ||
      (rowPhase.tag === 'retry-wait' && rowPhase.retryAt < rawEntry.createdAt) ||
      (rowPhase.tag === 'terminal-pending' && rowPhase.at < rawEntry.createdAt) ||
      ((rowPhase.tag === 'active' || rowPhase.tag === 'retry-wait') && req.mode === 'aria2') ||
      (rowPhase.tag === 'terminal-pending' &&
        rowPhase.downloadId !== undefined &&
        req.mode === 'aria2') ||
      (rowPhase.tag === 'terminal-pending' &&
        rowPhase.outcome === 'complete' &&
        rowPhase.downloadId === undefined &&
        req.mode !== 'aria2')
    )
      return { ok: false, reason: `invalid entry: ${id}` }
    const browserId =
      rowPhase.tag === 'active'
        ? rowPhase.downloadId
        : rowPhase.tag === 'unresolved-launch'
          ? rowPhase.downloadId
          : rowPhase.tag === 'terminal-pending'
            ? rowPhase.downloadId
            : undefined
    if (browserId !== undefined && !reserve(browserId))
      return { ok: false, reason: 'duplicate browser downloadId' }
    entries[id] = { request: req, createdAt: rawEntry.createdAt, phase: rowPhase }
  }
  for (const [id, value] of legacyRows) {
    const row = legacy(value)
    if (
      !isSafeId(id) ||
      row === undefined ||
      Object.hasOwn(entries, id) ||
      !reserve(row.downloadId)
    )
      return { ok: false, reason: `invalid legacy: ${id}` }
    legacyEntries[id] = row
  }
  return { ok: true, state: { version: 2, entries, legacy: legacyEntries } }
}
/** Unique, bounded receipt within one exact v2 migration snapshot. */
export const v2ProjectionId = (createdAt: number, ordinal: number): string =>
  `v2:${createdAt}:${ordinal}`

/** Exact v2 decode first. Never invent an aria2 endpoint, profile, or GID. */
export function migrateV2TransferRegistryStore(
  raw: unknown,
):
  | { readonly ok: true; readonly state: TransferRegistryStore }
  | { readonly ok: false; readonly state: TransferRegistryStore; readonly reason: string } {
  const decoded = decodeV2TransferRegistryStore(raw)
  if (!decoded.ok) return { ok: false, state: emptyTransferRegistryStore, reason: decoded.reason }
  const entries: Record<string, TransferEntry> = {}
  for (const [ordinal, [id, entry]] of Object.entries(decoded.state.entries).entries()) {
    const migratedRequest = {
      ...entry.request,
      projectionId: v2ProjectionId(entry.createdAt, ordinal),
      historyPolicy:
        entry.request.item === undefined ? ('off' as const) : ('transition-only' as const),
    }
    const old = entry.phase
    if (entry.request.mode === 'aria2') {
      entries[id] = {
        request: migratedRequest,
        createdAt: entry.createdAt,
        phase: {
          tag: 'aria2-unresolved',
          since:
            old.tag === 'launching'
              ? old.since
              : old.tag === 'terminal-pending'
                ? old.at
                : entry.createdAt,
          reason: 'legacy-false-handoff',
        },
      }
    } else if (old.tag === 'unresolved-launch') {
      entries[id] = {
        request: migratedRequest,
        createdAt: entry.createdAt,
        phase:
          old.downloadId === undefined
            ? {
                tag: 'unresolved-launch',
                attempt: old.attempt,
                since: old.since,
                reason: old.reason,
              }
            : {
                tag: 'browser-unresolved',
                attempt: old.attempt,
                since: old.since,
                reason: old.reason,
                downloadId: old.downloadId,
                nextProbeAt: old.since,
              },
      }
    } else if (old.tag === 'retry-wait') {
      entries[id] = {
        request: migratedRequest,
        createdAt: entry.createdAt,
        phase: {
          tag: 'unresolved-launch',
          attempt: old.attempt,
          since: old.retryAt,
          reason: 'worker-restart',
        },
      }
    } else if (old.tag === 'launching' && entry.request.mode === 'fetched') {
      entries[id] = {
        request: migratedRequest,
        createdAt: entry.createdAt,
        phase: {
          tag: 'unresolved-launch',
          attempt: old.attempt,
          since: old.since,
          reason: 'worker-restart',
        },
      }
    } else if (old.tag === 'launching' || old.tag === 'active') {
      entries[id] = { request: migratedRequest, createdAt: entry.createdAt, phase: old }
    } else {
      const evidence =
        old.downloadId === undefined
          ? { tag: 'start-failed' as const }
          : {
              tag: 'browser' as const,
              downloadId: old.downloadId,
              state: old.outcome === 'complete' ? ('complete' as const) : ('interrupted' as const),
            }
      entries[id] = {
        request: migratedRequest,
        createdAt: entry.createdAt,
        phase: { tag: 'terminal-pending', evidence, observedAt: old.at, projectAt: old.projectAt },
      }
    }
  }
  return {
    ok: true,
    state: {
      version: TRANSFER_REGISTRY_VERSION,
      entries,
      profiles: {},
      legacy: decoded.state.legacy,
    },
  }
}
