import { storage } from 'wxt/utils/storage'
import {
  type FetchedLeaseOwner,
  type FetchedTransferOwner,
} from '../core/download/fetched-transfer-contract'
import { isSafeId, MAX_TRANSFER_ATTEMPTS } from '../core/download/transfer-registry-model'
import { isOffscreenBlobObjectUrl } from '../core/offscreen-blob-protocol'
import { isTransferProjectionId } from '../core/wire/identity'
import { MAX_TRANSFER_REGISTRY_ID_LENGTH } from '../core/wire/limits'

export const FETCHED_BLOB_LEASE_STORE_VERSION = 3 as const
export const FETCHED_BLOB_LEASE_STORE_KEY = 'session:fetchedBlobLeases'

type KnownFetchedLeaseOwner = Exclude<FetchedLeaseOwner, { readonly tag: 'legacy-unknown' }>

export type FetchedBlobLease =
  | {
      readonly leaseId: string
      readonly owner: KnownFetchedLeaseOwner
      readonly state: 'building'
      /** This checkpoint is always before `downloads.download()`. */
      readonly phase: 'reserved' | 'staging'
      readonly createdAt: number
    }
  | {
      readonly leaseId: string
      readonly owner: KnownFetchedLeaseOwner
      /** A finalized Blob URL, durably discoverable before Chrome handoff. */
      readonly state: 'ready'
      readonly objectUrl: string
      readonly createdAt: number
      readonly finalizedAt: number
    }
  | {
      readonly leaseId: string
      readonly owner: KnownFetchedLeaseOwner
      readonly state: 'active'
      readonly downloadId: number
      /** The lease reservation time; never overwritten at later transitions. */
      readonly createdAt: number
      /** The Chrome handoff time. */
      readonly activatedAt: number
    }
  | {
      /** Terminal proof is durable before an autonomous revoke retry. */
      readonly leaseId: string
      readonly owner: KnownFetchedLeaseOwner
      readonly state: 'terminal'
      readonly cleanup: 'projector' | 'autonomous' | 'capture'
      readonly downloadId: number
      readonly createdAt: number
      readonly terminalAt: number
    }
  | {
      /** v1 building rows predate the pre-handoff checkpoint and remain fail-closed. */
      readonly leaseId: string
      readonly owner: { readonly tag: 'legacy-unknown' }
      readonly state: 'ambiguous'
      readonly createdAt: number
    }

export interface FetchedBlobLeaseStore {
  /** v2 snapshots decode read-only until their next successful write. */
  readonly version: 2 | 3
  readonly leases: Readonly<Record<string, FetchedBlobLease>>
}

export interface FetchedBlobLeaseStorage {
  readonly get: () => Promise<unknown>
  readonly set: (store: FetchedBlobLeaseStore) => Promise<void>
}

export const emptyFetchedBlobLeaseStore = (): FetchedBlobLeaseStore => ({
  version: FETCHED_BLOB_LEASE_STORE_VERSION,
  leases: {},
})

const isSafeInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const MAX_FETCHED_LEASE_TEXT_LENGTH = MAX_TRANSFER_REGISTRY_ID_LENGTH
const MAX_FETCHED_LEASES = 256
export const isSafeFetchedBlobLeaseKey = (value: string): boolean =>
  value !== '__proto__' && value !== 'prototype' && value !== 'constructor'
export const isValidFetchedBlobLeaseText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_FETCHED_LEASE_TEXT_LENGTH
const exact = (value: unknown, keys: ReadonlyArray<string>): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key))

const decodeOwner = (value: unknown): FetchedLeaseOwner | null => {
  if (exact(value, ['tag']) && value.tag === 'legacy-unknown') return { tag: 'legacy-unknown' }
  if (
    exact(value, ['tag', 'exportId']) &&
    value.tag === 'capture' &&
    isValidFetchedBlobLeaseText(value.exportId)
  )
    return { tag: 'capture', exportId: value.exportId }
  const hasPrior =
    typeof value === 'object' && value !== null && Object.hasOwn(value, 'priorDownloadId')
  if (
    exact(value, [
      'tag',
      'requestId',
      'projectionId',
      'attempt',
      'since',
      ...(hasPrior ? ['priorDownloadId'] : []),
    ]) &&
    value.tag === 'transfer' &&
    isSafeId(value.requestId) &&
    isTransferProjectionId(value.projectionId) &&
    isSafeInt(value.attempt) &&
    value.attempt <= MAX_TRANSFER_ATTEMPTS &&
    isSafeInt(value.since) &&
    (!hasPrior || isSafeInt(value.priorDownloadId))
  )
    return {
      tag: 'transfer',
      requestId: value.requestId,
      projectionId: value.projectionId,
      attempt: value.attempt,
      since: value.since,
      ...(hasPrior ? { priorDownloadId: value.priorDownloadId as number } : {}),
    } satisfies FetchedTransferOwner
  return null
}

