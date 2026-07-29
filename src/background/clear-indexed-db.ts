import { CLEAR_LOG_LIMIT } from '../core/schema'
import type { ClearTombstone, Scope } from '../core/clear/ledger'
import {
  CLEAR_WORKLIST_PROJECTION_BATCH,
  CLEAR_WORKLIST_PROJECTION_MAX,
  sameStoredClearWorklistProjection,
  type StoredClearWorklistProjection,
} from './clear-worklist-projection'

const DB_NAME = 'xmd-clear'
const DB_VERSION = 2
const META_STORE = 'meta'
const ACTIVE_STORE = 'active'
const TOMBSTONE_STORE = 'tombstones'
const WORKLIST_PROJECTION_STORE = 'worklistProjections'
const IDENTITY_KEY = 'identity'
const ACTIVE_KEY = 'coordinator'
const CLEARED_TIME_INDEX = 'by_cleared_time'
const MIGRATION_INDEX = 'by_origin'
const WORKLIST_REVISION_INDEX = 'by_revision'

export type ClearTombstoneKey = readonly [tweetId: string, scope: Scope]

export interface ClearDatabaseIdentity {
  readonly key: typeof IDENTITY_KEY
  readonly version: 1
  readonly storeId: string
  readonly receipt: {
    readonly activeDigest: string
    readonly tombstoneCount: number
    readonly tombstoneDigest: string
  }
  readonly source:
    | { readonly kind: 'fresh' }
    | {
        readonly kind: 'coordinator' | 'legacy'
        readonly digest: string
      }
}

export interface StoredClearTombstone extends ClearTombstone {
  readonly version: 1
  readonly origin: 'migration' | 'runtime'
  /** Ascending index value that yields newest terminal facts first. */
  readonly reverseAt: number
}

export interface ObservedClearTombstone {
  readonly key: ClearTombstoneKey
  readonly value: StoredClearTombstone | undefined
}

export interface ClearDurableBackend {
  readonly load: () => Promise<{
    readonly identity: unknown
    readonly active: unknown
  }>
  /** Creates identity, active state, and imported tombstones in one transaction. */
  readonly bootstrap: (
    identity: ClearDatabaseIdentity,
    active: unknown,
    tombstones: ReadonlyArray<StoredClearTombstone>,
  ) => Promise<'created' | 'exists'>
  readonly readTombstones: (
    keys: ReadonlyArray<ClearTombstoneKey>,
  ) => Promise<ReadonlyArray<ObservedClearTombstone>>
  /** Revalidates observed keys, appends immutable facts, and writes active state atomically. */
  readonly commit: (input: {
    readonly expectedRevision: number
    readonly active: unknown
    readonly observed: ReadonlyArray<ObservedClearTombstone>
    readonly append: ReadonlyArray<StoredClearTombstone>
    readonly worklist?: ReadonlyArray<StoredClearWorklistProjection>
  }) => Promise<void>
  /** Reads only bounded cutover facts while validating a migration receipt. */
  readonly listMigrationTombstones: () => Promise<ReadonlyArray<unknown>>
  readonly listCleared: (limit?: number) => Promise<ReadonlyArray<unknown>>
  readonly listWorklistProjections: (limit?: number) => Promise<ReadonlyArray<unknown>>
  /** Deletes only the exact revision the sink applied. */
  readonly ackWorklistProjection: (
    expected: StoredClearWorklistProjection,
  ) => Promise<'acked' | 'missing' | 'stale'>
}

export class ClearDatabaseConflictError extends Error {
  constructor(readonly reason: string) {
    super(`Clear database conflict: ${reason}`)
    this.name = 'ClearDatabaseConflictError'
  }
}

const requestResult = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result))
    request.addEventListener('error', () => reject(request.error))
  })

const transactionDone = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve())
    transaction.addEventListener('abort', () =>
      reject(transaction.error ?? new Error('Clear database transaction aborted')),
    )
    transaction.addEventListener('error', () =>
      reject(transaction.error ?? new Error('Clear database transaction failed')),
    )
  })

const sameStoredTombstone = (
  left: StoredClearTombstone | undefined,
  right: StoredClearTombstone | undefined,
): boolean =>
  left === right ||
  (left !== undefined &&
    right !== undefined &&
    left.version === right.version &&
    left.origin === right.origin &&
    left.tweetId === right.tweetId &&
    left.scope === right.scope &&
    left.state === right.state &&
    left.at === right.at &&
    left.reverseAt === right.reverseAt)

