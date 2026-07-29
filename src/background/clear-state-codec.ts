import {
  CLEAR_MIN_POST_TERMINAL_DELAY_MS,
  decodeClearSafetyState,
  encodeClearSafetyState,
  type ClearSafetyState,
} from '../core/clear/safety'
import {
  decodeCompletionLedger,
  encodeCompletionLedger,
  type ClearLedgerStore,
  type ClearTombstone,
  type CompletionLedger,
  type CompletionLedgerEntry,
  type Scope,
} from '../core/clear/ledger'
import { MAX_SAVE_REQUEST_ID_LENGTH } from '../core/download/request-identity'
import { measureJsonBytes } from '../core/wire/json-budget'
import type {
  ClearDatabaseIdentity,
  ClearTombstoneKey,
  StoredClearTombstone,
} from './clear-indexed-db'

export const MAX_CLEAR_ACTIVE_POSTS = 512
export const MAX_CLEAR_REQUESTS_PER_POST = 64
export const MAX_CLEAR_REQUEST_ID_LENGTH = MAX_SAVE_REQUEST_ID_LENGTH
export const MAX_CLEAR_ACTIVE_BYTES = 2 * 1024 * 1024
export const MAX_CLEAR_MIGRATION_BYTES = 16 * 1024 * 1024
export const MAX_ATTEMPTS_PER_SESSION = 200
export const CLEAR_POINTER_VERSION = 1

const ACTIVE_KEY = 'coordinator'

export interface ClearCoordinatorStore {
  readonly version: 1
  readonly completion: ClearLedgerStore
  readonly safety: ClearSafetyState
}

export interface ClearActiveStore {
  readonly key: typeof ACTIVE_KEY
  readonly version: 2
  readonly revision: number
  readonly completion: ClearLedgerStore
  readonly safety: ClearSafetyState
  readonly lastTerminalAt: number
}

export interface CoordinatorState {
  readonly completion: CompletionLedger
  readonly safety: ClearSafetyState
}

export interface ClearStorePointer {
  readonly version: typeof CLEAR_POINTER_VERSION
  readonly storeId: string
}

export interface ClearOpenSessionMarker {
  readonly version: 1
  readonly browserSessionEpoch: number
}

export interface ClearStartupClaimMarker {
  readonly version: 2
  readonly browserSessionEpoch: number
  readonly baseRevision: number
  readonly baseAttemptAts: readonly number[]
}

export type ClearSessionMarker = ClearOpenSessionMarker | ClearStartupClaimMarker

export class ClearCoordinatorCorruptionError extends Error {
  constructor(readonly reason: string) {
    super(`Clear Coordinator is corrupt: ${reason}`)
    this.name = 'ClearCoordinatorCorruptionError'
  }
}

export const isTime = (value: number): boolean => Number.isSafeInteger(value) && value >= 0
export const isDownloadId = (value: number): boolean => Number.isSafeInteger(value) && value >= 0
export const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}
export const isScope = (value: unknown): value is Scope =>
  value === 'bookmark' || value === 'like' || value === 'notInterested'
const isTweetId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9]{1,20}$/.test(value)
export const unique = <T>(items: ReadonlyArray<T>): boolean => new Set(items).size === items.length
export const entryScopes = (entry: CompletionLedgerEntry): Scope[] => [
  ...new Set([...entry.manualScopes, ...entry.automaticScopes]),
]
const terminalState = (state: string): state is ClearTombstone['state'] =>
  state === 'cleared' || state === 'uncertain'
export const latestTombstoneAt = (ledger: CompletionLedger): number => {
  let latest = -1
  for (const states of ledger.tombstones.values())
    for (const tombstone of states.values()) latest = Math.max(latest, tombstone.at)
  return latest
}

export type DecodeClearCoordinatorStore =
  | { readonly ok: true; readonly state: CoordinatorState }
  | { readonly ok: false; readonly reason: string }

