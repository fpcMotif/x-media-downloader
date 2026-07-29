import { interruptBackoffMs, isRetryableInterruptReason } from './interrupt-retry'
import type { DownloadHandle } from './strategy'
import type { FetchedBootObservation, FetchedTransferOwner } from './fetched-transfer-contract'
import { mediaRequestId } from './request-identity'
import {
  aria2EndpointIdentity,
  ARIA2_PROFILE_BACKOFF_BASE_MS,
  ARIA2_PROFILE_BACKOFF_MAX_MS,
  isAria2ErrorCode,
  isAria2ErrorMessage,
  isAria2ProfileRpcUrl,
  isAria2ProfileSecret,
  isAria2Gid,
  isAria2LaunchOptionsSnapshot,
  isCanonicalDecimal,
  isDownloadId,
  isBoundedJson,
  isRegistryTime,
  isSafeId,
  isSweepReceiptId,
  isText,
  isTransferUrl,
  MAX_ARIA2_PROFILE_FAILURES,
  FETCHED_CAPACITY_RETRY_MS,
  MAX_TRANSFER_ATTEMPTS,
  MAX_TRANSFER_REGISTRY_ENTRIES,
  MAX_TRANSFER_REGISTRY_STORE_BYTES,
  type Aria2LiveStatus,
  type Aria2Profile,
  type Aria2LaunchReservation,
  type Aria2ProfileSnapshot,
  type ForgetTransferToken,
  type LegacyForgetTransferToken,
  type LaunchToken,
  type LegacyTransferEntry,
  type RegistryMutation,
  type RetryRefreshToken,
  type TerminalEvidence,
  type TransferEntry,
  type TransferLaunchGroup,
  type TransferMode,
  type TransferRecoveryPhase,
  type TransferRegistryStore,
  type TransferRequest,
} from './transfer-registry-model'
import {
  decodeTransferRegistryStore,
  decodeTransferRequest,
  type DecodeTransferRegistryResult,
} from './transfer-registry-codec'

export * from './transfer-registry-model'
export { decodeTransferRegistryStore, decodeTransferRequest }
export type { DecodeTransferRegistryResult }

const noChange = (state: TransferRegistryStore): RegistryMutation => ({
  state,
  changed: false,
})
const replaceEntry = (
  state: TransferRegistryStore,
  id: string,
  entry: TransferEntry,
): TransferRegistryStore => ({
  ...state,
  entries: { ...state.entries, [id]: entry },
})
const normalizeTime = (value: number, ...floors: readonly number[]): number => {
  if (!isRegistryTime(value) || !floors.every(isRegistryTime))
    throw new TypeError('invalid transition time')
  const result = Math.max(value, ...floors)
  if (!isRegistryTime(result)) throw new TypeError('invalid transition time')
  return result
}
const saturatingDeadline = (now: number, delay: number): number => {
  if (!isRegistryTime(now) || !isRegistryTime(delay)) throw new TypeError('invalid deadline')
  return now > Number.MAX_SAFE_INTEGER - delay ? Number.MAX_SAFE_INTEGER : now + delay
}
/** The longest normal persisted wait. Larger future times prove a clock rollback. */
const BOOT_CLOCK_ROLLBACK_SKEW_MS = ARIA2_PROFILE_BACKOFF_MAX_MS
const timeAfterBootHorizon = (value: number, now: number): boolean =>
  value > saturatingDeadline(now, BOOT_CLOCK_ROLLBACK_SKEW_MS)
const rebaseTimeAtBoot = (value: number, now: number): number => Math.min(value, now)
const currentLaunch = (
  entry: TransferEntry | undefined,
  token: LaunchToken,
): entry is TransferEntry =>
  entry !== undefined &&
  entry.request.id === token.id &&
  ((entry.phase.tag === 'launching' &&
    entry.phase.attempt === token.attempt &&
    entry.phase.since === token.since &&
    token.gid === undefined &&
    token.priorDownloadId === undefined) ||
    (entry.phase.tag === 'direct-prepared' &&
      entry.request.mode === 'direct' &&
      entry.phase.attempt === token.attempt &&
      entry.phase.since === token.since &&
      token.gid === undefined &&
      token.priorDownloadId === undefined) ||
    (entry.phase.tag === 'direct-ready' &&
      entry.request.mode === 'direct' &&
      entry.phase.attempt === token.attempt &&
      entry.phase.since === token.since &&
      token.gid === undefined &&
      token.priorDownloadId === undefined) ||
    (entry.phase.tag === 'fetched-prepared' &&
      entry.request.mode === 'fetched' &&
      entry.phase.attempt === token.attempt &&
      entry.phase.since === token.since &&
      token.gid === undefined &&
      token.priorDownloadId === undefined) ||
    (entry.phase.tag === 'ready' &&
      entry.request.mode === 'fetched' &&
      entry.phase.attempt === token.attempt &&
      entry.phase.since === token.since &&
      token.gid === undefined &&
      token.priorDownloadId === entry.phase.priorDownloadId) ||
    (entry.phase.tag === 'fetched-call-armed' &&
      entry.request.mode === 'fetched' &&
      entry.phase.attempt === token.attempt &&
      entry.phase.since === token.since &&
      token.gid === undefined &&
      token.priorDownloadId === entry.phase.priorDownloadId) ||
    (entry.phase.tag === 'retry-launching' &&
      entry.phase.attempt === token.attempt &&
      entry.phase.since === token.since &&
      token.gid === undefined &&
      token.priorDownloadId === entry.phase.priorDownloadId) ||
    (entry.phase.tag === 'aria2-launching' &&
      entry.phase.attempt === token.attempt &&
      entry.phase.since === token.since &&
      token.gid === entry.phase.gid &&
      token.priorDownloadId === undefined) ||
    (entry.phase.tag === 'aria2-prepared' &&
      entry.request.mode === 'aria2' &&
      entry.phase.attempt === token.attempt &&
      entry.phase.since === token.since &&
      token.gid === entry.phase.gid &&
      token.priorDownloadId === undefined) ||
    (entry.phase.tag === 'aria2-ready' &&
      entry.request.mode === 'aria2' &&
      entry.phase.attempt === token.attempt &&
      entry.phase.since === token.since &&
      token.gid === entry.phase.gid &&
      token.priorDownloadId === undefined))
const currentFetchedCall = (
  entry: TransferEntry | undefined,
  token: LaunchToken,
  leaseId?: string,
): entry is TransferEntry & {
  readonly phase: Extract<TransferEntry['phase'], { readonly tag: 'fetched-call-armed' }>
} =>
  entry?.request.mode === 'fetched' &&
  entry.phase.tag === 'fetched-call-armed' &&
  entry.request.id === token.id &&
  entry.phase.attempt === token.attempt &&
  entry.phase.since === token.since &&
  entry.phase.priorDownloadId === token.priorDownloadId &&
  (leaseId === undefined || entry.phase.leaseId === leaseId)
const currentAria2Call = (
  entry: TransferEntry | undefined,
  token: LaunchToken,
): entry is TransferEntry =>
  entry?.phase.tag === 'aria2-call-armed' &&
  entry.request.id === token.id &&
  entry.phase.attempt === token.attempt &&
  entry.phase.since === token.since &&
  entry.phase.gid === token.gid
const profileMatches = (left: Aria2Profile, right: Aria2ProfileSnapshot): boolean =>
  left.profileId === right.profileId &&
  aria2EndpointIdentity(left.rpcUrl) === aria2EndpointIdentity(right.rpcUrl) &&
  left.secret === right.secret
const profileSnapshotKey = (profile: Pick<Aria2ProfileSnapshot, 'rpcUrl' | 'secret'>): string =>
  JSON.stringify([aria2EndpointIdentity(profile.rpcUrl), profile.secret])
const profileFrom = (snapshot: Aria2ProfileSnapshot, at: number): Aria2Profile => ({
  ...snapshot,
  failureCount: 0,
  nextProbeAt: at,
})
const aria2ClaimFrom = (
  phase: TransferEntry['phase'] | TransferRecoveryPhase,
): { readonly profileId: string; readonly gid?: string } | undefined => {
  if (
    phase.tag === 'aria2-prepared' ||
    phase.tag === 'aria2-ready' ||
    phase.tag === 'aria2-launching' ||
    phase.tag === 'aria2-call-armed' ||
    phase.tag === 'aria2-active'
  )
    return { profileId: phase.profileId, gid: phase.gid }
  if (phase.tag === 'aria2-unresolved')
    return phase.profileId === undefined
      ? undefined
      : {
          profileId: phase.profileId,
          ...(phase.gid === undefined ? {} : { gid: phase.gid }),
        }
  if (phase.tag === 'forget-pending') return aria2ClaimFrom(phase.recovery)
  if (phase.tag === 'terminal-pending' && phase.evidence.tag === 'aria2')
    return { profileId: phase.evidence.profileId, gid: phase.evidence.gid }
  return undefined
}
const terminal = (entry: TransferEntry, evidence: TerminalEvidence, at: number): TransferEntry => ({
  ...entry,
  phase: { tag: 'terminal-pending', evidence, observedAt: at, projectAt: at },
})

export const terminalOutcome = (evidence: TerminalEvidence): 'complete' | 'failed' =>
  evidence.tag === 'browser'
    ? evidence.state === 'complete'
      ? 'complete'
      : 'failed'
    : evidence.tag === 'aria2'
      ? evidence.status === 'complete'
        ? 'complete'
        : 'failed'
      : 'failed'

export function launchTokenFor(state: TransferRegistryStore, id: string): LaunchToken | undefined {
  const entry = state.entries[id]
  return entry !== undefined &&
    (entry.phase.tag === 'launching' ||
      entry.phase.tag === 'direct-prepared' ||
      entry.phase.tag === 'direct-ready' ||
      entry.phase.tag === 'fetched-prepared' ||
      entry.phase.tag === 'ready' ||
      entry.phase.tag === 'fetched-call-armed' ||
      entry.phase.tag === 'retry-launching' ||
      entry.phase.tag === 'aria2-launching' ||
      entry.phase.tag === 'aria2-prepared' ||
      entry.phase.tag === 'aria2-ready')
    ? {
        id,
        attempt: entry.phase.attempt,
        since: entry.phase.since,
        ...(entry.phase.tag === 'aria2-launching' ||
        entry.phase.tag === 'aria2-prepared' ||
        entry.phase.tag === 'aria2-ready'
          ? { gid: entry.phase.gid }
          : {}),
        ...((entry.phase.tag === 'ready' ||
          entry.phase.tag === 'fetched-call-armed' ||
          entry.phase.tag === 'retry-launching') &&
        entry.phase.priorDownloadId !== undefined
          ? { priorDownloadId: entry.phase.priorDownloadId }
          : {}),
      }
    : undefined
}
export const isCurrentLaunch = (state: TransferRegistryStore, token: LaunchToken): boolean =>
  currentLaunch(state.entries[token.id], token)