function decodeLease(key: string, value: unknown): FetchedBlobLease | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const leaseId = raw.leaseId
  const owner = decodeOwner(raw.owner)
  const createdAt = raw.createdAt
  if (
    !isValidFetchedBlobLeaseText(leaseId) ||
    leaseId !== key ||
    owner === null ||
    !isSafeInt(createdAt)
  )
    return null
  if (owner.tag === 'transfer' && owner.since > createdAt) return null
  if (owner.tag === 'legacy-unknown')
    return exact(value, ['leaseId', 'owner', 'state', 'createdAt']) && value.state === 'ambiguous'
      ? { leaseId, owner, state: 'ambiguous', createdAt }
      : null
  if (exact(value, ['leaseId', 'owner', 'state', 'phase', 'createdAt']))
    return value.state === 'building' && (value.phase === 'reserved' || value.phase === 'staging')
      ? { leaseId, owner, state: 'building', phase: value.phase, createdAt }
      : null
  if (exact(value, ['leaseId', 'owner', 'state', 'objectUrl', 'createdAt', 'finalizedAt']))
    return value.state === 'ready' &&
      isOffscreenBlobObjectUrl(value.objectUrl) &&
      isSafeInt(value.finalizedAt) &&
      value.finalizedAt >= createdAt
      ? {
          leaseId,
          owner,
          state: 'ready',
          objectUrl: value.objectUrl,
          createdAt,
          finalizedAt: value.finalizedAt,
        }
      : null
  if (exact(value, ['leaseId', 'owner', 'state', 'downloadId', 'createdAt', 'activatedAt']))
    return value.state === 'active' &&
      isSafeInt(value.downloadId) &&
      isSafeInt(value.activatedAt) &&
      value.activatedAt >= createdAt
      ? {
          leaseId,
          owner,
          state: 'active',
          downloadId: value.downloadId,
          createdAt,
          activatedAt: value.activatedAt,
        }
      : null
  if (
    exact(value, ['leaseId', 'owner', 'state', 'cleanup', 'downloadId', 'createdAt', 'terminalAt'])
  )
    return value.state === 'terminal' &&
      (value.cleanup === 'projector' ||
        value.cleanup === 'autonomous' ||
        value.cleanup === 'capture') &&
      isSafeInt(value.downloadId) &&
      isSafeInt(value.terminalAt) &&
      value.terminalAt >= createdAt
      ? {
          leaseId,
          owner,
          state: 'terminal',
          cleanup: value.cleanup,
          downloadId: value.downloadId,
          createdAt,
          terminalAt: value.terminalAt,
        }
      : null
  return null
}

const decodeV1Lease = (key: string, value: unknown): FetchedBlobLease | null => {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  if (
    !isSafeFetchedBlobLeaseKey(key) ||
    !isValidFetchedBlobLeaseText(raw.leaseId) ||
    raw.leaseId !== key ||
    !isValidFetchedBlobLeaseText(raw.requestId) ||
    !isSafeInt(raw.createdAt)
  )
    return null
  const known =
    (exact(value, ['leaseId', 'requestId', 'state', 'phase', 'createdAt']) &&
      raw.state === 'building' &&
      raw.phase === 'staging') ||
    (exact(value, ['leaseId', 'requestId', 'state', 'objectUrl', 'createdAt', 'finalizedAt']) &&
      raw.state === 'ready' &&
      isOffscreenBlobObjectUrl(raw.objectUrl) &&
      isSafeInt(raw.finalizedAt) &&
      raw.finalizedAt >= raw.createdAt) ||
    (exact(value, ['leaseId', 'requestId', 'state', 'downloadId', 'createdAt', 'activatedAt']) &&
      raw.state === 'active' &&
      isSafeInt(raw.downloadId) &&
      isSafeInt(raw.activatedAt) &&
      raw.activatedAt >= raw.createdAt) ||
    (exact(value, ['leaseId', 'requestId', 'state', 'downloadId', 'createdAt']) &&
      raw.state === 'active' &&
      isSafeInt(raw.downloadId)) ||
    (exact(value, ['leaseId', 'requestId', 'state', 'createdAt']) &&
      (raw.state === 'building' || raw.state === 'ambiguous'))
  if (!known) return null
  return {
    leaseId: raw.leaseId,
    owner: { tag: 'legacy-unknown' },
    state: 'ambiguous',
    createdAt: raw.createdAt,
  }
}

/** Strict storage boundary. A malformed value blocks new starts; it is never overwritten. */
export function decodeFetchedBlobLeaseStore(value: unknown): FetchedBlobLeaseStore | null {
  if (!exact(value, ['version', 'leases'])) return null
  if (
    value.version !== 1 &&
    value.version !== 2 &&
    value.version !== FETCHED_BLOB_LEASE_STORE_VERSION
  )
    return null
  if (typeof value.leases !== 'object' || value.leases === null || Array.isArray(value.leases))
    return null
  if (Object.keys(value.leases).length > MAX_FETCHED_LEASES) return null
  const leases: Record<string, FetchedBlobLease> = Object.create(null) as Record<
    string,
    FetchedBlobLease
  >
  const activeDownloadIds = new Set<number>()
  const readyUrls = new Set<string>()
  const owners = new Set<string>()
  for (const [key, lease] of Object.entries(value.leases)) {
    if (!isSafeFetchedBlobLeaseKey(key)) return null
    const decoded =
      value.version === FETCHED_BLOB_LEASE_STORE_VERSION || value.version === 2
        ? decodeLease(key, lease)
        : value.version === 1
          ? decodeV1Lease(key, lease)
          : null
    if (decoded === null) return null
    if (decoded.state === 'active') {
      if (activeDownloadIds.has(decoded.downloadId)) return null
      activeDownloadIds.add(decoded.downloadId)
    }
    if (decoded.state === 'ready') {
      if (readyUrls.has(decoded.objectUrl)) return null
      readyUrls.add(decoded.objectUrl)
    }
    const ownerKey = JSON.stringify(decoded.owner)
    if (decoded.owner.tag !== 'legacy-unknown' && owners.has(ownerKey)) return null
    owners.add(ownerKey)
    leases[key] = decoded
  }
  return { version: FETCHED_BLOB_LEASE_STORE_VERSION, leases }
}

const leaseItem = storage.defineItem<unknown>(FETCHED_BLOB_LEASE_STORE_KEY, {
  fallback: emptyFetchedBlobLeaseStore(),
})

export const makeFetchedBlobLeaseStorage = (): FetchedBlobLeaseStorage => ({
  get: () => leaseItem.getValue(),
  set: (store) => leaseItem.setValue(store),
})
