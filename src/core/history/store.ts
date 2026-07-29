import { MAX_TRANSFER_REGISTRY_ENTRIES } from '../download/transfer-registry-model'
import { hasWireKeys, isWireRecord } from '../wire/exact'
import { isTransferProjectionId } from '../wire/identity'
import { isJsonWithinByteBudget } from '../wire/json-budget'
import { MAX_TRANSFER_PROJECTION_ID_LENGTH } from '../wire/limits'
import {
  MAX_DOWNLOAD_HISTORY_RECORD_BYTES,
  applyOutcome,
  decodeDownloadRecord,
  decodeLegacyDownloadRecord,
  type DownloadRecord,
} from './record'

/** Beyond this many records the oldest are ring-evicted. */
export const DEFAULT_HISTORY_CAP = 500
/** One reset can fence every terminal-pending Registry entry. */
export const MAX_HISTORY_RESET_FENCE = MAX_TRANSFER_REGISTRY_ENTRIES
/** JSON may encode one hostile UTF-16 code unit as `\uXXXX`. */
const MAX_JSON_ESCAPED_CODE_UNIT_BYTES = 6
export const MAX_DOWNLOAD_HISTORY_BYTES =
  DEFAULT_HISTORY_CAP * MAX_DOWNLOAD_HISTORY_RECORD_BYTES +
  MAX_HISTORY_RESET_FENCE *
    (MAX_TRANSFER_PROJECTION_ID_LENGTH * MAX_JSON_ESCAPED_CODE_UNIT_BYTES + 3) +
  2_048
export const DOWNLOAD_STORE_VERSION = 3 as const

export interface HistoryCollection {
  readonly records: ReadonlyArray<DownloadRecord>
}

/** The durable local download history (newest-first), the local twin of `media_state`. */
export interface DownloadStore extends HistoryCollection {
  readonly version: typeof DOWNLOAD_STORE_VERSION
  /** Stable Registry projection identities that were terminal before the last reset. */
  readonly resetFence: ReadonlyArray<string>
}

export const emptyStore: DownloadStore = {
  version: DOWNLOAD_STORE_VERSION,
  resetFence: [],
  records: [],
}

export type StoredHistoryDecode =
  | { readonly kind: 'absent'; readonly store: DownloadStore }
  | { readonly kind: 'current'; readonly store: DownloadStore }
  | { readonly kind: 'legacy'; readonly store: DownloadStore }
  | { readonly kind: 'corrupt' }

const readBoundedRecords = (raw: unknown): ReadonlyArray<unknown> | undefined => {
  try {
    if (!isWireRecord(raw)) return undefined
    const descriptor = Object.getOwnPropertyDescriptor(raw, 'records')
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !('value' in descriptor) ||
      !Array.isArray(descriptor.value) ||
      descriptor.value.length > DEFAULT_HISTORY_CAP
    )
      return undefined
    return descriptor.value
  } catch {
    return undefined
  }
}

const readResetFence = (raw: unknown): ReadonlyArray<string> | undefined => {
  try {
    if (!isWireRecord(raw)) return undefined
    const descriptor = Object.getOwnPropertyDescriptor(raw, 'resetFence')
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !('value' in descriptor) ||
      !Array.isArray(descriptor.value) ||
      descriptor.value.length > MAX_HISTORY_RESET_FENCE
    )
      return undefined
    const ids = new Set<string>()
    let previous: string | undefined
    for (const value of descriptor.value) {
      if (
        !isTransferProjectionId(value) ||
        ids.has(value) ||
        (previous !== undefined && previous > value)
      )
        return undefined
      ids.add(value)
      previous = value
    }
    return [...ids]
  } catch {
    return undefined
  }
}

const decodeHistoryCollection = (
  raw: unknown,
  envelopeKeys: readonly string[],
  decodeRecord: (value: unknown) => DownloadRecord | undefined,
): HistoryCollection | undefined => {
  const records = readBoundedRecords(raw)
  if (
    records === undefined ||
    !isJsonWithinByteBudget(raw, MAX_DOWNLOAD_HISTORY_BYTES) ||
    !hasWireKeys(raw, envelopeKeys)
  )
    return undefined
  const decoded: DownloadRecord[] = []
  const ids = new Set<string>()
  for (const record of records) {
    const item = decodeRecord(record)
    if (item === undefined || ids.has(item.requestId)) return undefined
    ids.add(item.requestId)
    decoded.push(item)
  }
  return { records: decoded }
}

const storedVersion = (raw: unknown): unknown => {
  try {
    if (!isWireRecord(raw)) return undefined
    const descriptor = Object.getOwnPropertyDescriptor(raw, 'version')
    return descriptor !== undefined && descriptor.enumerable === true && 'value' in descriptor
      ? descriptor.value
      : undefined
  } catch {
    return undefined
  }
}

const isNewestFirst = (records: ReadonlyArray<DownloadRecord>): boolean =>
  records.every((record, index) => index === 0 || records[index - 1]!.queuedAt >= record.queuedAt)

