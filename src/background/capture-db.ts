/**
 * Durable source of truth for harvested tweets (spec §8). A thin IndexedDB
 * wrapper over DB `xmd-capture`, store `tweets` (keyPath `tweetId`), funneling
 * every write through one {@link makeSerialQueue} so interleaved batches share
 * the RMW discipline used by download history. IndexedDB needs the
 * `unlimitedStorage` manifest permission (wired separately) so the harvest is
 * not evicted under storage pressure.
 */
import { mergeRecord } from '../core/capture/store'
import type { TweetRecord } from '../core/capture/record'
import { makeSerialQueue } from '../core/serial-queue'

const DB_NAME = 'xmd-capture'
const STORE = 'tweets'
const VERSION = 1

const writes = makeSerialQueue()

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

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result))
    request.addEventListener('error', () => reject(request.error))
  })
}

export function putRecords(records: ReadonlyArray<TweetRecord>): Promise<void> {
  return writes.run(async () => {
    if (records.length === 0) return
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      const store = tx.objectStore(STORE)
      for (const incoming of records) {
        const get = store.get(incoming.tweetId)
        get.addEventListener('success', () => {
          const existing = get.result as TweetRecord | undefined
          const winner = mergeRecord(existing, incoming)
          if (winner !== existing) store.put(winner)
        })
      }
      tx.addEventListener('complete', () => resolve())
      tx.addEventListener('error', () => reject(tx.error))
      tx.addEventListener('abort', () => reject(tx.error))
    })
  })
}

export async function allRecords(): Promise<TweetRecord[]> {
  const db = await openDb()
  return promisify(db.transaction(STORE, 'readonly').objectStore(STORE).getAll())
}

export async function conversation(id: string): Promise<TweetRecord[]> {
  const db = await openDb()
  const index = db.transaction(STORE, 'readonly').objectStore(STORE).index('by_conversation')
  return promisify(index.getAll(id))
}

export async function count(): Promise<number> {
  const db = await openDb()
  return promisify(db.transaction(STORE, 'readonly').objectStore(STORE).count())
}

export function clear(): Promise<void> {
  return writes.run(async () => {
    const db = await openDb()
    await promisify(db.transaction(STORE, 'readwrite').objectStore(STORE).clear())
  })
}