export const hasConfirmedSweepOwnership = (entry: TransferEntry): boolean => {
  const receiptId = entry.request.sweepReceipt?.receiptId
  return receiptId === undefined || entry.sweepOwnership?.receiptId === receiptId
}

const currentRetryRefresh = (
  entry: TransferEntry | undefined,
  token: RetryRefreshToken,
): entry is TransferEntry & {
  readonly phase: Extract<TransferEntry['phase'], { readonly tag: 'retry-refreshing' }>
} =>
  entry?.phase.tag === 'retry-refreshing' &&
  entry.request.id === token.id &&
  entry.request.projectionId === token.projectionId &&
  entry.createdAt === token.createdAt &&
  entry.phase.attempt === token.attempt &&
  entry.phase.since === token.since &&
  entry.phase.priorDownloadId === token.priorDownloadId
const currentForget = (
  entry: TransferEntry | undefined,
  token: ForgetTransferToken,
): entry is TransferEntry & {
  readonly phase: Extract<TransferEntry['phase'], { readonly tag: 'forget-pending' }>
} =>
  entry?.phase.tag === 'forget-pending' &&
  entry.request.id === token.id &&
  entry.request.projectionId === token.projectionId &&
  entry.createdAt === token.createdAt &&
  entry.phase.since === token.since
const currentLegacyForget = (
  entry: LegacyTransferEntry | undefined,
  token: LegacyForgetTransferToken,
): entry is LegacyTransferEntry & {
  readonly phase: Extract<LegacyTransferEntry['phase'], { readonly tag: 'forget-pending' }>
} =>
  entry?.phase.tag === 'forget-pending' &&
  entry.downloadId === token.downloadId &&
  entry.startedAt === token.startedAt &&
  entry.phase.since === token.since

const ownerToken = (owner: FetchedTransferOwner): LaunchToken => ({
  id: owner.requestId,
  attempt: owner.attempt,
  since: owner.since,
  ...(owner.priorDownloadId === undefined ? {} : { priorDownloadId: owner.priorDownloadId }),
})

const ownerMatches = (entry: TransferEntry | undefined, owner: FetchedTransferOwner): boolean =>
  entry !== undefined &&
  entry.request.mode === 'fetched' &&
  entry.request.id === owner.requestId &&
  entry.request.projectionId === owner.projectionId &&
  currentLaunch(entry, ownerToken(owner))

/**
 * Claim one exact Fetched boot observation before boot quarantines launches.
 * `staging` is the sole proven pre-Chrome state; matching it may fail/retry the
 * current launch. A recovered handle uses the ordinary bind transition so all
 * later probing and terminal projection stay in one owner.
 */
export function recoverFetchedObservation(
  state: TransferRegistryStore,
  observation: Extract<FetchedBootObservation, { readonly tag: 'staging' | 'matched' }>,
  now: number,
): {
  readonly state: TransferRegistryStore
  readonly changed: boolean
  readonly accepted: boolean
} {
  const owner = observation.owner
  const entry = state.entries[owner.requestId]
  if (!ownerMatches(entry, owner)) {
    const lateBootMatch =
      entry !== undefined &&
      entry.request.mode === 'fetched' &&
      entry.request.projectionId === owner.projectionId &&
      entry.phase.tag === 'unresolved-launch' &&
      entry.phase.reason === 'worker-restart' &&
      entry.phase.attempt === owner.attempt &&
      entry.phase.since === owner.since
    if (lateBootMatch) {
      if (observation.tag === 'staging')
        return {
          state: replaceEntry(state, owner.requestId, {
            ...entry,
            phase: {
              tag: 'ready',
              attempt: owner.attempt,
              since: owner.since,
              ...(owner.priorDownloadId === undefined
                ? {}
                : { priorDownloadId: owner.priorDownloadId }),
            },
          }),
          changed: true,
          accepted: true,
        }
      if (
        !isDownloadId(observation.downloadId) ||
        observation.downloadId === owner.priorDownloadId ||
        browserIdTaken(state, observation.downloadId, owner.requestId)
      )
        return { state, changed: false, accepted: false }
      const at = normalizeTime(now, entry.createdAt, owner.since)
      return {
        state: replaceEntry(state, owner.requestId, {
          ...entry,
          phase: {
            tag: 'active',
            downloadId: observation.downloadId,
            attempt: owner.attempt,
            startedAt: at,
            nextProbeAt: at,
          },
        }),
        changed: true,
        accepted: true,
      }
    }
    if (
      observation.tag === 'staging' &&
      entry !== undefined &&
      entry.request.projectionId === owner.projectionId &&
      ((owner.priorDownloadId === undefined &&
        entry.phase.tag === 'terminal-pending' &&
        entry.phase.evidence.tag === 'start-failed') ||
        (owner.priorDownloadId !== undefined &&
          (entry.phase.tag === 'retry-wait' || entry.phase.tag === 'fetched-capacity-wait') &&
          entry.phase.attempt === owner.attempt + 1 &&
          entry.phase.priorDownloadId === owner.priorDownloadId) ||
        (owner.priorDownloadId !== undefined &&
          entry.phase.tag === 'terminal-pending' &&
          entry.phase.evidence.tag === 'browser' &&
          entry.phase.evidence.downloadId === owner.priorDownloadId))
    )
      return { state, changed: false, accepted: true }
    if (
      observation.tag === 'matched' &&
      entry !== undefined &&
      entry.request.projectionId === owner.projectionId &&
      ((entry.phase.tag === 'active' &&
        entry.phase.attempt === owner.attempt &&
        entry.phase.downloadId === observation.downloadId) ||
        (entry.phase.tag === 'browser-unresolved' &&
          entry.phase.attempt === owner.attempt &&
          entry.phase.downloadId === observation.downloadId))
    ) {
      if (observation.terminal && observation.terminalState !== undefined) {
        const terminalized = recordBrowserTerminal(state, {
          id: owner.requestId,
          downloadId: observation.downloadId,
          state: observation.terminalState,
          observedAt: now,
        })
        return { ...terminalized, accepted: terminalized.changed }
      }
      return { state, changed: false, accepted: true }
    }
    return { state, changed: false, accepted: false }
  }
  if (entry === undefined) return { state, changed: false, accepted: false }
  const token = ownerToken(owner)
  if (observation.tag === 'staging') {
    if (entry.phase.tag === 'ready') return { state, changed: false, accepted: true }
    if (!currentFetchedCall(entry, token, observation.leaseId))
      return { state, changed: false, accepted: false }
    return {
      state: replaceEntry(state, token.id, {
        ...entry,
        phase: {
          tag: 'ready',
          attempt: entry.phase.attempt,
          since: entry.phase.since,
          ...(entry.phase.priorDownloadId === undefined
            ? {}
            : { priorDownloadId: entry.phase.priorDownloadId }),
        },
      }),
      changed: true,
      accepted: true,
    }
  }
  if (currentFetchedCall(entry, token, observation.leaseId)) {
    if (observation.downloadId === entry.phase.priorDownloadId)
      return { state, changed: false, accepted: false }
    const bound = bindStarted(state, token, { kind: 'browser', id: observation.downloadId }, now)
    if (!bound.changed) return { ...bound, accepted: false }
    // Exact terminal evidence must become a durable fence before projection.
    // A probe of an already-terminal Blob id can lose this sole ownership link.
    if (observation.terminal && observation.terminalState !== undefined) {
      const terminalized = recordBrowserTerminal(bound.state, {
        id: owner.requestId,
        downloadId: observation.downloadId,
        state: observation.terminalState,
        observedAt: now,
      })
      return { ...terminalized, accepted: terminalized.changed }
    }
    return { ...bound, accepted: true }
  }
  return { state, changed: false, accepted: false }
}

/** Reject a whole media group before one durable artifact intent can exist alone. */
export function prepareLaunchGroups(
  state: TransferRegistryStore,
  groups: readonly TransferLaunchGroup[],
  now: number,
  aria2Reservations: Readonly<Record<string, Aria2LaunchReservation>> = {},
): {
  readonly state: TransferRegistryStore
  readonly launches: readonly LaunchToken[]
  readonly duplicateMainIds: readonly string[]
} {
  if (!isRegistryTime(now)) throw new TypeError('invalid launch time')
  const ids = new Set<string>()
  const occupiedRequestIds = new Set(
    Object.values(state.entries).map((entry) =>
      entry.request.item === undefined ? entry.request.id : mediaRequestId(entry.request.item),
    ),
  )
  const freshGroups: TransferLaunchGroup[] = []
  const duplicateMainIds: string[] = []
  const ariaRequestIds = new Set<string>()

  for (const group of groups) {
    if (!isSafeId(group.mainId) || group.requests.length === 0)
      throw new TypeError('invalid launch group')
    let main: TransferRequest | undefined
    let duplicate = false
    for (const input of group.requests) {
      const request = decodeTransferRequest(input)
      if (request === undefined || request.historyPolicy === 'transition-only')
        throw new TypeError('invalid new request')
      if (request.item !== undefined && request.id !== mediaRequestId(request.item))
        throw new TypeError('noncanonical request id')
      if (ids.has(request.id)) throw new Error(`duplicate request id: ${request.id}`)
      ids.add(request.id)
      if (request.mode === 'aria2') ariaRequestIds.add(request.id)
      if (request.id === group.mainId) {
        if (main !== undefined || request.item === undefined)
          throw new TypeError('invalid launch group main')
        main = request
      }
      if (
        occupiedRequestIds.has(request.id) ||
        Object.hasOwn(state.entries, request.id) ||
        Object.hasOwn(state.legacy, request.id)
      )
        duplicate = true
    }
    if (main === undefined) throw new TypeError('launch group main is absent')
    if (duplicate) duplicateMainIds.push(group.mainId)
    else freshGroups.push(group)
  }
  if (!Object.keys(aria2Reservations).every((id) => ariaRequestIds.has(id)))
    throw new TypeError('unexpected aria2 reservation')

  const freshIds = new Set(freshGroups.flatMap((group) => group.requests.map(({ id }) => id)))
  const freshReservations = Object.fromEntries(
    Object.entries(aria2Reservations).filter(([id]) => freshIds.has(id)),
  ) as Record<string, Aria2LaunchReservation>
  const prepared = prepareLaunches(
    state,
    freshGroups.flatMap(({ requests }) => requests),
    now,
    freshReservations,
  )
  return {
    state: prepared.state,
    launches: prepared.launches,
    duplicateMainIds,
  }
}

