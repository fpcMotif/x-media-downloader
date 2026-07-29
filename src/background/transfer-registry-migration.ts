import { Schema } from 'effect'
import { MediaItem, type MediaItem as MediaItemType } from '../core/schema/media'
import {
  decodeInterruptRetryQueue,
  type PendingInterruptRetry,
} from '../core/download/interrupt-retry'
import {
  decodeTransferRegistryStore,
  emptyTransferRegistryStore,
  isBoundedJson,
  isTransferFilename,
  isTransferUrl,
  MAX_TRANSFER_REGISTRY_MEDIA_ITEM_BYTES,
  TRANSFER_REGISTRY_VERSION,
  type LegacyTransferEntry,
  type TransferRequest,
  type TransferRegistryStore,
} from '../core/download/transfer-registry'

/** v1 request metadata had no v3 projection identity or history policy. */
type LegacyRequestMeta = {
  readonly url: string
  readonly filename: string
  readonly mode: 'direct' | 'fetched'
  readonly item?: MediaItemType
}

/** Exact v1 `session:transfers` row. Migration is its only remaining reader. */
interface LegacyTrackedTransfer {
  readonly id: string
  readonly downloadId: number
  readonly tweetId?: string
  readonly startedAt: number
}

export type MigrateLegacyTransferTrackerResult =
  | { readonly ok: true; readonly state: TransferRegistryStore }
  | {
      readonly ok: false
      readonly state: TransferRegistryStore
      readonly kind: 'legacy-corruption' | 'unrepresentable-active'
      readonly reason: string
    }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasOnlyKeys = (
  value: unknown,
  required: readonly string[],
  allowed: readonly string[],
): value is Record<string, unknown> =>
  isRecord(value) &&
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => allowed.includes(key))

const isNonemptyText = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.length <= 256 &&
  value !== '__proto__' &&
  value !== 'constructor' &&
  value !== 'prototype'

const isDownloadId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const decodeLegacyTransfer = (value: unknown): LegacyTrackedTransfer | undefined => {
  const hasTweetId = isRecord(value) && Object.hasOwn(value, 'tweetId')
  if (
    !hasOnlyKeys(
      value,
      hasTweetId ? ['id', 'downloadId', 'tweetId', 'startedAt'] : ['id', 'downloadId', 'startedAt'],
      hasTweetId ? ['id', 'downloadId', 'tweetId', 'startedAt'] : ['id', 'downloadId', 'startedAt'],
    ) ||
    !isNonemptyText(value.id) ||
    !isDownloadId(value.downloadId) ||
    !isTime(value.startedAt) ||
    (hasTweetId && !isNonemptyText(value.tweetId))
  )
    return undefined
  return {
    id: value.id,
    downloadId: value.downloadId,
    startedAt: value.startedAt,
    ...(hasTweetId ? { tweetId: value.tweetId as string } : {}),
  }
}

const decodeLegacyTransfers = (
  raw: unknown,
):
  | { readonly ok: true; readonly transfers: readonly LegacyTrackedTransfer[] }
  | { readonly ok: false; readonly reason: string } => {
  if (!hasOnlyKeys(raw, ['transfers'], ['transfers']) || !Array.isArray(raw.transfers))
    return { ok: false, reason: 'expected { transfers: [...] }' }
  const transfers: LegacyTrackedTransfer[] = []
  for (const [index, value] of raw.transfers.entries()) {
    const transfer = decodeLegacyTransfer(value)
    if (transfer === undefined) return { ok: false, reason: `invalid transfer at index ${index}` }
    transfers.push(transfer)
  }
  return { ok: true, transfers }
}

