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
import { mergeRecord } from '../core/capture/store'
import type { TweetRecord } from '../core/capture/record'
import { makeSerialQueue } from '../core/serial-queue'

/** Per-record write policy: richer source wins (spec §6.4, {@link mergeRecord}). */
type Merge = (existing: TweetRecord | undefined, incoming: TweetRecord) => TweetRecord

/**
 * Persistence seam for the harvest. The default adapter is IndexedDB; tests
 * supply an in-memory stand-in. `upsert` is atomic per call: for each record it
 * reads the stored row, applies `merge`, and writes the winner.
 */
export interface CaptureStore {
  upsert(records: ReadonlyArray<TweetRecord>, merge: Merge): Promise<void>
  allRecords(): Promise<TweetRecord[]>
  /** Stream every record through `step` (cursor-driven for IndexedDB) — an
   *  aggregate pass that never materializes the whole store in memory. */
  fold<A>(init: A, step: (acc: A, record: TweetRecord) => A): Promise<A>
  conversation(id: string): Promise<TweetRecord[]>
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
  count(): Promise<number>
  clear(): Promise<void>
}

export function makeCaptureDb(deps: { store?: CaptureStore } = {}): CaptureDb {
  const store = deps.store ?? makeIndexedDbStore()
  const writes = makeSerialQueue()
  return {
    putRecords: (records) =>
      writes.run(async () => {
        if (records.length === 0) return
        await store.upsert(records, mergeRecord)
      }),
    allRecords: () => store.allRecords(),
    fold: (init, step) => store.fold(init, step),
    conversation: (id) => store.conversation(id),
    count: () => store.count(),
    clear: () => writes.run(() => store.clear()),
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
                const existing = get.result as TweetRecord | undefined
                const winner = merge(existing, incoming)
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
      return promisify(db.transaction(STORE, 'readonly').objectStore(STORE).getAll())
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
          acc = step(acc, cursor.value as TweetRecord)
          cursor.continue()
        })
        request.addEventListener('error', () => reject(request.error))
      })
    },
    async conversation(id) {
      const db = await openDb()
      const index = db.transaction(STORE, 'readonly').objectStore(STORE).index('by_conversation')
      return promisify(index.getAll(id))
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