const keyText = ([tweetId, scope]: ClearTombstoneKey): string => `${tweetId}\u0000${scope}`

const revisionOf = (value: unknown): number | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const revision = Reflect.get(value, 'revision')
  return typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0
    ? revision
    : undefined
}

const readwrite = (db: IDBDatabase, stores: string | string[]): IDBTransaction =>
  db.transaction(stores, 'readwrite', { durability: 'strict' })

export const makeIndexedDbClearBackend = (
  databaseName = DB_NAME,
  indexedDb?: IDBFactory,
  keyRange?: typeof IDBKeyRange,
): ClearDurableBackend => {
  let database: Promise<IDBDatabase> | undefined
  const liveIndexedDb = (): IDBFactory => indexedDb ?? globalThis.indexedDB
  const liveKeyRange = (): typeof IDBKeyRange => keyRange ?? globalThis.IDBKeyRange

  const open = (): Promise<IDBDatabase> => {
    if (database !== undefined) return database
    let settled = false
    const openingPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const opening = liveIndexedDb().open(databaseName, DB_VERSION)
      opening.addEventListener('upgradeneeded', () => {
        const db = opening.result
        if (!db.objectStoreNames.contains(META_STORE))
          db.createObjectStore(META_STORE, { keyPath: 'key' })
        if (!db.objectStoreNames.contains(ACTIVE_STORE))
          db.createObjectStore(ACTIVE_STORE, { keyPath: 'key' })
        const tombstones = db.objectStoreNames.contains(TOMBSTONE_STORE)
          ? opening.transaction!.objectStore(TOMBSTONE_STORE)
          : db.createObjectStore(TOMBSTONE_STORE, {
              keyPath: ['tweetId', 'scope'],
            })
        if (!tombstones.indexNames.contains(CLEARED_TIME_INDEX))
          tombstones.createIndex(CLEARED_TIME_INDEX, ['state', 'reverseAt', 'tweetId', 'scope'])
        if (!tombstones.indexNames.contains(MIGRATION_INDEX))
          tombstones.createIndex(MIGRATION_INDEX, 'origin')
        if (!db.objectStoreNames.contains(WORKLIST_PROJECTION_STORE)) {
          const projections = db.createObjectStore(WORKLIST_PROJECTION_STORE, {
            keyPath: ['tweetId', 'scope'],
          })
          projections.createIndex(WORKLIST_REVISION_INDEX, ['revision', 'tweetId', 'scope'])
        }
      })
      opening.addEventListener('success', () => {
        const db = opening.result
        if (settled) {
          db.close()
          return
        }
        settled = true
        db.addEventListener('versionchange', () => {
          if (database === openingPromise) database = undefined
          db.close()
        })
        db.addEventListener('close', () => {
          if (database === openingPromise) database = undefined
        })
        resolve(db)
      })
      opening.addEventListener('error', () => {
        if (settled) return
        settled = true
        reject(opening.error ?? new Error('Could not open Clear database'))
      })
    })
    database = openingPromise
    void openingPromise.catch(() => {
      if (database === openingPromise) database = undefined
    })
    return openingPromise
  }

  return {
    load: async () => {
      const db = await open()
      const transaction = db.transaction([META_STORE, ACTIVE_STORE], 'readonly')
      const done = transactionDone(transaction)
      const identity = requestResult(transaction.objectStore(META_STORE).get(IDENTITY_KEY))
      const active = requestResult(transaction.objectStore(ACTIVE_STORE).get(ACTIVE_KEY))
      const result = { identity: await identity, active: await active }
      await done
      return result
    },

    bootstrap: async (identity, active, tombstones) => {
      const db = await open()
      const transaction = readwrite(db, [META_STORE, ACTIVE_STORE, TOMBSTONE_STORE])
      const meta = transaction.objectStore(META_STORE)
      const state = transaction.objectStore(ACTIVE_STORE)
      const terminal = transaction.objectStore(TOMBSTONE_STORE)
      let outcome: 'created' | 'exists' = 'exists'
      const existing = meta.get(IDENTITY_KEY)
      existing.addEventListener('success', () => {
        if (existing.result !== undefined) return
        outcome = 'created'
        meta.add(identity)
        state.add(active)
        for (const tombstone of tombstones) terminal.add(tombstone)
      })
      await transactionDone(transaction)
      return outcome
    },

    readTombstones: async (keys) => {
      if (keys.length === 0) return []
      const db = await open()
      const transaction = db.transaction(TOMBSTONE_STORE, 'readonly')
      const done = transactionDone(transaction)
      const store = transaction.objectStore(TOMBSTONE_STORE)
      const values = await Promise.all(
        keys.map(async (key) => ({
          key,
          value: (await requestResult(store.get([...key]))) as StoredClearTombstone | undefined,
        })),
      )
      await done
      return values
    },

    commit: async ({ expectedRevision, active, observed, append, worklist = [] }) => {
      if (worklist.length > CLEAR_WORKLIST_PROJECTION_MAX)
        throw new TypeError('Clear Worklist projection commit exceeds capacity')
      const db = await open()
      const transaction = readwrite(db, [ACTIVE_STORE, TOMBSTONE_STORE, WORKLIST_PROJECTION_STORE])
      const states = transaction.objectStore(ACTIVE_STORE)
      const tombstones = transaction.objectStore(TOMBSTONE_STORE)
      const projections = transaction.objectStore(WORKLIST_PROJECTION_STORE)
      const expected = new Map(observed.map((item) => [keyText(item.key), item]))
      for (const tombstone of append) {
        const key: ClearTombstoneKey = [tombstone.tweetId, tombstone.scope]
        if (!expected.has(keyText(key))) expected.set(keyText(key), { key, value: undefined })
      }
      const projectionKeys = new Map(
        worklist.map((item) => [keyText([item.tweetId, item.scope]), item]),
      )
      if (projectionKeys.size !== worklist.length)
        throw new TypeError('Clear Worklist projection keys must be unique')
      let remaining = expected.size + projectionKeys.size + 2
      let failed = false
      let conflictReason: string | undefined
      let projectionCount = 0
      let newProjectionCount = 0
      const abortConflict = (reason: string): void => {
        if (failed) return
        failed = true
        conflictReason = reason
        transaction.abort()
      }
      const finish = (): void => {
        remaining -= 1
        if (remaining !== 0 || failed) return
        if (projectionCount + newProjectionCount > CLEAR_WORKLIST_PROJECTION_MAX) {
          abortConflict('Worklist projection capacity exhausted')
          return
        }
        for (const tombstone of append) {
          const item = expected.get(keyText([tombstone.tweetId, tombstone.scope]))
          if (item?.value === undefined) tombstones.add(tombstone)
        }
        for (const projection of worklist) projections.put(projection)
        states.put(active)
      }
      const activeRequest = states.get(ACTIVE_KEY)
      activeRequest.addEventListener('success', () => {
        if (revisionOf(activeRequest.result) !== expectedRevision) {
          abortConflict('active revision changed')
          return
        }
        finish()
      })
      for (const item of expected.values()) {
        const get = tombstones.get([...item.key])
        get.addEventListener('success', () => {
          const actual = get.result as StoredClearTombstone | undefined
          if (!sameStoredTombstone(actual, item.value)) {
            abortConflict(`observed tombstone changed: ${keyText(item.key)}`)
            return
          }
          const incoming = append.find(
            (candidate) => candidate.tweetId === item.key[0] && candidate.scope === item.key[1],
          )
          if (
            incoming !== undefined &&
            actual !== undefined &&
            !sameStoredTombstone(actual, incoming)
          ) {
            abortConflict(`immutable tombstone changed: ${keyText(item.key)}`)
            return
          }
          finish()
        })
      }
      const count = projections.count()
      count.addEventListener('success', () => {
        projectionCount = count.result
        finish()
      })
      for (const projection of projectionKeys.values()) {
        const get = projections.get([projection.tweetId, projection.scope])
        get.addEventListener('success', () => {
          if (get.result === undefined) newProjectionCount += 1
          finish()
        })
      }
      try {
        await transactionDone(transaction)
      } catch (error) {
        if (conflictReason !== undefined) throw new ClearDatabaseConflictError(conflictReason)
        throw error
      }
    },

    listMigrationTombstones: async () => {
      const db = await open()
      const transaction = db.transaction(TOMBSTONE_STORE, 'readonly')
      const done = transactionDone(transaction)
      const cursor = transaction
        .objectStore(TOMBSTONE_STORE)
        .index(MIGRATION_INDEX)
        .openCursor(liveKeyRange().only('migration'))
      const rows = await new Promise<unknown[]>((resolve, reject) => {
        const result: unknown[] = []
        cursor.addEventListener('success', () => {
          const row = cursor.result
          if (row === null) {
            resolve(result)
            return
          }
          result.push(row.value)
          row.continue()
        })
        cursor.addEventListener('error', () =>
          reject(cursor.error ?? new Error('Could not validate Clear migration')),
        )
      })
      await done
      return rows
    },

    listCleared: async (limit = CLEAR_LOG_LIMIT) => {
      if (!Number.isSafeInteger(limit) || limit < 0 || limit > CLEAR_LOG_LIMIT)
        throw new TypeError(`Invalid Clear Log limit: ${limit}`)
      if (limit === 0) return []
      const db = await open()
      const transaction = db.transaction(TOMBSTONE_STORE, 'readonly')
      const done = transactionDone(transaction)
      const index = transaction.objectStore(TOMBSTONE_STORE).index(CLEARED_TIME_INDEX)
      const range = liveKeyRange().bound(
        ['cleared', 0, '', ''],
        ['cleared', Number.MAX_SAFE_INTEGER, '\uffff', '\uffff'],
      )
      const cursor = index.openCursor(range)
      const rows = await new Promise<unknown[]>((resolve, reject) => {
        const result: unknown[] = []
        cursor.addEventListener('success', () => {
          const row = cursor.result
          if (row === null || result.length >= limit) {
            resolve(result)
            return
          }
          result.push(row.value)
          if (result.length >= limit) {
            resolve(result)
            return
          }
          row.continue()
        })
        cursor.addEventListener('error', () =>
          reject(cursor.error ?? new Error('Could not read Clear Log')),
        )
      })
      await done
      return rows
    },

    listWorklistProjections: async (limit = CLEAR_WORKLIST_PROJECTION_BATCH) => {
      if (!Number.isSafeInteger(limit) || limit < 0 || limit > CLEAR_WORKLIST_PROJECTION_BATCH)
        throw new TypeError(`Invalid Clear Worklist projection limit: ${limit}`)
      if (limit === 0) return []
      const db = await open()
      const transaction = db.transaction(WORKLIST_PROJECTION_STORE, 'readonly')
      const done = transactionDone(transaction)
      const cursor = transaction
        .objectStore(WORKLIST_PROJECTION_STORE)
        .index(WORKLIST_REVISION_INDEX)
        .openCursor()
      const rows = await new Promise<unknown[]>((resolve, reject) => {
        const result: unknown[] = []
        cursor.addEventListener('success', () => {
          const row = cursor.result
          if (row === null || result.length >= limit) {
            resolve(result)
            return
          }
          result.push(row.value)
          row.continue()
        })
        cursor.addEventListener('error', () =>
          reject(cursor.error ?? new Error('Could not read Clear Worklist projections')),
        )
      })
      await done
      return rows
    },

    ackWorklistProjection: async (expected) => {
      const db = await open()
      const transaction = readwrite(db, WORKLIST_PROJECTION_STORE)
      const projections = transaction.objectStore(WORKLIST_PROJECTION_STORE)
      let outcome: 'acked' | 'missing' | 'stale' = 'missing'
      const get = projections.get([expected.tweetId, expected.scope])
      get.addEventListener('success', () => {
        if (get.result === undefined) return
        outcome = 'stale'
        const actual = get.result as StoredClearWorklistProjection
        if (!sameStoredClearWorklistProjection(actual, expected)) return
        outcome = 'acked'
        projections.delete([expected.tweetId, expected.scope])
      })
      await transactionDone(transaction)
      return outcome
    },
  }
}

export const storeTombstone = (
  tombstone: ClearTombstone,
  origin: StoredClearTombstone['origin'] = 'runtime',
): StoredClearTombstone => ({
  version: 1,
  origin,
  ...tombstone,
  reverseAt: Number.MAX_SAFE_INTEGER - tombstone.at,
})