const validateCoordinatorState = (
  completion: CompletionLedger,
  safety: ClearSafetyState,
  lastTerminalAt: number,
): string | undefined => {
  if ((safety.backoffLevel === 0) !== (safety.blockedUntil === 0))
    return 'invalid safety backoff tuple'
  if (
    lastTerminalAt >= 0 &&
    (lastTerminalAt > Number.MAX_SAFE_INTEGER - CLEAR_MIN_POST_TERMINAL_DELAY_MS ||
      safety.nextAttemptAt < lastTerminalAt + CLEAR_MIN_POST_TERMINAL_DELAY_MS)
  )
    return 'terminal Clear has no valid pacing deadline'
  const attempted = [...completion.entries.values()].flatMap((entry) =>
    entryScopes(entry).filter((scope) => entry.clear[scope] === 'attempted'),
  )
  if (attempted.length > 1) return 'multiple destructive requests are attempted'
  const lastAttemptAt = safety.attemptAts.at(-1)
  if (
    attempted.length === 1 &&
    (lastAttemptAt === undefined ||
      lastAttemptAt < safety.nextAttemptAt ||
      lastAttemptAt < safety.blockedUntil)
  )
    return 'attempted Clear has no valid safety issuance'
  if (
    attempted.length === 0 &&
    lastAttemptAt !== undefined &&
    (lastAttemptAt > Number.MAX_SAFE_INTEGER - CLEAR_MIN_POST_TERMINAL_DELAY_MS ||
      safety.nextAttemptAt < lastAttemptAt + CLEAR_MIN_POST_TERMINAL_DELAY_MS)
  )
    return 'completed Clear has no valid pacing deadline'
  return undefined
}

export const decodeClearCoordinatorStore = (
  value: unknown,
  now: number,
): DecodeClearCoordinatorStore => {
  if (
    measureJsonBytes(value, MAX_CLEAR_MIGRATION_BYTES) === undefined ||
    !isTime(now) ||
    !isPlainRecord(value) ||
    !exactKeys(value, ['version', 'completion', 'safety']) ||
    value.version !== 1
  )
    return { ok: false, reason: 'invalid coordinator envelope' }
  const completion = decodeCompletionLedger(value.completion)
  if (!completion.ok) return { ok: false, reason: completion.reason }
  const safety = decodeClearSafetyState(value.safety, now)
  if (safety === undefined) return { ok: false, reason: 'invalid safety state' }
  const reason = validateCoordinatorState(
    completion.ledger,
    safety,
    latestTombstoneAt(completion.ledger),
  )
  return reason === undefined
    ? { ok: true, state: { completion: completion.ledger, safety } }
    : { ok: false, reason }
}

export const encodeClearCoordinatorStore = (state: CoordinatorState): ClearCoordinatorStore => ({
  version: 1,
  completion: encodeCompletionLedger(state.completion),
  safety: encodeClearSafetyState(state.safety),
})

const activeTombstones = (
  ledger: CompletionLedger,
): ReadonlyMap<string, ReadonlyMap<Scope, ClearTombstone>> => {
  const result = new Map<string, ReadonlyMap<Scope, ClearTombstone>>()
  for (const [tweetId, entry] of ledger.entries) {
    const terminal = new Map<Scope, ClearTombstone>()
    for (const scope of entryScopes(entry)) {
      const state = entry.clear[scope]
      const tombstone = ledger.tombstones.get(tweetId)?.get(scope)
      if (terminalState(state) && tombstone?.state === state) terminal.set(scope, tombstone)
    }
    if (terminal.size > 0) result.set(tweetId, terminal)
  }
  return result
}

export const compactState = (state: CoordinatorState): CoordinatorState => ({
  ...state,
  completion: {
    entries: state.completion.entries,
    tombstones: activeTombstones(state.completion),
  },
})

const assertEntryLimits = (completion: CompletionLedger): void => {
  if (completion.entries.size > MAX_CLEAR_ACTIVE_POSTS)
    throw new ClearCoordinatorCorruptionError(
      `active post limit exceeded: ${completion.entries.size}`,
    )
  for (const entry of completion.entries.values()) {
    if (entry.expected.size > MAX_CLEAR_REQUESTS_PER_POST)
      throw new ClearCoordinatorCorruptionError(`request limit exceeded for ${entry.tweetId}`)
    for (const requestId of entry.expected)
      if (requestId.length === 0 || requestId.length > MAX_CLEAR_REQUEST_ID_LENGTH)
        throw new ClearCoordinatorCorruptionError(`invalid request id length for ${entry.tweetId}`)
  }
}

