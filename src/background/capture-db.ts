/**
 * Durable source of truth for harvested tweets (spec §8). The harvest's
 * read-modify-write discipline — every write funneled through one
 * {@link makeSerialQueue}, each incoming record merged against the stored one by
 * {@link mergeRecord} (richer-source-wins, spec §6.4) — lives in the factory,
 * behind a {@link CaptureStore} seam. The default store is an IndexedDB adapter
 * over DB `xmd-capture`, store `tweets` (keyPath `tweetId`); tests inject an
 * in-memory store. IndexedDB needs the `unlimitedStorage` manifest permission
 * (wired separately) so the harvest is not evicted under storage pressure.
 */
import { decodeRecords, mergeRecord } from '../core/capture/store'
import type { TweetRecord } from '../core/capture/record'
import { makeSerialQueue } from '../core/serial-queue'

/** Per-record write policy: richer source wins (spec §6.4, {@link mergeRecord}). */
type Merge = (existing: TweetRecord | undefined, incoming: TweetRecord) => TweetRecord

export const CAPTURE_READ_PAGE_RECORDS = 128

/** A stable, bounded view held on the database's FIFO ahead of later writes. */
export interface CaptureReadSnapshot {
  page(afterTweetId?: string): Promise<ReadonlyArray<TweetRecord>>
  conversationPage(
    conversationId: string,
    afterTweetId?: string,
  ): Promise<ReadonlyArray<TweetRecord>>
  get(tweetId: string): Promise<TweetRecord | undefined>
}

/**
 * Persistence seam for the harvest. The default adapter is IndexedDB; tests
 * supply an in-memory stand-in. `upsert` is atomic per call: for each record it
 * reads the stored row, applies `merge`, and writes the winner.
 */
export interface CaptureStore {
  upsert(records: ReadonlyArray<TweetRecord>, merge: Merge): Promise<void>
  allRecords(): Promise<TweetRecord[]>
  page(afterTweetId: string | undefined, limit: number): Promise<TweetRecord[]>
  conversationPage(
    conversationId: string,
    afterTweetId: string | undefined,
    limit: number,
  ): Promise<TweetRecord[]>
  get(tweetId: string): Promise<TweetRecord | undefined>
  /** Stream every record through `step` (cursor-driven for IndexedDB) — an
   *  aggregate pass that never materializes the whole store in memory. */
  fold<A>(init: A, step: (acc: A, record: TweetRecord) => A): Promise<A>
  conversation(id: string): Promise<TweetRecord[]>
  /** Physical rows, including unreadable rows that Erase will remove. */
  count(): Promise<number>
  clear(): Promise<void>
}

export interface CaptureDb {
  /** Persist a harvested batch, merging each record against the stored one.
   *  Empty batches are a no-op. Serialized against every other write. */
  putRecords(records: ReadonlyArray<TweetRecord>): Promise<void>
  allRecords(): Promise<TweetRecord[]>
  /** Stream every record through `step` without loading the store whole. */
  fold<A>(init: A, step: (acc: A, record: TweetRecord) => A): Promise<A>
  conversation(id: string): Promise<TweetRecord[]>
  /** Physical rows. Read projections expose only schema-valid Tweet Records. */
  count(): Promise<number>
  clear(): Promise<void>
  /** Count and erase physical rows in one FIFO position. */
  clearAndCount(): Promise<number>
  /** Run one bounded read job ahead of later writes and clears. */
  withReadSnapshot<A>(read: (snapshot: CaptureReadSnapshot) => Promise<A>): Promise<A>
}

/** Fold duplicates before IndexedDB starts its asynchronous gets. Otherwise two
 * requests for one key can both read the old row and the later thin put can
 * overwrite a rich record from the same batch. */
const foldBatch = (records: ReadonlyArray<TweetRecord>): TweetRecord[] => {
  const byTweet = new Map<string, TweetRecord>()
  for (const incoming of records) {
    byTweet.set(incoming.tweetId, mergeRecord(byTweet.get(incoming.tweetId), incoming))
  }
  return [...byTweet.values()]
}

export function makeCaptureDb(deps: { store?: CaptureStore } = {}): CaptureDb {
  const store = deps.store ?? makeIndexedDbStore()
  const writes = makeSerialQueue()
  return {
    putRecords: (records) =>
      writes.run(async () => {
        if (records.length === 0) return
        await store.upsert(foldBatch(records), mergeRecord)
      }),
    allRecords: async () => decodeRecords(await store.allRecords()),
    fold: (init, step) =>
      store.fold(init, (acc, record) => {
        const decoded = decodeRecords([record])[0]
        return decoded === undefined ? acc : step(acc, decoded)
      }),
    conversation: async (id) => decodeRecords(await store.conversation(id)),
    count: () => store.count(),
    clear: () => writes.run(() => store.clear()),
    clearAndCount: () =>
      writes.run(async () => {
        const count = await store.count()
        await store.clear()
        return count
      }),
    withReadSnapshot: (read) =>
      writes.run(() =>
        read({
          page: async (afterTweetId) =>
            decodeRecords(await store.page(afterTweetId, CAPTURE_READ_PAGE_RECORDS)),
          conversationPage: async (conversationId, afterTweetId) =>
            decodeRecords(
              await store.conversationPage(conversationId, afterTweetId, CAPTURE_READ_PAGE_RECORDS),
            ),
          get: async (tweetId) => decodeRecords([await store.get(tweetId)])[0],
        }),
      ),
  }
}