/** Persist intent and its immutable aria2 endpoint snapshot before `addUri`. */
export function prepareLaunches(
  state: TransferRegistryStore,
  requests: readonly TransferRequest[],
  now: number,
  aria2Reservations: Readonly<Record<string, Aria2LaunchReservation>> = {},
): {
  readonly state: TransferRegistryStore
  readonly launches: readonly LaunchToken[]
  readonly duplicateIds: readonly string[]
} {
  if (!isRegistryTime(now)) throw new TypeError('invalid launch time')
  const ids = new Set<string>(),
    fresh: TransferRequest[] = [],
    duplicateIds: string[] = [],
    projectionIds = new Set(
      Object.values(state.entries).map((entry) => entry.request.projectionId),
    ),
    occupiedRequestIds = new Set(
      Object.values(state.entries).map((entry) =>
        entry.request.item === undefined ? entry.request.id : mediaRequestId(entry.request.item),
      ),
    )
  for (const input of requests) {
    const request = decodeTransferRequest(input)
    if (request === undefined || request.historyPolicy === 'transition-only')
      throw new TypeError('invalid new request')
    if (request.item !== undefined && request.id !== mediaRequestId(request.item))
      throw new TypeError('noncanonical request id')
    if (ids.has(request.id)) throw new Error(`duplicate request id: ${request.id}`)
    ids.add(request.id)
    if (
      occupiedRequestIds.has(request.id) ||
      Object.hasOwn(state.entries, request.id) ||
      Object.hasOwn(state.legacy, request.id)
    )
      duplicateIds.push(request.id)
    else {
      if (projectionIds.has(request.projectionId))
        throw new Error(`duplicate projection id: ${request.projectionId}`)
      projectionIds.add(request.projectionId)
      fresh.push(request)
    }
  }
  if (
    Object.keys(state.entries).length + Object.keys(state.legacy).length + fresh.length >
    MAX_TRANSFER_REGISTRY_ENTRIES
  )
    throw new RangeError('registry entry limit')
  const aria2Requests = fresh.filter((row) => row.mode === 'aria2')
  if (
    !Object.keys(aria2Reservations).every((id) =>
      aria2Requests.some((request) => request.id === id),
    )
  )
    throw new TypeError('unexpected aria2 reservation')
  const reservedGids = new Set<string>()
  const profileOwnerBySnapshot = new Map<string, string>()
  for (const existing of Object.values(state.profiles)) {
    const snapshotKey = profileSnapshotKey(existing)
    const snapshotOwner = profileOwnerBySnapshot.get(snapshotKey)
    if (snapshotOwner !== undefined && snapshotOwner !== existing.profileId)
      throw new Error(`aria2 profile snapshot already owned by ${snapshotOwner}`)
    profileOwnerBySnapshot.set(snapshotKey, existing.profileId)
  }
  for (const request of aria2Requests) {
    const reservation = aria2Reservations[request.id]
    if (reservation === undefined) throw new TypeError('aria2 reservation required')
    if (
      !isSafeId(reservation.profile.profileId) ||
      !isAria2ProfileRpcUrl(reservation.profile.rpcUrl) ||
      !isAria2ProfileSecret(reservation.profile.secret) ||
      !isAria2Gid(reservation.gid) ||
      reservation.gid !== reservation.gid.toLowerCase() ||
      !isAria2LaunchOptionsSnapshot(reservation.options)
    )
      throw new TypeError('invalid aria2 reservation')
    const existing = state.profiles[reservation.profile.profileId]
    if (existing !== undefined && !profileMatches(existing, reservation.profile))
      throw new Error('aria2 profile snapshot mismatch')
    const snapshotKey = profileSnapshotKey(reservation.profile)
    const snapshotOwner = profileOwnerBySnapshot.get(snapshotKey)
    if (snapshotOwner !== undefined && snapshotOwner !== reservation.profile.profileId)
      throw new Error(`aria2 profile snapshot already owned by ${snapshotOwner}`)
    profileOwnerBySnapshot.set(snapshotKey, reservation.profile.profileId)
    const reservationEndpoint = aria2EndpointIdentity(reservation.profile.rpcUrl)
    const pair = `${reservationEndpoint ?? reservation.profile.rpcUrl}:${reservation.gid}`
    if (reservedGids.has(pair)) throw new Error(`duplicate aria2 gid: ${reservation.gid}`)
    reservedGids.add(pair)
    if (
      Object.values(state.entries).some((entry) => {
        const claim = aria2ClaimFrom(entry.phase)
        const existingProfile = claim === undefined ? undefined : state.profiles[claim.profileId]
        return (
          existingProfile !== undefined &&
          aria2EndpointIdentity(existingProfile.rpcUrl) === reservationEndpoint &&
          claim?.gid === reservation.gid
        )
      })
    )
      throw new Error(`duplicate aria2 gid: ${reservation.gid}`)
  }
  if (fresh.length === 0) return { state, launches: [], duplicateIds }
  const entries = { ...state.entries },
    profiles = { ...state.profiles },
    launches: LaunchToken[] = []
  for (const reservation of Object.values(aria2Reservations))
    if (profiles[reservation.profile.profileId] === undefined)
      profiles[reservation.profile.profileId] = profileFrom(reservation.profile, now)
  for (const request of fresh) {
    const reservation = aria2Reservations[request.id]
    const phase =
      request.mode === 'aria2'
        ? {
            tag: 'aria2-prepared' as const,
            attempt: 0 as const,
            since: now,
            profileId: reservation!.profile.profileId,
            gid: reservation!.gid,
            options: reservation!.options,
          }
        : request.mode === 'fetched'
          ? { tag: 'fetched-prepared' as const, attempt: 0 as const, since: now }
          : { tag: 'direct-prepared' as const, attempt: 0 as const, since: now }
    entries[request.id] = { request, createdAt: now, phase }
    launches.push({
      id: request.id,
      attempt: 0,
      since: now,
      ...(request.mode === 'aria2' ? { gid: reservation!.gid } : {}),
    })
  }
  const next = { ...state, entries, profiles }
  if (!isBoundedJson(next, MAX_TRANSFER_REGISTRY_STORE_BYTES))
    throw new RangeError('registry store size')
  return { state: next, launches, duplicateIds }
}

/**
 * Commits the external-admission permit. A crash before this mutation leaves
 * prepared rows inert; a crash after it may safely resume ready rows.
 */
export function permitPreparedLaunches(
  state: TransferRegistryStore,
  tokens: readonly LaunchToken[],
): RegistryMutation {
  const ids = new Set<string>()
  for (const token of tokens) {
    if (ids.has(token.id)) throw new Error(`duplicate launch token: ${token.id}`)
    ids.add(token.id)
    const entry = state.entries[token.id]
    const phase = entry?.phase
    const permitted =
      phase?.tag === 'direct-ready' ||
      (phase?.tag === 'ready' && phase.attempt === 0 && phase.priorDownloadId === undefined) ||
      phase?.tag === 'aria2-ready'
    const prepared =
      phase?.tag === 'direct-prepared' ||
      phase?.tag === 'fetched-prepared' ||
      phase?.tag === 'aria2-prepared'
    if (!currentLaunch(entry, token) || (!prepared && !permitted))
      throw new Error(`stale prepared launch: ${token.id}`)
  }
  let entries: Record<string, TransferEntry> | undefined
  for (const token of tokens) {
    const entry = state.entries[token.id]!
    const phase = entry.phase
    if (
      phase.tag !== 'direct-prepared' &&
      phase.tag !== 'fetched-prepared' &&
      phase.tag !== 'aria2-prepared'
    )
      continue
    entries ??= { ...state.entries }
    entries[token.id] = {
      ...entry,
      phase:
        phase.tag === 'direct-prepared'
          ? { tag: 'direct-ready', attempt: phase.attempt, since: phase.since }
          : phase.tag === 'fetched-prepared'
            ? { tag: 'ready', attempt: phase.attempt, since: phase.since }
            : {
                tag: 'aria2-ready',
                attempt: phase.attempt,
                since: phase.since,
                profileId: phase.profileId,
                gid: phase.gid,
                options: phase.options,
              },
    }
  }
  if (entries === undefined) return noChange(state)
  const next = { ...state, entries }
  if (!isBoundedJson(next, MAX_TRANSFER_REGISTRY_STORE_BYTES))
    throw new RangeError('registry store size')
  return { state: next, changed: true }
}

export function abandonPrepared(
  state: TransferRegistryStore,
  tokens: readonly LaunchToken[],
): RegistryMutation {
  const ids = new Set<string>()
  for (const token of tokens) {
    if (ids.has(token.id)) throw new Error(`duplicate launch token: ${token.id}`)
    ids.add(token.id)
    const entry = state.entries[token.id]
    if (entry === undefined) continue
    if (
      !currentLaunch(entry, token) ||
      (entry.phase.tag !== 'direct-prepared' &&
        entry.phase.tag !== 'fetched-prepared' &&
        entry.phase.tag !== 'aria2-prepared') ||
      token.priorDownloadId !== undefined
    )
      throw new Error(`stale prepared launch: ${token.id}`)
  }
  const present = tokens.filter((token) => state.entries[token.id] !== undefined)
  if (present.length === 0) return noChange(state)
  const entries = { ...state.entries }
  for (const token of present) delete entries[token.id]
  return { state: pruneProfiles({ ...state, entries }), changed: true }
}

/** Commits Clear ownership before any Sweep-tagged pre-call state may run. */
export function confirmSweepOwnership(
  state: TransferRegistryStore,
  confirmations: ReadonlyMap<string, number>,
): RegistryMutation {
  let entries: Record<string, TransferEntry> | undefined
  const found = new Set<string>()
  for (const [receiptId, clearSeedId] of confirmations) {
    if (!isSweepReceiptId(receiptId) || !isRegistryTime(clearSeedId) || clearSeedId < 1)
      throw new TypeError('invalid Sweep ownership confirmation')
    for (const [id, entry] of Object.entries(state.entries)) {
      if (entry.request.sweepReceipt?.receiptId !== receiptId) continue
      found.add(receiptId)
      if (entry.sweepOwnership !== undefined) {
        if (
          entry.sweepOwnership.receiptId !== receiptId ||
          entry.sweepOwnership.clearSeedId !== clearSeedId
        )
          throw new Error(`conflicting Sweep ownership: ${receiptId}`)
        continue
      }
      entries ??= { ...state.entries }
      entries[id] = {
        ...entry,
        sweepOwnership: { receiptId, clearSeedId },
      }
    }
  }
  for (const receiptId of confirmations.keys())
    if (!found.has(receiptId)) throw new Error(`missing Sweep intent: ${receiptId}`)
  if (entries === undefined) return noChange(state)
  const next = { ...state, entries }
  if (!isBoundedJson(next, MAX_TRANSFER_REGISTRY_STORE_BYTES))
    throw new RangeError('registry store size')
  return { state: next, changed: true }
}