const projectedCapacity = (state: CoordinatorState): unknown => {
  const stored = encodeCompletionLedger(compactState(state).completion)
  const entries = Object.fromEntries(
    Object.entries(stored.entries).map(([tweetId, entry]) => {
      const ids = [...entry.expected]
      const handles = Object.fromEntries(
        ids.map((requestId) => [
          requestId,
          { downloadId: Number.MAX_SAFE_INTEGER, startedAt: Number.MAX_SAFE_INTEGER },
        ]),
      )
      return [
        tweetId,
        {
          ...entry,
          touchedAt: Number.MAX_SAFE_INTEGER,
          done: ids,
          failed: [],
          inProgress: ids,
          handles,
          settling: {},
          clear: { bookmark: 'uncertain', like: 'uncertain', notInterested: 'uncertain' },
        },
      ]
    }),
  )
  const tombstones = Object.fromEntries(
    [...state.completion.entries].map(([tweetId, entry]) => [
      tweetId,
      Object.fromEntries(
        entryScopes(entry).map((scope) => [
          scope,
          { tweetId, scope, state: 'uncertain', at: Number.MAX_SAFE_INTEGER },
        ]),
      ),
    ]),
  )
  return {
    key: ACTIVE_KEY,
    version: 2,
    revision: Number.MAX_SAFE_INTEGER,
    completion: { version: 1, entries, tombstones },
    safety: {
      ...encodeClearSafetyState(state.safety),
      nextAttemptAt: Number.MAX_SAFE_INTEGER,
      attemptAts: Array.from({ length: MAX_ATTEMPTS_PER_SESSION }, () => Number.MAX_SAFE_INTEGER),
      browserSessionEpoch: Number.MAX_SAFE_INTEGER,
      blockedUntil: Number.MAX_SAFE_INTEGER,
    },
    lastTerminalAt: Number.MAX_SAFE_INTEGER,
  }
}

export const encodeActiveStore = (
  state: CoordinatorState,
  lastTerminalAt: number,
  revision: number,
): ClearActiveStore => {
  if (
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    !Number.isSafeInteger(lastTerminalAt) ||
    lastTerminalAt < -1
  )
    throw new ClearCoordinatorCorruptionError('invalid active revision')
  assertEntryLimits(state.completion)
  const compact = compactState(state)
  const completion = encodeCompletionLedger(compact.completion)
  const decodedCompletion = decodeCompletionLedger(completion)
  if (!decodedCompletion.ok) throw new ClearCoordinatorCorruptionError(decodedCompletion.reason)
  const safety = encodeClearSafetyState(state.safety)
  const decodedSafety = decodeClearSafetyState(safety, Number.MAX_SAFE_INTEGER)
  if (decodedSafety === undefined) throw new ClearCoordinatorCorruptionError('invalid safety state')
  const reason = validateCoordinatorState(decodedCompletion.ledger, decodedSafety, lastTerminalAt)
  if (reason !== undefined) throw new ClearCoordinatorCorruptionError(reason)
  if (measureJsonBytes(projectedCapacity(state), MAX_CLEAR_ACTIVE_BYTES) === undefined)
    throw new ClearCoordinatorCorruptionError('active coordinator capacity exceeded')
  const active: ClearActiveStore = {
    key: ACTIVE_KEY,
    version: 2,
    revision,
    completion,
    safety,
    lastTerminalAt,
  }
  if (measureJsonBytes(active, MAX_CLEAR_ACTIVE_BYTES) === undefined)
    throw new ClearCoordinatorCorruptionError('active coordinator byte limit exceeded')
  return active
}