const mediaItemKeys = [
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

const requiredMediaItemKeys = [
  'id',
  'platform',
  'postId',
  'author',
  'type',
  'url',
  'ext',
  'index',
] as const

const decodeMediaItem = (value: unknown): MediaItemType | undefined => {
  if (!hasOnlyKeys(value, requiredMediaItemKeys, mediaItemKeys)) return undefined
  if (!isBoundedJson(value, MAX_TRANSFER_REGISTRY_MEDIA_ITEM_BYTES)) return undefined
  try {
    return Schema.decodeUnknownSync(MediaItem)(value)
  } catch {
    return undefined
  }
}

const decodeLegacyRequestMeta = (value: unknown): LegacyRequestMeta | undefined => {
  const hasItem = isRecord(value) && Object.hasOwn(value, 'item')
  if (
    !hasOnlyKeys(
      value,
      ['url', 'filename'],
      hasItem ? ['url', 'filename', 'mode', 'item'] : ['url', 'filename', 'mode'],
    )
  )
    return undefined
  if (
    !isTransferUrl(value.url) ||
    !isTransferFilename(value.filename) ||
    (Object.hasOwn(value, 'mode') && value.mode !== 'direct' && value.mode !== 'fetched')
  )
    return undefined
  const item = hasItem ? decodeMediaItem(value.item) : undefined
  if (hasItem && item === undefined) return undefined
  return {
    url: value.url,
    filename: value.filename,
    mode: value.mode === 'fetched' ? 'fetched' : 'direct',
    ...(item === undefined ? {} : { item }),
  }
}

const decodeLegacyRequestMetaStore = (
  raw: unknown,
):
  | {
      readonly ok: true
      readonly state: Readonly<Record<string, LegacyRequestMeta>>
    }
  | { readonly ok: false; readonly reason: string } => {
  if (!isRecord(raw)) return { ok: false, reason: 'expected metadata record' }
  const state: Record<string, LegacyRequestMeta> = Object.create(null) as Record<
    string,
    LegacyRequestMeta
  >
  for (const [id, value] of Object.entries(raw)) {
    const meta = decodeLegacyRequestMeta(value)
    if (meta === undefined) return { ok: false, reason: `invalid metadata: ${id}` }
    if (meta.item !== undefined && meta.item.id !== id)
      return { ok: false, reason: `metadata item id mismatch: ${id}` }
    state[id] = meta
  }
  return { ok: true, state }
}

const requestFrom = (id: string, receipt: string, source: LegacyRequestMeta): TransferRequest => ({
  id,
  projectionId: receipt,
  url: source.url,
  filename: source.filename,
  mode: source.mode,
  historyPolicy: source.item === undefined ? 'off' : 'transition-only',
  ...(source.item === undefined ? {} : { item: source.item }),
})

const requestFromRetry = (retry: PendingInterruptRetry, receipt: string): TransferRequest =>
  requestFrom(retry.id, receipt, {
    url: retry.url,
    filename: retry.filename,
    mode: retry.mode,
    ...(retry.item === undefined ? {} : { item: retry.item }),
  })

const requestFromMeta = (id: string, meta: LegacyRequestMeta, receipt: string): TransferRequest =>
  requestFrom(id, receipt, meta)

const unresolved = (request: TransferRequest, attempt: number, now: number) => ({
  request,
  createdAt: now,
  phase: {
    tag: 'unresolved-launch' as const,
    attempt,
    since: now,
    reason: 'worker-restart' as const,
  },
})

/**
 * Convert the three legacy ledgers only when their complete, strict snapshots agree.
 * Metadata-free active handles become isolated legacy rows. They never acquire a
 * fabricated request and can only observe their exact Chrome download id.
 */
export function migrateLegacyTransferTracker(
  rawTransfers: unknown,
  rawRequestMeta: unknown,
  rawRetries: unknown,
  now: number,
): MigrateLegacyTransferTrackerResult {
  if (!isTime(now))
    return {
      ok: false,
      state: emptyTransferRegistryStore,
      kind: 'legacy-corruption',
      reason: 'invalid migration time',
    }
  const transfers = decodeLegacyTransfers(
    rawTransfers === undefined ? { transfers: [] } : rawTransfers,
  )
  if (!transfers.ok)
    return {
      ok: false,
      state: emptyTransferRegistryStore,
      kind: 'legacy-corruption',
      reason: `transfer tracker: ${transfers.reason}`,
    }
  const metadata = decodeLegacyRequestMetaStore(rawRequestMeta === undefined ? {} : rawRequestMeta)
  if (!metadata.ok)
    return {
      ok: false,
      state: emptyTransferRegistryStore,
      kind: 'legacy-corruption',
      reason: `request metadata: ${metadata.reason}`,
    }
  const retries = decodeInterruptRetryQueue(rawRetries === undefined ? [] : rawRetries)
  if (!retries.ok)
    return {
      ok: false,
      state: emptyTransferRegistryStore,
      kind: 'legacy-corruption',
      reason: `interrupt retries: ${retries.reason}`,
    }
  if (retries.retries.some((retry) => !isTime(retry.nextRetryAt)))
    return {
      ok: false,
      state: emptyTransferRegistryStore,
      kind: 'legacy-corruption',
      reason: 'interrupt retries: invalid retry time',
    }

  const transferById = new Map<string, LegacyTrackedTransfer>()
  const transferCountById = new Map<string, number>()
  const transferCountByDownloadId = new Map<number, number>()
  for (const transfer of transfers.transfers) {
    transferById.set(transfer.id, transfer)
    transferCountById.set(transfer.id, (transferCountById.get(transfer.id) ?? 0) + 1)
    transferCountByDownloadId.set(
      transfer.downloadId,
      (transferCountByDownloadId.get(transfer.downloadId) ?? 0) + 1,
    )
  }
  const ambiguousTransferIds = new Set(
    transfers.transfers
      .filter(
        (transfer) =>
          (transferCountById.get(transfer.id) ?? 0) > 1 ||
          (transferCountByDownloadId.get(transfer.downloadId) ?? 0) > 1,
      )
      .map((transfer) => transfer.id),
  )
  const retryById = new Map<string, PendingInterruptRetry>(
    retries.retries.map((retry) => [retry.id, retry]),
  )
  const ids = new Set([...transferById.keys(), ...Object.keys(metadata.state), ...retryById.keys()])
  /** Bounded, deterministic receipt; never embed an arbitrary legacy ID. */
  const receiptById = new Map([...ids].map((id, index) => [id, `legacy-${index + 1}`]))
  const entries: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  const legacy: Record<string, LegacyTransferEntry> = Object.create(null) as Record<
    string,
    LegacyTransferEntry
  >

  for (const id of ids) {
    const receipt = receiptById.get(id)
    if (receipt === undefined)
      return {
        ok: false,
        state: emptyTransferRegistryStore,
        kind: 'legacy-corruption',
        reason: `missing migration receipt: ${id}`,
      }
    const transfer = transferById.get(id)
    const retry = retryById.get(id)
    const meta = metadata.state[id]
    if (retry !== undefined && retry.attempt === 0)
      return {
        ok: false,
        state: emptyTransferRegistryStore,
        kind: 'legacy-corruption',
        reason: `unreachable retry attempt: ${id}`,
      }
    if (ambiguousTransferIds.has(id)) {
      const request =
        retry !== undefined
          ? requestFromRetry(retry, receipt)
          : meta && requestFromMeta(id, meta, receipt)
      if (request === undefined)
        return {
          ok: false,
          state: emptyTransferRegistryStore,
          kind: 'unrepresentable-active',
          reason: `ambiguous transfer lacks metadata: ${id}`,
        }
      const trackedRows = transfers.transfers.filter((row) => row.id === id)
      if (trackedRows.some((row) => row.tweetId !== undefined) && request.item === undefined)
        return {
          ok: false,
          state: emptyTransferRegistryStore,
          kind: 'unrepresentable-active',
          reason: `tracked transfer metadata lacks item: ${id}`,
        }
      entries[id] = unresolved(request, retry?.attempt ?? 0, now)
      continue
    }
    if (transfer?.tweetId !== undefined && meta !== undefined) {
      if (meta.item === undefined)
        return {
          ok: false,
          state: emptyTransferRegistryStore,
          kind: 'unrepresentable-active',
          reason: `tracked transfer metadata lacks item: ${id}`,
        }
      if (meta.item.postId !== transfer.tweetId)
        return {
          ok: false,
          state: emptyTransferRegistryStore,
          kind: 'legacy-corruption',
          reason: `tracked transfer post mismatch: ${id}`,
        }
    }
    if (transfer !== undefined && retry !== undefined) {
      entries[id] = unresolved(requestFromRetry(retry, receipt), retry.attempt, now)
      continue
    }
    if (retry !== undefined) {
      const request = requestFromRetry(retry, receipt)
      // v1 retry rows lost their old browser handle. v3 retries must retain it
      // for exact terminal evidence, so migration fails closed and never reissues.
      entries[id] = unresolved(request, retry.attempt, now)
      continue
    }
    if (transfer !== undefined) {
      if (meta === undefined) {
        legacy[id] = {
          downloadId: transfer.downloadId,
          startedAt: transfer.startedAt,
          phase: {
            tag: 'active',
            nextProbeAt: now < transfer.startedAt ? transfer.startedAt : now,
          },
          ...(transfer.tweetId === undefined ? {} : { tweetId: transfer.tweetId }),
        }
        continue
      }
      const request = requestFromMeta(id, meta, receipt)
      entries[id] = {
        request,
        createdAt: transfer.startedAt,
        phase: {
          tag: 'active',
          downloadId: transfer.downloadId,
          attempt: 0,
          startedAt: transfer.startedAt,
          nextProbeAt: now < transfer.startedAt ? transfer.startedAt : now,
        },
      }
      continue
    }
    if (meta !== undefined) entries[id] = unresolved(requestFromMeta(id, meta, receipt), 0, now)
  }

  const decoded = decodeTransferRegistryStore({
    version: TRANSFER_REGISTRY_VERSION,
    entries,
    profiles: {},
    legacy,
  })
  return decoded.ok
    ? { ok: true, state: decoded.state }
    : {
        ok: false,
        state: emptyTransferRegistryStore,
        kind: 'legacy-corruption',
        reason: `invalid migrated registry: ${decoded.reason}`,
      }
}