/** Removes only an exact unconfirmed Sweep receipt whose calls are still safe. */
export function abandonSweepReceipt(
  state: TransferRegistryStore,
  receiptId: string,
): RegistryMutation {
  if (!isSweepReceiptId(receiptId)) throw new TypeError('invalid Sweep receipt')
  const matches = Object.entries(state.entries).filter(
    ([, entry]) => entry.request.sweepReceipt?.receiptId === receiptId,
  )
  if (matches.length === 0) return noChange(state)
  if (
    matches.some(([, entry]) => {
      if (entry.sweepOwnership !== undefined) return true
      const phase = entry.phase
      return !(
        phase.tag === 'direct-prepared' ||
        phase.tag === 'direct-ready' ||
        phase.tag === 'fetched-prepared' ||
        phase.tag === 'aria2-prepared' ||
        phase.tag === 'aria2-ready' ||
        (phase.tag === 'ready' && phase.attempt === 0 && phase.priorDownloadId === undefined) ||
        (phase.tag === 'fetched-capacity-wait' &&
          phase.attempt === 0 &&
          phase.priorDownloadId === undefined)
      )
    })
  )
    return noChange(state)
  const entries = { ...state.entries }
  for (const [id] of matches) delete entries[id]
  return { state: pruneProfiles({ ...state, entries }), changed: true }
}

/** Fetched capacity is definitive pre-handoff state, never a failed start. */
export function deferLaunchForCapacity(
  state: TransferRegistryStore,
  token: LaunchToken,
  now: number,
): RegistryMutation {
  const entry = state.entries[token.id]
  if (
    !currentLaunch(entry, token) ||
    entry.request.mode !== 'fetched' ||
    entry.phase.tag !== 'ready'
  )
    return noChange(state)
  const observedAt = normalizeTime(now, entry.createdAt, token.since)
  return {
    state: replaceEntry(state, token.id, {
      ...entry,
      phase: {
        tag: 'fetched-capacity-wait',
        attempt: token.attempt,
        retryAt: saturatingDeadline(observedAt, FETCHED_CAPACITY_RETRY_MS),
        ...(entry.phase.priorDownloadId === undefined
          ? {}
          : { priorDownloadId: entry.phase.priorDownloadId }),
      },
    }),
    changed: true,
  }
}

/** Reopens a durable capacity wait as a fresh, still-pre-handoff launch token. */
export function beginCapacityLaunch(
  state: TransferRegistryStore,
  id: string,
  now: number,
): { readonly state: TransferRegistryStore; readonly launch?: LaunchToken } {
  const entry = state.entries[id]
  if (entry?.phase.tag === 'ready' && entry.request.mode === 'fetched') {
    if (!isRegistryTime(now)) throw new TypeError('invalid capacity launch time')
    return {
      state,
      launch: {
        id,
        attempt: entry.phase.attempt,
        since: entry.phase.since,
        ...(entry.phase.priorDownloadId === undefined
          ? {}
          : { priorDownloadId: entry.phase.priorDownloadId }),
      },
    }
  }
  if (
    entry?.phase.tag !== 'fetched-capacity-wait' ||
    entry.request.mode !== 'fetched' ||
    now < entry.phase.retryAt
  )
    return { state }
  const since = normalizeTime(now, entry.createdAt, entry.phase.retryAt)
  const launch = {
    id,
    attempt: entry.phase.attempt,
    since,
    ...(entry.phase.priorDownloadId === undefined
      ? {}
      : { priorDownloadId: entry.phase.priorDownloadId }),
  }
  return {
    state: replaceEntry(state, id, {
      ...entry,
      phase: {
        tag: 'ready',
        attempt: launch.attempt,
        since,
        ...(entry.phase.priorDownloadId === undefined
          ? {}
          : { priorDownloadId: entry.phase.priorDownloadId }),
      },
    }),
    launch,
  }
}

/** Persist the exact Fetched lease before its source may be opened. */
export function armFetchedCall(
  state: TransferRegistryStore,
  token: LaunchToken,
  leaseId: string,
  armedAt: number,
): RegistryMutation {
  const entry = state.entries[token.id]
  if (!isSafeId(leaseId)) throw new TypeError('invalid fetched leaseId')
  if (
    !currentLaunch(entry, token) ||
    entry.request.mode !== 'fetched' ||
    entry.phase.tag !== 'ready'
  )
    return noChange(state)
  if (
    Object.entries(state.entries).some(
      ([id, candidate]) =>
        id !== token.id &&
        candidate.phase.tag === 'fetched-call-armed' &&
        candidate.phase.leaseId === leaseId,
    )
  )
    throw new Error(`duplicate fetched leaseId: ${leaseId}`)
  const at = normalizeTime(armedAt, entry.createdAt, entry.phase.since)
  return {
    state: replaceEntry(state, token.id, {
      ...entry,
      phase: {
        tag: 'fetched-call-armed',
        attempt: entry.phase.attempt,
        since: entry.phase.since,
        armedAt: at,
        leaseId,
        ...(entry.phase.priorDownloadId === undefined
          ? {}
          : { priorDownloadId: entry.phase.priorDownloadId }),
      },
    }),
    changed: true,
  }
}

/** Persist the point after which a Direct browser call may have started. */
export function armDirectCall(
  state: TransferRegistryStore,
  token: LaunchToken,
  armedAt: number,
): RegistryMutation {
  const entry = state.entries[token.id]
  if (!currentLaunch(entry, token) || entry.phase.tag !== 'direct-ready') return noChange(state)
  normalizeTime(armedAt, entry.createdAt, entry.phase.since)
  return {
    state: replaceEntry(state, token.id, {
      ...entry,
      phase: { tag: 'launching', attempt: entry.phase.attempt, since: entry.phase.since },
    }),
    changed: true,
  }
}

/** Persist the point after which an addUri call may have reached aria2. */
export function armAria2Call(
  state: TransferRegistryStore,
  token: LaunchToken,
  armedAt: number,
): RegistryMutation {
  const entry = state.entries[token.id]
  if (
    !currentLaunch(entry, token) ||
    (entry.phase.tag !== 'aria2-ready' && entry.phase.tag !== 'aria2-launching')
  )
    return noChange(state)
  const at = normalizeTime(armedAt, entry.createdAt, entry.phase.since)
  return {
    state: replaceEntry(state, token.id, {
      ...entry,
      phase: {
        tag: 'aria2-call-armed',
        attempt: entry.phase.attempt,
        since: entry.phase.since,
        armedAt: at,
        profileId: entry.phase.profileId,
        gid: entry.phase.gid,
      },
    }),
    changed: true,
  }
}

/** A bound addUri receipt moves an armed call into active monitoring. */
export function bindStarted(
  state: TransferRegistryStore,
  token: LaunchToken,
  handle: DownloadHandle,
  now: number,
): RegistryMutation {
  const entry = state.entries[token.id]
  if (currentAria2Call(entry, token) && entry.phase.tag === 'aria2-call-armed') {
    const at = normalizeTime(now, entry.createdAt, entry.phase.armedAt)
    if (
      handle.kind !== 'aria2' ||
      !isAria2Gid(handle.gid) ||
      handle.gid !== entry.phase.gid ||
      token.gid !== entry.phase.gid
    )
      throw new TypeError('aria2 request requires reserved gid')
    return {
      state: replaceEntry(state, token.id, {
        ...entry,
        phase: {
          tag: 'aria2-active',
          gid: entry.phase.gid,
          profileId: entry.phase.profileId,
          startedAt: at,
        },
      }),
      changed: true,
    }
  }
  if (currentFetchedCall(entry, token)) {
    const at = normalizeTime(now, entry.createdAt, entry.phase.armedAt)
    if (handle.kind !== 'browser' || !isDownloadId(handle.id))
      throw new TypeError('fetched request requires browser handle')
    if (handle.id === entry.phase.priorDownloadId)
      throw new Error('browser retry reused prior downloadId')
    if (browserIdTaken(state, handle.id, token.id))
      throw new Error(`duplicate browser downloadId: ${handle.id}`)
    return {
      state: replaceEntry(state, token.id, {
        ...entry,
        phase: {
          tag: 'active',
          downloadId: handle.id,
          attempt: token.attempt,
          startedAt: at,
          nextProbeAt: at,
        },
      }),
      changed: true,
    }
  }
  if (!currentLaunch(entry, token)) return noChange(state)
  if (
    entry.phase.tag === 'direct-ready' ||
    entry.phase.tag === 'ready' ||
    entry.phase.tag === 'fetched-call-armed' ||
    entry.phase.tag === 'aria2-ready'
  )
    return noChange(state)
  const at = normalizeTime(now, entry.createdAt, token.since)
  if (handle.kind !== 'browser' || !isDownloadId(handle.id))
    throw new TypeError('browser request requires browser handle')
  if (entry.phase.tag === 'retry-launching' && handle.id === entry.phase.priorDownloadId)
    throw new Error('browser retry reused prior downloadId')
  if (browserIdTaken(state, handle.id, token.id))
    throw new Error(`duplicate browser downloadId: ${handle.id}`)
  return {
    state: replaceEntry(state, token.id, {
      ...entry,
      phase: {
        tag: 'active',
        downloadId: handle.id,
        attempt: token.attempt,
        startedAt: at,
        nextProbeAt: at,
      },
    }),
    changed: true,
  }
}
function browserIdTaken(state: TransferRegistryStore, downloadId: number, except: string): boolean {
  if (Object.values(state.legacy).some((entry) => entry.downloadId === downloadId)) return true
  return Object.entries(state.entries).some(
    ([id, entry]) =>
      id !== except &&
      ((entry.phase.tag === 'active' && entry.phase.downloadId === downloadId) ||
        ((entry.phase.tag === 'retry-wait' ||
          entry.phase.tag === 'retry-launching' ||
          entry.phase.tag === 'ready' ||
          entry.phase.tag === 'fetched-capacity-wait' ||
          entry.phase.tag === 'fetched-call-armed') &&
          entry.phase.priorDownloadId === downloadId) ||
        (entry.phase.tag === 'browser-unresolved' && entry.phase.downloadId === downloadId) ||
        (entry.phase.tag === 'terminal-pending' &&
          entry.phase.evidence.tag === 'browser' &&
          entry.phase.evidence.downloadId === downloadId)),
  )
}
export function rejectStart(
  state: TransferRegistryStore,
  token: LaunchToken,
  now: number,
): RegistryMutation {
  const entry = state.entries[token.id]
  if (!currentLaunch(entry, token) || token.priorDownloadId !== undefined) return noChange(state)
  const at = normalizeTime(now, entry.createdAt, token.since)
  return {
    state: pruneProfiles(
      replaceEntry(state, token.id, terminal(entry, { tag: 'start-failed' }, at)),
    ),
    changed: true,
  }
}