export const decodeActiveStore = (
  value: unknown,
  now: number,
): {
  readonly state: CoordinatorState
  readonly lastTerminalAt: number
  readonly revision: number
} => {
  if (
    measureJsonBytes(value, MAX_CLEAR_ACTIVE_BYTES) === undefined ||
    !isPlainRecord(value) ||
    !exactKeys(value, ['key', 'version', 'revision', 'completion', 'safety', 'lastTerminalAt']) ||
    value.key !== ACTIVE_KEY ||
    value.version !== 2 ||
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    typeof value.lastTerminalAt !== 'number' ||
    !Number.isSafeInteger(value.lastTerminalAt) ||
    value.lastTerminalAt < -1
  )
    throw new ClearCoordinatorCorruptionError('invalid active coordinator envelope')
  const completion = decodeCompletionLedger(value.completion)
  if (!completion.ok) throw new ClearCoordinatorCorruptionError(completion.reason)
  assertEntryLimits(completion.ledger)
  for (const [tweetId, tombstones] of completion.ledger.tombstones) {
    const entry = completion.ledger.entries.get(tweetId)
    if (entry === undefined)
      throw new ClearCoordinatorCorruptionError(`inactive tombstone cache ${tweetId}`)
    for (const [scope, tombstone] of tombstones)
      if (entry.clear[scope] !== tombstone.state || !terminalState(entry.clear[scope]))
        throw new ClearCoordinatorCorruptionError(`invalid tombstone cache ${tweetId}/${scope}`)
  }
  const safety = decodeClearSafetyState(value.safety, now)
  if (safety === undefined) throw new ClearCoordinatorCorruptionError('invalid safety state')
  const reason = validateCoordinatorState(completion.ledger, safety, value.lastTerminalAt)
  if (reason !== undefined) throw new ClearCoordinatorCorruptionError(reason)
  return {
    state: { completion: completion.ledger, safety },
    lastTerminalAt: value.lastTerminalAt,
    revision: value.revision,
  }
}

export const decodeStoredTombstone = (
  value: unknown,
  key?: ClearTombstoneKey,
): StoredClearTombstone | undefined => {
  if (
    !isPlainRecord(value) ||
    !exactKeys(value, ['version', 'origin', 'tweetId', 'scope', 'state', 'at', 'reverseAt']) ||
    value.version !== 1 ||
    (value.origin !== 'migration' && value.origin !== 'runtime') ||
    !isTweetId(value.tweetId) ||
    !isScope(value.scope) ||
    !terminalState(String(value.state)) ||
    typeof value.at !== 'number' ||
    !isTime(value.at) ||
    typeof value.reverseAt !== 'number' ||
    value.reverseAt !== Number.MAX_SAFE_INTEGER - value.at ||
    (key !== undefined && (key[0] !== value.tweetId || key[1] !== value.scope))
  )
    return undefined
  return value as unknown as StoredClearTombstone
}

export const domainTombstone = (value: StoredClearTombstone): ClearTombstone => ({
  tweetId: value.tweetId,
  scope: value.scope,
  state: value.state,
  at: value.at,
})

export const decodeIdentity = (value: unknown): ClearDatabaseIdentity | undefined => {
  if (
    !isPlainRecord(value) ||
    !exactKeys(value, ['key', 'version', 'storeId', 'receipt', 'source']) ||
    value.key !== 'identity' ||
    value.version !== 1 ||
    typeof value.storeId !== 'string' ||
    value.storeId.length === 0 ||
    value.storeId.length > 128 ||
    !isPlainRecord(value.receipt) ||
    !exactKeys(value.receipt, ['activeDigest', 'tombstoneCount', 'tombstoneDigest']) ||
    typeof value.receipt.activeDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.receipt.activeDigest) ||
    typeof value.receipt.tombstoneCount !== 'number' ||
    !Number.isSafeInteger(value.receipt.tombstoneCount) ||
    value.receipt.tombstoneCount < 0 ||
    typeof value.receipt.tombstoneDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.receipt.tombstoneDigest) ||
    !isPlainRecord(value.source)
  )
    return undefined
  if (exactKeys(value.source, ['kind']) && value.source.kind === 'fresh')
    return value as unknown as ClearDatabaseIdentity
  if (
    exactKeys(value.source, ['kind', 'digest']) &&
    (value.source.kind === 'coordinator' || value.source.kind === 'legacy') &&
    typeof value.source.digest === 'string' &&
    /^[0-9a-f]{64}$/.test(value.source.digest)
  )
    return value as unknown as ClearDatabaseIdentity
  return undefined
}

