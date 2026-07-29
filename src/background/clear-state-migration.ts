import { CLEAR_MIN_POST_TERMINAL_DELAY_MS, initialClearSafetyState } from '../core/clear/safety'
import {
  decodeCompletionLedger,
  emptyCompletionLedger,
  encodeCompletionLedger,
  type CompletionLedger,
} from '../core/clear/ledger'
import { measureJsonBytes } from '../core/wire/json-budget'
import type {
  ClearDurableBackend,
  ClearDatabaseIdentity,
  StoredClearTombstone,
} from './clear-indexed-db'
import {
  CLEAR_POINTER_VERSION,
  MAX_CLEAR_MIGRATION_BYTES,
  ClearCoordinatorCorruptionError,
  attempted,
  decodeClearCoordinatorStore,
  decodePointer,
  decodeStoredTombstone,
  encodeClearCoordinatorStore,
  latestTombstoneAt,
  type CoordinatorState,
} from './clear-state-codec'
import type {
  ClearCoordinatorStorage,
  ClearCoordinatorTrace,
  ClearStorePointerStorage,
  LegacyCompletionStorage,
} from './clear-state-ports'

const textEncoder = new TextEncoder()
const digest = async (value: string): Promise<string> => {
  const bytes = await crypto.subtle.digest('SHA-256', textEncoder.encode(value))
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
const canonicalJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalJsonValue)
  if (!isPlainRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, canonicalJsonValue(value[key])]),
  )
}
export const migrationReceipt = async (
  active: unknown,
  tombstones: ReadonlyArray<StoredClearTombstone>,
): Promise<ClearDatabaseIdentity['receipt']> => {
  const canonical = tombstones
    .map((tombstone) => [tombstone.tweetId, tombstone.scope, tombstone.state, tombstone.at])
    .toSorted(([leftTweet, leftScope], [rightTweet, rightScope]) => {
      const tweetOrder = String(leftTweet).localeCompare(String(rightTweet))
      return tweetOrder !== 0 ? tweetOrder : String(leftScope).localeCompare(String(rightScope))
    })
  return {
    activeDigest: await digest(JSON.stringify(canonicalJsonValue(active))),
    tombstoneCount: canonical.length,
    tombstoneDigest: await digest(JSON.stringify(canonical)),
  }
}

export interface ClearMigration {
  readonly sourceState: (at: number) => Promise<{
    readonly state: CoordinatorState
    readonly source: ClearDatabaseIdentity['source']
  }>
  readonly finishPointer: (
    identity: ClearDatabaseIdentity,
    active: unknown,
    revision: number,
    at: number,
  ) => Promise<void>
}

const fromLegacy = (completion: CompletionLedger, at: number): CoordinatorState => {
  const initial = initialClearSafetyState(1)
  if (initial === undefined) throw new ClearCoordinatorCorruptionError('invalid initial safety')
  const latest = latestTombstoneAt(completion)
  if (latest > Number.MAX_SAFE_INTEGER - CLEAR_MIN_POST_TERMINAL_DELAY_MS)
    throw new ClearCoordinatorCorruptionError('legacy Clear deadline overflows')
  const safety =
    latest < 0 ? initial : { ...initial, nextAttemptAt: latest + CLEAR_MIN_POST_TERMINAL_DELAY_MS }
  const claims = attempted(completion)
  if (claims.length > 200 || claims.length > at + 1)
    throw new ClearCoordinatorCorruptionError('legacy attempted Clears cannot be charged safely')
  return {
    completion,
    safety:
      claims.length === 0
        ? safety
        : {
            ...safety,
            attemptAts: Array.from(
              { length: claims.length },
              (_, index) => at - claims.length + index + 1,
            ),
          },
  }
}