function unresolvedAria2Call(
  state: TransferRegistryStore,
  token: LaunchToken,
  now: number,
  reason: 'call-ambiguous' | 'confirmed-unbound',
): RegistryMutation {
  const entry = state.entries[token.id]
  if (!currentAria2Call(entry, token) || entry.phase.tag !== 'aria2-call-armed')
    return noChange(state)
  const since = normalizeTime(now, entry.createdAt, entry.phase.armedAt)
  return {
    state: replaceEntry(state, token.id, {
      ...entry,
      phase: {
        tag: 'aria2-unresolved',
        since,
        reason,
        profileId: entry.phase.profileId,
        gid: entry.phase.gid,
      },
    }),
    changed: true,
  }
}

/** The armed RPC result is unknown. Never re-add or terminalize it. */
export const markAria2CallAmbiguous = (
  state: TransferRegistryStore,
  token: LaunchToken,
  now: number,
): RegistryMutation => unresolvedAria2Call(state, token, now, 'call-ambiguous')

/** aria2 accepted the reserved GID, but its durable bind could not finish. */
export const markAria2ConfirmedUnbound = (
  state: TransferRegistryStore,
  token: LaunchToken,
  now: number,
): RegistryMutation => unresolvedAria2Call(state, token, now, 'confirmed-unbound')

/** The adapter proved its armed aria2 call never reached the RPC boundary. */
export function failAria2CallDefinitely(
  state: TransferRegistryStore,
  token: LaunchToken,
  now: number,
): RegistryMutation {
  const entry = state.entries[token.id]
  if (!currentAria2Call(entry, token) || entry.phase.tag !== 'aria2-call-armed')
    return noChange(state)
  const at = normalizeTime(now, entry.createdAt, entry.phase.armedAt)
  return {
    state: pruneProfiles(
      replaceEntry(state, token.id, terminal(entry, { tag: 'start-failed' }, at)),
    ),
    changed: true,
  }
}

export function resolveUntrackedStart(
  state: TransferRegistryStore,
  token: LaunchToken,
  now: number,
  handle?: DownloadHandle,
): RegistryMutation {
  const entry = state.entries[token.id]
  if (!currentLaunch(entry, token)) return noChange(state)
  const since = normalizeTime(now, entry.createdAt, token.since)
  if (entry.phase.tag === 'aria2-launching') return noChange(state)
  if (handle !== undefined && (handle.kind !== 'browser' || !isDownloadId(handle.id)))
    throw new TypeError('invalid browser handle')
  if (
    handle?.kind === 'browser' &&
    ((token.priorDownloadId !== undefined && handle.id === token.priorDownloadId) ||
      browserIdTaken(state, handle.id, token.id))
  )
    throw new Error('duplicate browser downloadId')
  return {
    state: replaceEntry(state, token.id, {
      ...entry,
      phase:
        handle === undefined
          ? {
              tag: 'unresolved-launch' as const,
              attempt: token.attempt,
              since,
              reason: 'handle-bind-failed' as const,
            }
          : {
              tag: 'browser-unresolved' as const,
              attempt: token.attempt,
              since,
              reason: 'handle-bind-failed' as const,
              downloadId: handle.id,
              nextProbeAt: since,
            },
    }),
    changed: true,
  }
}

export function scheduleInterruptedRetry(
  state: TransferRegistryStore,
  input: {
    readonly id: string
    readonly downloadId: number
    readonly retryAt: number
  },
): RegistryMutation {
  const entry = state.entries[input.id]
  if (entry?.phase.tag !== 'active' || entry.phase.downloadId !== input.downloadId)
    return noChange(state)
  const attempt = entry.phase.attempt + 1
  if (attempt > MAX_TRANSFER_ATTEMPTS) return noChange(state)
  const retryAt = normalizeTime(input.retryAt, entry.createdAt, entry.phase.startedAt)
  return {
    state: replaceEntry(state, input.id, {
      ...entry,
      phase: {
        tag: 'retry-wait',
        attempt,
        retryAt,
        priorDownloadId: input.downloadId,
      },
    }),
    changed: true,
  }
}
export function beginRetryLaunch(
  state: TransferRegistryStore,
  id: string,
  now: number,
): { readonly state: TransferRegistryStore; readonly launch?: LaunchToken } {
  const entry = state.entries[id]
  if (entry?.phase.tag !== 'retry-wait') return { state }
  if (!isRegistryTime(now)) throw new TypeError('invalid retry launch time')
  if (now < entry.phase.retryAt) return { state }
  const since = normalizeTime(now, entry.createdAt, entry.phase.retryAt),
    launch = {
      id,
      attempt: entry.phase.attempt,
      since,
      priorDownloadId: entry.phase.priorDownloadId,
    }
  return {
    state: replaceEntry(state, id, {
      ...entry,
      phase:
        entry.request.mode === 'fetched'
          ? {
              tag: 'ready' as const,
              attempt: launch.attempt,
              since,
              priorDownloadId: entry.phase.priorDownloadId,
            }
          : {
              tag: 'retry-launching' as const,
              attempt: launch.attempt,
              since,
              priorDownloadId: entry.phase.priorDownloadId,
            },
    }),
    launch,
  }
}

/** Claim one due retry URL refresh. Its token fences a late content-script reply. */
export function claimRetryRefresh(
  state: TransferRegistryStore,
  id: string,
  now: number,
): { readonly state: TransferRegistryStore; readonly token?: RetryRefreshToken } {
  const entry = state.entries[id]
  if (entry?.phase.tag !== 'retry-wait') return { state }
  if (!isRegistryTime(now)) throw new TypeError('invalid retry refresh time')
  if (now < entry.phase.retryAt) return { state }
  const since = normalizeTime(now, entry.createdAt, entry.phase.retryAt)
  const token: RetryRefreshToken = {
    id,
    projectionId: entry.request.projectionId,
    createdAt: entry.createdAt,
    attempt: entry.phase.attempt,
    since,
    priorDownloadId: entry.phase.priorDownloadId,
  }
  return {
    state: replaceEntry(state, id, {
      ...entry,
      phase: {
        tag: 'retry-refreshing',
        attempt: token.attempt,
        since,
        priorDownloadId: token.priorDownloadId,
      },
    }),
    token,
  }
}

/** Persist the refreshed URL, then make the exact retry launchable. */
export function completeRetryRefresh(
  state: TransferRegistryStore,
  token: RetryRefreshToken,
  url: string,
  now: number,
): { readonly state: TransferRegistryStore; readonly launch?: LaunchToken } {
  if (!isTransferUrl(url)) throw new TypeError('invalid retry URL')
  const entry = state.entries[token.id]
  if (!currentRetryRefresh(entry, token)) return { state }
  const since = normalizeTime(now, entry.createdAt, entry.phase.since)
  const launch: LaunchToken = {
    id: token.id,
    attempt: token.attempt,
    since,
    priorDownloadId: token.priorDownloadId,
  }
  return {
    state: replaceEntry(state, token.id, {
      ...entry,
      request: { ...entry.request, url },
      phase:
        entry.request.mode === 'fetched'
          ? {
              tag: 'ready' as const,
              attempt: token.attempt,
              since,
              priorDownloadId: token.priorDownloadId,
            }
          : {
              tag: 'retry-launching' as const,
              attempt: token.attempt,
              since,
              priorDownloadId: token.priorDownloadId,
            },
    }),
    launch,
  }
}

/** A failed refresh is a definite failed retry preparation; retain the prior receipt. */
export function failRetryRefresh(
  state: TransferRegistryStore,
  token: RetryRefreshToken,
  now: number,
): RegistryMutation {
  const entry = state.entries[token.id]
  if (!currentRetryRefresh(entry, token)) return noChange(state)
  return {
    state: replaceEntry(
      state,
      token.id,
      terminal(
        entry,
        { tag: 'browser', downloadId: token.priorDownloadId, state: 'interrupted' },
        normalizeTime(now, entry.createdAt, entry.phase.since),
      ),
    ),
    changed: true,
  }
}
export function persistRetryUrl(
  state: TransferRegistryStore,
  id: string,
  url: string,
): RegistryMutation {
  if (!isTransferUrl(url)) throw new TypeError('invalid retry URL')
  const entry = state.entries[id]
  if (entry?.phase.tag !== 'retry-wait' || entry.request.url === url) return noChange(state)
  return {
    state: replaceEntry(state, id, {
      ...entry,
      request: { ...entry.request, url },
    }),
    changed: true,
  }
}
export function failRetryWait(
  state: TransferRegistryStore,
  id: string,
  now: number,
): RegistryMutation {
  const entry = state.entries[id]
  if (entry?.phase.tag !== 'retry-wait') return noChange(state)
  return {
    state: replaceEntry(
      state,
      id,
      terminal(
        entry,
        {
          tag: 'browser',
          downloadId: entry.phase.priorDownloadId,
          state: 'interrupted',
        },
        normalizeTime(now, entry.createdAt, entry.phase.retryAt),
      ),
    ),
    changed: true,
  }
}

/** A retry was definitely not handed to the browser; preserve the prior handle's failure. */
export function failRetryStart(
  state: TransferRegistryStore,
  token: LaunchToken,
  now: number,
): RegistryMutation {
  const entry = state.entries[token.id]
  if (!currentLaunch(entry, token) || token.priorDownloadId === undefined) return noChange(state)
  return {
    state: replaceEntry(
      state,
      token.id,
      terminal(
        entry,
        {
          tag: 'browser',
          downloadId: token.priorDownloadId,
          state: 'interrupted',
        },
        normalizeTime(now, entry.createdAt, token.since),
      ),
    ),
    changed: true,
  }
}