export const decodePointer = (value: unknown): ClearStorePointer | undefined =>
  isPlainRecord(value) &&
  exactKeys(value, ['version', 'storeId']) &&
  value.version === CLEAR_POINTER_VERSION &&
  typeof value.storeId === 'string' &&
  value.storeId.length > 0 &&
  value.storeId.length <= 128
    ? { version: CLEAR_POINTER_VERSION, storeId: value.storeId }
    : undefined

export const decodeClearSessionMarker = (value: unknown): ClearSessionMarker | undefined => {
  if (
    !isPlainRecord(value) ||
    typeof value.browserSessionEpoch !== 'number' ||
    !Number.isSafeInteger(value.browserSessionEpoch) ||
    value.browserSessionEpoch <= 0
  )
    return undefined
  if (exactKeys(value, ['version', 'browserSessionEpoch']) && value.version === 1)
    return { version: 1, browserSessionEpoch: value.browserSessionEpoch }
  if (
    !exactKeys(value, ['version', 'browserSessionEpoch', 'baseRevision', 'baseAttemptAts']) ||
    value.version !== 2 ||
    typeof value.baseRevision !== 'number' ||
    !Number.isSafeInteger(value.baseRevision) ||
    value.baseRevision < 0 ||
    !Array.isArray(value.baseAttemptAts) ||
    value.baseAttemptAts.length > MAX_ATTEMPTS_PER_SESSION
  )
    return undefined
  const baseAttemptAts: number[] = []
  let previous = -1
  for (const attemptAt of value.baseAttemptAts) {
    if (!isTime(attemptAt) || attemptAt <= previous) return undefined
    baseAttemptAts.push(attemptAt)
    previous = attemptAt
  }
  return {
    version: 2,
    browserSessionEpoch: value.browserSessionEpoch,
    baseRevision: value.baseRevision,
    baseAttemptAts,
  }
}

export const assertTweetId = (tweetId: string): void => {
  if (!/^[0-9]{1,20}$/.test(tweetId)) throw new TypeError(`Invalid X tweet id: ${tweetId}`)
}
export const assertRequestId = (requestId: string): void => {
  if (requestId.length === 0 || requestId.length > MAX_CLEAR_REQUEST_ID_LENGTH)
    throw new TypeError('Invalid Clear request id')
}
export const assertTime = (at: number): void => {
  if (!isTime(at)) throw new TypeError(`Invalid timestamp: ${at}`)
}
export const assertDownloadId = (downloadId: number): void => {
  if (!isDownloadId(downloadId)) throw new TypeError(`Invalid download id: ${downloadId}`)
}

export const tombstoneKey = (tombstone: ClearTombstone): ClearTombstoneKey => [
  tombstone.tweetId,
  tombstone.scope,
]
export const keyText = ([tweetId, scope]: ClearTombstoneKey): string => `${tweetId}\u0000${scope}`
export const exactTombstone = (left: ClearTombstone, right: ClearTombstone): boolean =>
  left.tweetId === right.tweetId &&
  left.scope === right.scope &&
  left.state === right.state &&
  left.at === right.at
export const flattenTombstones = (ledger: CompletionLedger): ClearTombstone[] =>
  [...ledger.tombstones.values()].flatMap((states) => Array.from(states.values()))
export const allActiveKeys = (state: CoordinatorState): ClearTombstoneKey[] =>
  [...state.completion.entries].flatMap(([tweetId, entry]) =>
    entryScopes(entry).map((scope) => [tweetId, scope] as const),
  )
export const attempted = (
  ledger: CompletionLedger,
): Array<{ readonly tweetId: string; readonly scope: Scope }> =>
  [...ledger.entries].flatMap(([tweetId, entry]) =>
    entryScopes(entry).flatMap((scope) =>
      entry.clear[scope] === 'attempted' ? [{ tweetId, scope }] : [],
    ),
  )