const canonicalQueueOrder = (
  records: ReadonlyArray<DownloadRecord>,
): ReadonlyArray<DownloadRecord> =>
  [...records].toSorted((left, right) => right.queuedAt - left.queuedAt)

/** Decode current, v2, or unversioned durable History without hiding migration state. */
export const decodeStoredHistory = (raw: unknown): StoredHistoryDecode => {
  if (raw === null || raw === undefined) return { kind: 'absent', store: emptyStore }
  const version = storedVersion(raw)
  if (version === DOWNLOAD_STORE_VERSION) {
    const resetFence = readResetFence(raw)
    if (resetFence === undefined) return { kind: 'corrupt' }
    const current = decodeHistoryCollection(
      raw,
      ['version', 'resetFence', 'records'],
      decodeDownloadRecord,
    )
    return current === undefined || !isNewestFirst(current.records)
      ? { kind: 'corrupt' }
      : {
          kind: 'current',
          store: { version: DOWNLOAD_STORE_VERSION, resetFence, records: current.records },
        }
  }
  if (version === 2) {
    const previous = decodeHistoryCollection(raw, ['version', 'records'], decodeDownloadRecord)
    return previous === undefined
      ? { kind: 'corrupt' }
      : {
          kind: 'legacy',
          store: {
            version: DOWNLOAD_STORE_VERSION,
            resetFence: [],
            records: canonicalQueueOrder(previous.records),
          },
        }
  }

  const legacy = decodeHistoryCollection(raw, ['records'], decodeLegacyDownloadRecord)
  return legacy === undefined
    ? { kind: 'corrupt' }
    : {
        kind: 'legacy',
        store: {
          version: DOWNLOAD_STORE_VERSION,
          resetFence: [],
          records: canonicalQueueOrder(legacy.records),
        },
      }
}

/** Decode one exact bounded History reply; invalid replies stay unavailable. */
export const decodeHistoryResponse = (raw: unknown): HistoryCollection | undefined => {
  const history = decodeHistoryCollection(raw, ['records'], decodeDownloadRecord)
  return history !== undefined && isNewestFirst(history.records) ? history : undefined
}

const isTerminal = (s: DownloadRecord['status']): boolean => s === 'completed' || s === 'failed'

/** Replace all records and fence exact terminal projections observed by Registry at reset. */
export function resetHistory(terminalProjectionIds: ReadonlyArray<string>): DownloadStore {
  if (terminalProjectionIds.length > MAX_HISTORY_RESET_FENCE)
    throw new RangeError('History reset fence exceeds the Transfer Registry bound')
  const resetFence = new Set<string>()
  for (const projectionId of terminalProjectionIds) {
    if (!isTransferProjectionId(projectionId))
      throw new TypeError('History reset fence contains an invalid projection id')
    resetFence.add(projectionId)
  }
  return {
    version: DOWNLOAD_STORE_VERSION,
    resetFence: [...resetFence].toSorted(),
    records: [],
  }
}

export const isHistoryProjectionFenced = (store: DownloadStore, projectionId: string): boolean =>
  store.resetFence.includes(projectionId)

/**
 * Insert by immutable queue time or update in place by `requestId`.
 * Duplicate queued admission is an exact no-op. Delayed replay cannot become newest.
 */
export function upsert(
  store: DownloadStore,
  record: DownloadRecord,
  cap: number = DEFAULT_HISTORY_CAP,
): DownloadStore {
  const boundedCap =
    Number.isSafeInteger(cap) && cap >= 0 ? Math.min(cap, DEFAULT_HISTORY_CAP) : DEFAULT_HISTORY_CAP
  const existingIndex = store.records.findIndex(
    (candidate) => candidate.requestId === record.requestId,
  )
  if (existingIndex >= 0) {
    const existing = store.records[existingIndex]
    if (existing === undefined || record.status === 'queued' || isTerminal(existing.status))
      return store
    const records = [...store.records]
    records[existingIndex] = record
    return { ...store, records }
  }

  const insertionIndex = store.records.findIndex(
    (candidate) => record.queuedAt >= candidate.queuedAt,
  )
  const records =
    insertionIndex < 0
      ? [...store.records, record]
      : [...store.records.slice(0, insertionIndex), record, ...store.records.slice(insertionIndex)]
  return { ...store, records: records.slice(0, boundedCap) }
}

/**
 * Apply a terminal outcome to an existing record in place; no-op if the request is
 * unknown. Monotonic: once a record is terminal, a later contradictory outcome
 * (e.g. a cross-recycle boot reconcile recording `failed` after `completed` was
 * already mirrored) does NOT regress it — the first terminal wins.
 */
export function applyTransition(
  store: DownloadStore,
  requestId: string,
  kind: 'completed' | 'failed',
  at: number,
  bytes?: { received: number; total: number },
): DownloadStore {
  let changed = false
  const records = store.records.map((r) => {
    if (r.requestId !== requestId || isTerminal(r.status)) return r
    changed = true
    return applyOutcome(r, kind, at, bytes)
  })
  return changed ? { ...store, records } : store
}