/** A definite browser launch failure consumes one bounded retry attempt. */
export function rescheduleRetryLaunchFailure(
  state: TransferRegistryStore,
  token: LaunchToken,
  now: number,
): RegistryMutation {
  const entry = state.entries[token.id]
  if (!currentLaunch(entry, token) || token.priorDownloadId === undefined) return noChange(state)
  const observedAt = normalizeTime(now, entry.createdAt, token.since)
  const attempt = token.attempt + 1
  if (attempt > MAX_TRANSFER_ATTEMPTS)
    return {
      state: replaceEntry(
        state,
        token.id,
        terminal(
          entry,
          {
            tag: 'browser',
            downloadId: token.priorDownloadId,
            state: 'interrupted',
          },
          observedAt,
        ),
      ),
      changed: true,
    }
  return {
    state: replaceEntry(state, token.id, {
      ...entry,
      phase: {
        tag: 'retry-wait',
        attempt,
        retryAt: saturatingDeadline(observedAt, interruptBackoffMs(token.attempt)),
        priorDownloadId: token.priorDownloadId,
      },
    }),
    changed: true,
  }
}
export function recordBrowserTerminal(
  state: TransferRegistryStore,
  input: {
    readonly id: string
    readonly downloadId: number
    readonly state: 'complete' | 'interrupted'
    readonly observedAt: number
    readonly bytesReceived?: number
    readonly totalBytes?: number
  },
): RegistryMutation {
  const entry = state.entries[input.id]
  if (
    entry === undefined ||
    !isDownloadId(input.downloadId) ||
    (input.state !== 'complete' && input.state !== 'interrupted') ||
    (input.bytesReceived !== undefined && !isDownloadId(input.bytesReceived)) ||
    (input.totalBytes !== undefined && !isDownloadId(input.totalBytes))
  )
    return noChange(state)
  if (
    !(
      (entry.phase.tag === 'active' || entry.phase.tag === 'browser-unresolved') &&
      entry.phase.downloadId === input.downloadId
    )
  )
    return noChange(state)
  const floor = entry.phase.tag === 'active' ? entry.phase.startedAt : entry.phase.since
  const observedAt = normalizeTime(input.observedAt, entry.createdAt, floor)
  return {
    state: replaceEntry(
      state,
      input.id,
      terminal(
        entry,
        {
          tag: 'browser',
          downloadId: input.downloadId,
          state: input.state,
          ...(input.bytesReceived === undefined ? {} : { bytesReceived: input.bytesReceived }),
          ...(input.totalBytes === undefined ? {} : { totalBytes: input.totalBytes }),
        },
        observedAt,
      ),
    ),
    changed: true,
  }
}
export function enrichBrowserTerminal(
  state: TransferRegistryStore,
  input: {
    readonly id: string
    readonly createdAt: number
    readonly downloadId: number
    readonly state: 'complete' | 'interrupted'
    readonly observedAt: number
    readonly bytesReceived?: number
    readonly totalBytes?: number
  },
): RegistryMutation {
  const entry = state.entries[input.id]
  if (
    entry === undefined ||
    !isRegistryTime(input.createdAt) ||
    !isDownloadId(input.downloadId) ||
    (input.state !== 'complete' && input.state !== 'interrupted') ||
    !isRegistryTime(input.observedAt) ||
    (input.bytesReceived !== undefined && !isDownloadId(input.bytesReceived)) ||
    (input.totalBytes !== undefined && !isDownloadId(input.totalBytes)) ||
    (input.bytesReceived === undefined && input.totalBytes === undefined)
  )
    return noChange(state)
  const phase = entry.phase
  if (
    entry.createdAt !== input.createdAt ||
    phase.tag !== 'terminal-pending' ||
    phase.observedAt !== input.observedAt ||
    phase.evidence.tag !== 'browser' ||
    phase.evidence.downloadId !== input.downloadId ||
    phase.evidence.state !== input.state
  )
    return noChange(state)
  const evidence = phase.evidence
  if (
    (input.bytesReceived === undefined || input.bytesReceived === evidence.bytesReceived) &&
    (input.totalBytes === undefined || input.totalBytes === evidence.totalBytes)
  )
    return noChange(state)
  return {
    state: replaceEntry(state, input.id, {
      ...entry,
      phase: {
        ...phase,
        evidence: {
          ...evidence,
          ...(input.bytesReceived === undefined ? {} : { bytesReceived: input.bytesReceived }),
          ...(input.totalBytes === undefined ? {} : { totalBytes: input.totalBytes }),
        },
      },
    }),
    changed: true,
  }
}
export function deferProbe(
  state: TransferRegistryStore,
  input: {
    readonly id: string
    readonly downloadId: number
    readonly nextProbeAt: number
  },
): RegistryMutation {
  const entry = state.entries[input.id]
  if (entry?.phase.tag !== 'active' || entry.phase.downloadId !== input.downloadId)
    return noChange(state)
  const nextProbeAt = normalizeTime(
    input.nextProbeAt,
    entry.phase.startedAt,
    entry.phase.nextProbeAt,
  )
  return nextProbeAt === entry.phase.nextProbeAt
    ? noChange(state)
    : {
        state: replaceEntry(state, input.id, {
          ...entry,
          phase: { ...entry.phase, nextProbeAt },
        }),
        changed: true,
      }
}
export function quarantineActive(
  state: TransferRegistryStore,
  input: { readonly id: string; readonly downloadId: number },
): RegistryMutation {
  const entry = state.entries[input.id]
  if (entry?.phase.tag !== 'active' || entry.phase.downloadId !== input.downloadId)
    return noChange(state)
  return {
    state: replaceEntry(state, input.id, {
      ...entry,
      phase: {
        tag: 'browser-unresolved',
        attempt: entry.phase.attempt,
        since: entry.phase.startedAt,
        reason: 'worker-restart',
        downloadId: input.downloadId,
        nextProbeAt: entry.phase.nextProbeAt,
      },
    }),
    changed: true,
  }
}

/** Reattach only the exact browser handle that was durably quarantined. */
export function recordBrowserLive(
  state: TransferRegistryStore,
  input: {
    readonly id: string
    readonly downloadId: number
    readonly observedAt: number
  },
): RegistryMutation {
  const entry = state.entries[input.id]
  if (
    entry?.phase.tag !== 'browser-unresolved' ||
    entry.phase.downloadId !== input.downloadId ||
    !isDownloadId(input.downloadId)
  )
    return noChange(state)
  const observedAt = normalizeTime(input.observedAt, entry.createdAt, entry.phase.since)
  return {
    state: replaceEntry(state, input.id, {
      ...entry,
      phase: {
        tag: 'active',
        downloadId: input.downloadId,
        attempt: entry.phase.attempt,
        startedAt: observedAt,
        nextProbeAt: observedAt,
      },
    }),
    changed: true,
  }
}

/** Re-arm an exact unresolved browser handle after a harmless probe failure. */
export function deferUnresolvedBrowserProbe(
  state: TransferRegistryStore,
  input: {
    readonly id: string
    readonly downloadId: number
    readonly nextProbeAt: number
  },
): RegistryMutation {
  const entry = state.entries[input.id]
  if (entry?.phase.tag !== 'browser-unresolved' || entry.phase.downloadId !== input.downloadId)
    return noChange(state)
  const nextProbeAt = normalizeTime(input.nextProbeAt, entry.phase.since, entry.phase.nextProbeAt)
  return nextProbeAt === entry.phase.nextProbeAt
    ? noChange(state)
    : {
        state: replaceEntry(state, input.id, {
          ...entry,
          phase: { ...entry.phase, nextProbeAt },
        }),
        changed: true,
      }
}

export function recordAria2Progress(
  state: TransferRegistryStore,
  input: {
    readonly id: string
    readonly gid: string
    readonly profileId: string
    readonly status: Aria2LiveStatus
    readonly observedAt: number
    readonly completedLength?: string
    readonly totalLength?: string
  },
): RegistryMutation {
  const entry = state.entries[input.id]
  if (
    (entry?.phase.tag !== 'aria2-active' && entry?.phase.tag !== 'aria2-unresolved') ||
    entry.phase.gid !== input.gid ||
    entry.phase.profileId !== input.profileId
  )
    return noChange(state)
  const hasOneLength = input.completedLength !== undefined || input.totalLength !== undefined
  if (
    !isText(input.gid) ||
    !isSafeId(input.profileId) ||
    !isRegistryTime(input.observedAt) ||
    (input.status !== 'active' && input.status !== 'waiting' && input.status !== 'paused') ||
    (hasOneLength &&
      (!isCanonicalDecimal(input.completedLength) || !isCanonicalDecimal(input.totalLength)))
  )
    throw new TypeError('invalid aria2 progress')
  const progress = hasOneLength
    ? {
        completedLength: input.completedLength!,
        totalLength: input.totalLength!,
      }
    : entry.phase.tag === 'aria2-active'
      ? entry.phase.progress
      : undefined
  const phase =
    entry.phase.tag === 'aria2-active'
      ? {
          ...entry.phase,
          status: input.status,
          ...(progress === undefined ? {} : { progress }),
        }
      : {
          tag: 'aria2-active' as const,
          gid: entry.phase.gid!,
          profileId: entry.phase.profileId!,
          startedAt: normalizeTime(input.observedAt, entry.createdAt, entry.phase.since),
          status: input.status,
          ...(progress === undefined ? {} : { progress }),
        }
  return {
    state: replaceEntry(state, input.id, { ...entry, phase }),
    changed: true,
  }
}
export function recordAria2Terminal(
  state: TransferRegistryStore,
  input: {
    readonly id: string
    readonly gid: string
    readonly profileId: string
    readonly status: 'complete' | 'error' | 'removed'
    readonly completedLength: string
    readonly totalLength: string
    readonly observedAt: number
    readonly errorCode?: string
    readonly errorMessage?: string
  },
): RegistryMutation {
  const entry = state.entries[input.id]
  if (
    (entry?.phase.tag !== 'aria2-active' && entry?.phase.tag !== 'aria2-unresolved') ||
    entry.phase.gid !== input.gid ||
    entry.phase.profileId !== input.profileId
  )
    return noChange(state)
  if (
    (input.status !== 'complete' && input.status !== 'error' && input.status !== 'removed') ||
    !isCanonicalDecimal(input.completedLength) ||
    !isCanonicalDecimal(input.totalLength) ||
    !isRegistryTime(input.observedAt) ||
    (input.errorCode !== undefined && !isAria2ErrorCode(input.errorCode)) ||
    (input.errorMessage !== undefined && !isAria2ErrorMessage(input.errorMessage))
  )
    throw new TypeError('invalid aria2 terminal')
  const observedAt = normalizeTime(
    input.observedAt,
    entry.createdAt,
    entry.phase.tag === 'aria2-active' ? entry.phase.startedAt : entry.phase.since,
  )
  const evidence: TerminalEvidence = {
    tag: 'aria2',
    gid: input.gid,
    profileId: input.profileId,
    status: input.status,
    completedLength: input.completedLength,
    totalLength: input.totalLength,
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
    ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
  }
  return {
    state: replaceEntry(state, input.id, terminal(entry, evidence, observedAt)),
    changed: true,
  }
}
export function recordAria2ProfileProbeSuccess(
  state: TransferRegistryStore,
  profileId: string,
  nextProbeAt: number,
): RegistryMutation {
  const profile = state.profiles[profileId]
  if (profile === undefined) return noChange(state)
  if (!isRegistryTime(nextProbeAt)) throw new TypeError('invalid probe time')
  const at = nextProbeAt
  const next = { ...profile, failureCount: 0, nextProbeAt: at }
  return next.failureCount === profile.failureCount && next.nextProbeAt === profile.nextProbeAt
    ? noChange(state)
    : {
        state: { ...state, profiles: { ...state.profiles, [profileId]: next } },
        changed: true,
      }
}
/** Claim a profile probe without treating an unobserved RPC as a success. */
export function deferAria2ProfileProbe(
  state: TransferRegistryStore,
  profileId: string,
  nextProbeAt: number,
): RegistryMutation {
  const profile = state.profiles[profileId]
  if (profile === undefined) return noChange(state)
  if (!isRegistryTime(nextProbeAt)) throw new TypeError('invalid probe time')
  const at = normalizeTime(nextProbeAt, profile.nextProbeAt)
  return at === profile.nextProbeAt
    ? noChange(state)
    : {
        state: {
          ...state,
          profiles: {
            ...state.profiles,
            [profileId]: { ...profile, nextProbeAt: at },
          },
        },
        changed: true,
      }
}
export function recordAria2ProfileUnavailable(
  state: TransferRegistryStore,
  profileId: string,
  now: number,
): RegistryMutation {
  const profile = state.profiles[profileId]
  if (profile === undefined) return noChange(state)
  const failureCount = Math.min(MAX_ARIA2_PROFILE_FAILURES, profile.failureCount + 1)
  const delay = Math.min(
    ARIA2_PROFILE_BACKOFF_MAX_MS,
    ARIA2_PROFILE_BACKOFF_BASE_MS * 2 ** (failureCount - 1),
  )
  const nextProbeAt = normalizeTime(saturatingDeadline(now, delay), profile.nextProbeAt)
  return {
    state: {
      ...state,
      profiles: {
        ...state.profiles,
        [profileId]: { ...profile, failureCount, nextProbeAt },
      },
    },
    changed: true,
  }
}
export function deferTerminalProjection(
  state: TransferRegistryStore,
  id: string,
  projectAt: number,
): RegistryMutation {
  const entry = state.entries[id]
  if (entry?.phase.tag !== 'terminal-pending') return noChange(state)
  const nextProjectAt = normalizeTime(projectAt, entry.phase.observedAt, entry.phase.projectAt)
  return nextProjectAt === entry.phase.projectAt
    ? noChange(state)
    : {
        state: replaceEntry(state, id, {
          ...entry,
          phase: { ...entry.phase, projectAt: nextProjectAt },
        }),
        changed: true,
      }
}
function pruneProfiles(state: TransferRegistryStore): TransferRegistryStore {
  const referenced = new Set<string>()
  for (const entry of Object.values(state.entries)) {
    const claim = aria2ClaimFrom(entry.phase)
    if (claim !== undefined) referenced.add(claim.profileId)
  }
  const profiles = Object.fromEntries(
    Object.entries(state.profiles).filter(([id]) => referenced.has(id)),
  )
  return Object.keys(profiles).length === Object.keys(state.profiles).length
    ? state
    : { ...state, profiles }
}
export function ackTerminal(state: TransferRegistryStore, id: string): RegistryMutation {
  if (state.entries[id]?.phase.tag !== 'terminal-pending') return noChange(state)
  const { [id]: _, ...entries } = state.entries
  return { state: pruneProfiles({ ...state, entries }), changed: true }
}