export const makeClearMigration = (input: {
  readonly storage: ClearCoordinatorStorage
  readonly legacyStorage: LegacyCompletionStorage
  readonly pointerStorage: ClearStorePointerStorage
  readonly backend: ClearDurableBackend
  readonly trace: (stage: string, context?: ClearCoordinatorTrace) => void
}): ClearMigration => {
  const sourceState: ClearMigration['sourceState'] = async (at) => {
    const coordinatorRaw = await input.storage.get()
    if (coordinatorRaw !== undefined && coordinatorRaw !== null) {
      const decoded = decodeClearCoordinatorStore(coordinatorRaw, at)
      if (!decoded.ok) {
        input.trace('clear-coordinator-corrupt', { detail: decoded.reason })
        throw new ClearCoordinatorCorruptionError(decoded.reason)
      }
      return {
        state: decoded.state,
        source: {
          kind: 'coordinator',
          digest: await digest(JSON.stringify(encodeClearCoordinatorStore(decoded.state))),
        },
      }
    }
    const legacyRaw = await input.legacyStorage.get()
    if (legacyRaw !== undefined && legacyRaw !== null) {
      if (measureJsonBytes(legacyRaw, MAX_CLEAR_MIGRATION_BYTES) === undefined)
        throw new ClearCoordinatorCorruptionError('legacy Clear ledger exceeds migration budget')
      const decoded = decodeCompletionLedger(legacyRaw)
      if (!decoded.ok) {
        input.trace('clear-legacy-corrupt', { detail: decoded.reason })
        throw new ClearCoordinatorCorruptionError(`invalid legacy ledger: ${decoded.reason}`)
      }
      return {
        state: fromLegacy(decoded.ledger, at),
        source: {
          kind: 'legacy',
          digest: await digest(JSON.stringify(encodeCompletionLedger(decoded.ledger))),
        },
      }
    }
    return { state: fromLegacy(emptyCompletionLedger(), at), source: { kind: 'fresh' } }
  }

  const verifyReceipt = async (
    identity: ClearDatabaseIdentity,
    active: unknown,
    revision: number,
  ): Promise<void> => {
    const rows = await input.backend.listMigrationTombstones()
    const tombstones = rows.map((row) => {
      const decoded = decodeStoredTombstone(row)
      if (decoded === undefined || decoded.origin !== 'migration')
        throw new ClearCoordinatorCorruptionError('invalid migrated tombstone')
      return decoded
    })
    const receipt = await migrationReceipt(active, tombstones)
    if (
      (revision === 0 && receipt.activeDigest !== identity.receipt.activeDigest) ||
      receipt.tombstoneCount !== identity.receipt.tombstoneCount ||
      receipt.tombstoneDigest !== identity.receipt.tombstoneDigest
    )
      throw new ClearCoordinatorCorruptionError('Clear migration target does not match its receipt')
  }

  const finishPointer: ClearMigration['finishPointer'] = async (identity, active, revision, at) => {
    const pointerRaw = await input.pointerStorage.get()
    const pointer = decodePointer(pointerRaw)
    if (pointerRaw !== undefined && pointerRaw !== null && pointer === undefined)
      throw new ClearCoordinatorCorruptionError('invalid Clear database pointer')
    if (pointer !== undefined) {
      if (pointer.storeId !== identity.storeId)
        throw new ClearCoordinatorCorruptionError('Clear database pointer mismatch')
      await verifyReceipt(identity, active, revision)
      return
    }
    if (revision !== 0)
      throw new ClearCoordinatorCorruptionError('unpointed Clear database has runtime revisions')
    const source = await sourceState(at)
    if (
      source.source.kind !== identity.source.kind ||
      (source.source.kind !== 'fresh' &&
        (identity.source.kind === 'fresh' || source.source.digest !== identity.source.digest))
    )
      throw new ClearCoordinatorCorruptionError('Clear migration source does not match its receipt')
    await verifyReceipt(identity, active, revision)
    await input.pointerStorage.set({ version: CLEAR_POINTER_VERSION, storeId: identity.storeId })
  }

  return { sourceState, finishPointer }
}