// ── IndexedDB adapter (the default store) ────────────────────────────────────
const DB_NAME = 'xmd-capture'
const STORE = 'tweets'
const VERSION = 1

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result))
    request.addEventListener('error', () => reject(request.error))
  })
}

function makeIndexedDbStore(): CaptureStore {
  let dbPromise: Promise<IDBDatabase> | undefined

  function openDb(): Promise<IDBDatabase> {
    if (dbPromise !== undefined) return dbPromise
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, VERSION)
      request.addEventListener('upgradeneeded', () => {
        const store = request.result.createObjectStore(STORE, { keyPath: 'tweetId' })
        store.createIndex('by_conversation', 'conversationId')
        store.createIndex('by_capturedAt', 'capturedAt')
      })
      request.addEventListener('success', () => resolve(request.result))
      request.addEventListener('error', () => reject(request.error))
    })
    return dbPromise
  }

  return {
    upsert(records, merge) {
      return openDb().then(
        (db) =>
          new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite')
            const store = tx.objectStore(STORE)
            for (const incoming of records) {
              const get = store.get(incoming.tweetId)
              get.addEventListener('success', () => {
                const existing = decodeRecords([get.result])[0]
                const winner = merge(existing, incoming)
                // A corrupt row decodes to no existing record, so this put
                // replaces it with the incoming canonical snapshot.
                if (winner !== existing) store.put(winner)
              })
            }
            tx.addEventListener('complete', () => resolve())
            tx.addEventListener('error', () => reject(tx.error))
            tx.addEventListener('abort', () => reject(tx.error))
          }),
      )
    },
    async allRecords() {
      const db = await openDb()
      return decodeRecords(
        await promisify(db.transaction(STORE, 'readonly').objectStore(STORE).getAll()),
      )
    },
    async page(afterTweetId, limit) {
      const db = await openDb()
      const request = db
        .transaction(STORE, 'readonly')
        .objectStore(STORE)
        .openCursor(
          afterTweetId === undefined ? undefined : IDBKeyRange.lowerBound(afterTweetId, true),
        )
      const rows: TweetRecord[] = []
      return new Promise((resolve, reject) => {
        request.addEventListener('success', () => {
          const cursor = request.result
          if (cursor === null) {
            resolve(rows)
            return
          }
          const record = decodeRecords([cursor.value])[0]
          if (record !== undefined) rows.push(record)
          if (rows.length >= limit) {
            resolve(rows)
            return
          }
          cursor.continue()
        })
        request.addEventListener('error', () => reject(request.error))
      })
    },
    async conversationPage(conversationId, afterTweetId, limit) {
      const db = await openDb()
      const request = db
        .transaction(STORE, 'readonly')
        .objectStore(STORE)
        .index('by_conversation')
        .openCursor(IDBKeyRange.only(conversationId))
      const rows: TweetRecord[] = []
      return new Promise((resolve, reject) => {
        request.addEventListener('success', () => {
          const cursor = request.result
          if (cursor === null) {
            resolve(rows)
            return
          }
          if (afterTweetId !== undefined) {
            const primaryKeyOrder = indexedDB.cmp(cursor.primaryKey, afterTweetId)
            if (primaryKeyOrder < 0) {
              cursor.continuePrimaryKey(conversationId, afterTweetId)
              return
            }
            if (primaryKeyOrder === 0) {
              cursor.continue()
              return
            }
          }
          const record = decodeRecords([cursor.value])[0]
          if (record !== undefined) rows.push(record)
          if (rows.length >= limit) {
            resolve(rows)
            return
          }
          cursor.continue()
        })
        request.addEventListener('error', () => reject(request.error))
      })
    },
    async get(tweetId) {
      const db = await openDb()
      const value = await promisify(
        db.transaction(STORE, 'readonly').objectStore(STORE).get(tweetId),
      )
      return decodeRecords([value])[0]
    },
    async fold(init, step) {
      const db = await openDb()
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor()
      let acc = init
      return new Promise((resolve, reject) => {
        request.addEventListener('success', () => {
          const cursor = request.result
          if (cursor === null) {
            resolve(acc)
            return
          }
          const record = decodeRecords([cursor.value])[0]
          if (record !== undefined) acc = step(acc, record)
          cursor.continue()
        })
        request.addEventListener('error', () => reject(request.error))
      })
    },
    async conversation(id) {
      const db = await openDb()
      const index = db.transaction(STORE, 'readonly').objectStore(STORE).index('by_conversation')
      return decodeRecords(await promisify(index.getAll(id)))
    },
    async count() {
      const db = await openDb()
      return promisify(db.transaction(STORE, 'readonly').objectStore(STORE).count())
    },
    async clear() {
      const db = await openDb()
      await promisify(db.transaction(STORE, 'readwrite').objectStore(STORE).clear())
    },
  }
}