/**
 * The only rows a person may dismiss. Prepared rows definitely made no call.
 * Unresolved rows may still run outside this extension.
 */
export type TransferRecoveryKind =
  | 'prepared-launch'
  | 'unresolved-launch'
  | 'browser-unresolved'
  | 'aria2-unresolved'
  | 'legacy-unresolved'
  | 'forget-pending'

/** Safe UI view. Do not expose request URLs, filenames, GIDs, or RPC profiles. */
export interface TransferRecoveryItem {
  readonly id: string
  readonly kind: TransferRecoveryKind
  readonly mode: TransferMode | 'legacy'
  readonly createdAt: number
  readonly downloadId?: number
}

export const listTransferRecovery = (
  state: TransferRegistryStore,
): readonly TransferRecoveryItem[] =>
  [
    ...Object.values(state.entries).flatMap((entry): readonly TransferRecoveryItem[] => {
      const phase = entry.phase
      if (
        entry.request.sweepReceipt === undefined &&
        (phase.tag === 'direct-prepared' ||
          phase.tag === 'fetched-prepared' ||
          phase.tag === 'aria2-prepared')
      )
        return [
          {
            id: entry.request.id,
            kind: 'prepared-launch',
            mode: entry.request.mode,
            createdAt: entry.createdAt,
          },
        ]
      if (phase.tag === 'unresolved-launch')
        return [
          {
            id: entry.request.id,
            kind: phase.tag,
            mode: entry.request.mode,
            createdAt: entry.createdAt,
          },
        ]
      if (phase.tag === 'browser-unresolved')
        return [
          {
            id: entry.request.id,
            kind: phase.tag,
            mode: entry.request.mode,
            createdAt: entry.createdAt,
            downloadId: phase.downloadId,
          },
        ]
      if (phase.tag === 'aria2-unresolved')
        return [
          {
            id: entry.request.id,
            kind: phase.tag,
            mode: entry.request.mode,
            createdAt: entry.createdAt,
          },
        ]
      if (phase.tag === 'forget-pending')
        return [
          {
            id: entry.request.id,
            kind: phase.tag,
            mode: entry.request.mode,
            createdAt: entry.createdAt,
          },
        ]
      return []
    }),
    ...Object.entries(state.legacy).flatMap(([id, entry]): readonly TransferRecoveryItem[] =>
      entry.phase.tag === 'unresolved' || entry.phase.tag === 'forget-pending'
        ? [
            {
              id,
              kind: entry.phase.tag === 'forget-pending' ? entry.phase.tag : 'legacy-unresolved',
              mode: 'legacy',
              createdAt: entry.startedAt,
              ...(entry.phase.tag === 'forget-pending' ? {} : { downloadId: entry.downloadId }),
            },
          ]
        : [],
    ),
  ].toSorted((left, right) => left.id.localeCompare(right.id))

const recoveryPhase = (entry: TransferEntry): TransferRecoveryPhase | undefined => {
  const { phase } = entry
  if (
    (phase.tag === 'direct-prepared' ||
      phase.tag === 'fetched-prepared' ||
      phase.tag === 'aria2-prepared') &&
    entry.request.sweepReceipt === undefined
  )
    return phase
  return phase.tag === 'unresolved-launch' ||
    phase.tag === 'browser-unresolved' ||
    phase.tag === 'aria2-unresolved'
    ? phase
    : undefined
}

/** Commit a user dismissal request before a dependent Clear failure write. */
export function beginForgetRecovery(
  state: TransferRegistryStore,
  id: string,
  now: number,
): { readonly state: TransferRegistryStore; readonly token?: ForgetTransferToken } {
  const entry = state.entries[id]
  const recovery = entry === undefined ? undefined : recoveryPhase(entry)
  if (entry === undefined || recovery === undefined) return { state }
  const since = normalizeTime(now, entry.createdAt, recovery.since)
  const token: ForgetTransferToken = {
    id,
    projectionId: entry.request.projectionId,
    createdAt: entry.createdAt,
    since,
  }
  return {
    state: replaceEntry(state, id, {
      ...entry,
      phase: { tag: 'forget-pending', since, recovery },
    }),
    token,
  }
}

/** Lists durable forget commands to re-drive after a worker restart. */
export const listPendingForgetRecovery = (
  state: TransferRegistryStore,
): readonly ForgetTransferToken[] =>
  Object.values(state.entries)
    .flatMap((entry): readonly ForgetTransferToken[] =>
      entry.phase.tag === 'forget-pending'
        ? [
            {
              id: entry.request.id,
              projectionId: entry.request.projectionId,
              createdAt: entry.createdAt,
              since: entry.phase.since,
            },
          ]
        : [],
    )
    .toSorted((left, right) => left.id.localeCompare(right.id))

/** Delete only the row fenced by the durable forget command. */
export function completeForgetRecovery(
  state: TransferRegistryStore,
  token: ForgetTransferToken,
): RegistryMutation {
  if (!currentForget(state.entries[token.id], token)) return noChange(state)
  const { [token.id]: _removed, ...entries } = state.entries
  return { state: pruneProfiles({ ...state, entries }), changed: true }
}

/** Commit a legacy dismissal before its dependent Clear failure write. */
export function beginLegacyForgetRecovery(
  state: TransferRegistryStore,
  id: string,
  now: number,
): {
  readonly state: TransferRegistryStore
  readonly token?: LegacyForgetTransferToken
} {
  const entry = state.legacy[id]
  if (entry?.phase.tag !== 'unresolved') return { state }
  const since = normalizeTime(now, entry.startedAt)
  const token: LegacyForgetTransferToken = {
    id,
    downloadId: entry.downloadId,
    startedAt: entry.startedAt,
    since,
  }
  return {
    state: {
      ...state,
      legacy: {
        ...state.legacy,
        [id]: { ...entry, phase: { tag: 'forget-pending', since } },
      },
    },
    token,
  }
}

/** Lists legacy dismissals that must re-drive after a worker restart. */
export const listPendingLegacyForgetRecovery = (
  state: TransferRegistryStore,
): readonly LegacyForgetTransferToken[] =>
  Object.entries(state.legacy)
    .flatMap(([id, entry]): readonly LegacyForgetTransferToken[] =>
      entry.phase.tag === 'forget-pending'
        ? [
            {
              id,
              downloadId: entry.downloadId,
              startedAt: entry.startedAt,
              since: entry.phase.since,
            },
          ]
        : [],
    )
    .toSorted((left, right) => left.id.localeCompare(right.id))

/** Delete only the legacy row fenced by its durable dismissal. */
export function completeLegacyForgetRecovery(
  state: TransferRegistryStore,
  token: LegacyForgetTransferToken,
): RegistryMutation {
  if (!currentLegacyForget(state.legacy[token.id], token)) return noChange(state)
  const { [token.id]: _removed, ...legacy } = state.legacy
  return { state: { ...state, legacy }, changed: true }
}

/** Forgetting unlocks a later, explicit user Save. It never starts or settles anything. */
export function forgetTransferRecovery(state: TransferRegistryStore, id: string): RegistryMutation {
  const entry = state.entries[id]
  if (
    entry !== undefined &&
    (entry.phase.tag === 'unresolved-launch' ||
      entry.phase.tag === 'browser-unresolved' ||
      entry.phase.tag === 'aria2-unresolved')
  ) {
    const { [id]: _removed, ...entries } = state.entries
    return { state: pruneProfiles({ ...state, entries }), changed: true }
  }
  if (state.legacy[id]?.phase.tag === 'unresolved') {
    const { [id]: _removed, ...legacy } = state.legacy
    return { state: { ...state, legacy }, changed: true }
  }
  return noChange(state)
}
export const isRecoverableTransfer = (state: TransferRegistryStore, id: string): boolean =>
  forgetTransferRecovery(state, id).changed

const phaseHasClockRollback = (phase: TransferEntry['phase'], now: number): boolean => {
  switch (phase.tag) {
    case 'launching':
    case 'direct-prepared':
    case 'direct-ready':
    case 'fetched-prepared':
    case 'ready':
    case 'retry-refreshing':
    case 'retry-launching':
    case 'unresolved-launch':
    case 'aria2-launching':
    case 'aria2-prepared':
    case 'aria2-ready':
    case 'aria2-unresolved':
      return timeAfterBootHorizon(phase.since, now)
    case 'fetched-capacity-wait':
    case 'retry-wait':
      return timeAfterBootHorizon(phase.retryAt, now)
    case 'fetched-call-armed':
    case 'aria2-call-armed':
      return timeAfterBootHorizon(phase.since, now) || timeAfterBootHorizon(phase.armedAt, now)
    case 'active':
      return (
        timeAfterBootHorizon(phase.startedAt, now) || timeAfterBootHorizon(phase.nextProbeAt, now)
      )
    case 'browser-unresolved':
      return timeAfterBootHorizon(phase.since, now) || timeAfterBootHorizon(phase.nextProbeAt, now)
    case 'aria2-active':
      return timeAfterBootHorizon(phase.startedAt, now)
    case 'forget-pending':
      return timeAfterBootHorizon(phase.since, now) || phaseHasClockRollback(phase.recovery, now)
    case 'terminal-pending':
      return (
        timeAfterBootHorizon(phase.observedAt, now) || timeAfterBootHorizon(phase.projectAt, now)
      )
  }
}

const rebaseRecoveryPhaseOnBoot = (
  phase: TransferRecoveryPhase,
  now: number,
): TransferRecoveryPhase => {
  switch (phase.tag) {
    case 'direct-prepared':
    case 'fetched-prepared':
    case 'unresolved-launch':
    case 'aria2-unresolved':
      return { ...phase, since: rebaseTimeAtBoot(phase.since, now) }
    case 'aria2-prepared':
      return { ...phase, since: rebaseTimeAtBoot(phase.since, now) }
    case 'browser-unresolved':
      return {
        ...phase,
        since: rebaseTimeAtBoot(phase.since, now),
        nextProbeAt: now,
      }
  }
}

const rebasePhaseOnBoot = (phase: TransferEntry['phase'], now: number): TransferEntry['phase'] => {
  switch (phase.tag) {
    case 'launching':
    case 'direct-prepared':
    case 'direct-ready':
    case 'fetched-prepared':
    case 'ready':
    case 'retry-refreshing':
    case 'retry-launching':
    case 'unresolved-launch':
    case 'aria2-launching':
    case 'aria2-prepared':
    case 'aria2-ready':
    case 'aria2-unresolved':
      return { ...phase, since: rebaseTimeAtBoot(phase.since, now) }
    case 'fetched-capacity-wait':
      return { ...phase, retryAt: saturatingDeadline(now, FETCHED_CAPACITY_RETRY_MS) }
    case 'retry-wait':
      return {
        ...phase,
        retryAt: saturatingDeadline(now, interruptBackoffMs(phase.attempt - 1)),
      }
    case 'fetched-call-armed':
    case 'aria2-call-armed':
      return {
        ...phase,
        since: rebaseTimeAtBoot(phase.since, now),
        armedAt: rebaseTimeAtBoot(phase.armedAt, now),
      }
    case 'active':
      return {
        ...phase,
        startedAt: rebaseTimeAtBoot(phase.startedAt, now),
        nextProbeAt: now,
      }
    case 'browser-unresolved':
      return {
        ...phase,
        since: rebaseTimeAtBoot(phase.since, now),
        nextProbeAt: now,
      }
    case 'aria2-active':
      return { ...phase, startedAt: rebaseTimeAtBoot(phase.startedAt, now) }
    case 'forget-pending':
      return {
        ...phase,
        since: now,
        recovery: rebaseRecoveryPhaseOnBoot(phase.recovery, now),
      }
    case 'terminal-pending':
      return {
        ...phase,
        observedAt: rebaseTimeAtBoot(phase.observedAt, now),
        projectAt: now,
      }
  }
}

/**
 * A service-worker boot has no monotonic clock continuity. If persisted times
 * prove a large wall-clock rollback, persist bounded phase-safe deadlines
 * before the work planner sees them. This never reopens an armed handoff.
 */
export function rebaseClockRollbackOnBoot(
  state: TransferRegistryStore,
  now: number,
): RegistryMutation {
  if (!isRegistryTime(now)) throw new TypeError('invalid boot time')
  const rollback =
    Object.values(state.entries).some(
      (entry) =>
        timeAfterBootHorizon(entry.createdAt, now) || phaseHasClockRollback(entry.phase, now),
    ) ||
    Object.values(state.profiles).some((profile) =>
      timeAfterBootHorizon(profile.nextProbeAt, now),
    ) ||
    Object.values(state.legacy).some(
      (entry) =>
        timeAfterBootHorizon(entry.startedAt, now) ||
        (entry.phase.tag === 'active' && timeAfterBootHorizon(entry.phase.nextProbeAt, now)) ||
        (entry.phase.tag === 'terminal-pending' &&
          (timeAfterBootHorizon(entry.phase.at, now) ||
            timeAfterBootHorizon(entry.phase.projectAt, now))) ||
        (entry.phase.tag === 'forget-pending' && timeAfterBootHorizon(entry.phase.since, now)),
    )
  if (!rollback) return noChange(state)

  const entries = Object.fromEntries(
    Object.entries(state.entries).map(([id, entry]) => [
      id,
      {
        ...entry,
        createdAt: rebaseTimeAtBoot(entry.createdAt, now),
        phase: rebasePhaseOnBoot(entry.phase, now),
      },
    ]),
  )
  const profiles = Object.fromEntries(
    Object.entries(state.profiles).map(([id, profile]) => [id, { ...profile, nextProbeAt: now }]),
  )
  const legacy = Object.fromEntries(
    Object.entries(state.legacy).map(([id, entry]) => [
      id,
      {
        ...entry,
        startedAt: rebaseTimeAtBoot(entry.startedAt, now),
        phase:
          entry.phase.tag === 'active'
            ? { ...entry.phase, nextProbeAt: now }
            : entry.phase.tag === 'terminal-pending'
              ? { ...entry.phase, at: rebaseTimeAtBoot(entry.phase.at, now), projectAt: now }
              : entry.phase.tag === 'forget-pending'
                ? { ...entry.phase, since: now }
                : entry.phase,
      },
    ]),
  )
  return { state: { ...state, entries, profiles, legacy }, changed: true }
}

/** A reboot reopens safe refresh work, terminalizes unarmed aria2 intent, and quarantines calls. */
export function quarantineLaunchingOnBoot(
  state: TransferRegistryStore,
  now: number,
): RegistryMutation {
  if (!isRegistryTime(now)) throw new TypeError('invalid boot time')
  let entries: Record<string, TransferEntry> | undefined
  for (const [id, entry] of Object.entries(state.entries)) {
    if (
      entry.phase.tag !== 'launching' &&
      entry.phase.tag !== 'retry-refreshing' &&
      entry.phase.tag !== 'retry-launching' &&
      entry.phase.tag !== 'fetched-call-armed' &&
      entry.phase.tag !== 'aria2-launching' &&
      entry.phase.tag !== 'aria2-call-armed'
    )
      continue
    entries ??= { ...state.entries }
    if (entry.phase.tag === 'retry-refreshing') {
      entries[id] = {
        ...entry,
        phase: {
          tag: 'retry-wait',
          attempt: entry.phase.attempt,
          retryAt: normalizeTime(now, entry.createdAt, entry.phase.since),
          priorDownloadId: entry.phase.priorDownloadId,
        },
      }
    } else if (entry.phase.tag === 'aria2-launching') {
      entries[id] = terminal(
        entry,
        { tag: 'start-failed' },
        normalizeTime(now, entry.createdAt, entry.phase.since),
      )
    } else
      entries[id] =
        entry.phase.tag === 'aria2-call-armed'
          ? {
              ...entry,
              phase: {
                tag: 'aria2-unresolved',
                since: entry.phase.armedAt,
                reason: 'call-ambiguous',
                profileId: entry.phase.profileId,
                gid: entry.phase.gid,
              },
            }
          : {
              ...entry,
              phase: {
                tag: 'unresolved-launch',
                attempt: entry.phase.attempt,
                since: entry.phase.since,
                reason: 'worker-restart',
              },
            }
  }
  return entries === undefined
    ? noChange(state)
    : { state: pruneProfiles({ ...state, entries }), changed: true }
}
export interface ActiveDownloadRow {
  readonly state?: string
  readonly exists?: boolean
  readonly error?: string
  readonly bytesReceived?: number
  readonly totalBytes?: number
}
export interface ActiveReconciliationPlan {
  readonly state: TransferRegistryStore
  readonly toRetry: ReadonlyArray<{
    readonly id: string
    readonly downloadId: number
  }>
}
export function planActiveReconciliation(
  state: TransferRegistryStore,
  input: {
    readonly rowsByDownloadId: ReadonlyMap<number, ActiveDownloadRow>
    readonly threwDownloadIds: ReadonlySet<number>
    readonly now: number
  },
): ActiveReconciliationPlan {
  if (!isRegistryTime(input.now)) throw new TypeError('invalid reconcile time')
  let next = state
  const toRetry: Array<{ id: string; downloadId: number }> = []
  for (const [id, entry] of Object.entries(state.entries)) {
    if (entry.phase.tag !== 'active' || input.threwDownloadIds.has(entry.phase.downloadId)) continue
    const row = input.rowsByDownloadId.get(entry.phase.downloadId)
    if (row === undefined) {
      next = quarantineActive(next, {
        id,
        downloadId: entry.phase.downloadId,
      }).state
      continue
    }
    if (row.state === 'complete')
      next = recordBrowserTerminal(next, {
        id,
        downloadId: entry.phase.downloadId,
        state: row.exists === false ? 'interrupted' : 'complete',
        observedAt: input.now,
        ...(isDownloadId(row.bytesReceived) ? { bytesReceived: row.bytesReceived } : {}),
        ...(isDownloadId(row.totalBytes) ? { totalBytes: row.totalBytes } : {}),
      }).state
    else if (row.state === 'interrupted') {
      if (isRetryableInterruptReason(row.error) && entry.phase.attempt < MAX_TRANSFER_ATTEMPTS) {
        next = scheduleInterruptedRetry(next, {
          id,
          downloadId: entry.phase.downloadId,
          retryAt: saturatingDeadline(input.now, interruptBackoffMs(entry.phase.attempt)),
        }).state
        toRetry.push({ id, downloadId: entry.phase.downloadId })
      } else
        next = recordBrowserTerminal(next, {
          id,
          downloadId: entry.phase.downloadId,
          state: 'interrupted',
          observedAt: input.now,
          ...(isDownloadId(row.bytesReceived) ? { bytesReceived: row.bytesReceived } : {}),
          ...(isDownloadId(row.totalBytes) ? { totalBytes: row.totalBytes } : {}),
        }).state
    }
  }
  return { state: next, toRetry }
}
