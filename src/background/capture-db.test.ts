import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { makeCaptureDb, type CaptureStore } from './capture-db'
import type { TweetRecord } from '../core/capture/record'

const mk = (tweetId: string, opts: Partial<TweetRecord> = {}): TweetRecord => ({
  tweetId,
  conversationId: tweetId,
  author: { handle: 'alice' },
  text: '',
  rawText: '',
  links: [],
  media: [],
  mentions: [],
  hashtags: [],
  source: 'timeline',
  sourceRank: 1,
  capturedAt: 1000,
  ...opts,
})

const largeTweetId = (index: number): string => String(1_800_000_000_000_000_000n + BigInt(index))

/** In-memory stand-in for the IndexedDB store: `upsert` applies the same
 *  read-merge-write the real adapter does, so merge-on-write is exercised
 *  through `makeCaptureDb` without IndexedDB. */
function fakeStore(): CaptureStore & { rows: Map<string, TweetRecord>; upsertCalls: number } {
  const rows = new Map<string, TweetRecord>()
  const box = {
    rows,
    upsertCalls: 0,
    async upsert(
      records: ReadonlyArray<TweetRecord>,
      merge: (existing: TweetRecord | undefined, incoming: TweetRecord) => TweetRecord,
    ) {
      box.upsertCalls++
      for (const incoming of records) {
        const existing = rows.get(incoming.tweetId)
        const winner = merge(existing, incoming)
        if (winner !== existing) rows.set(incoming.tweetId, winner)
      }
    },
    async allRecords() {
      return [...rows.values()]
    },
    async page(afterTweetId: string | undefined, limit: number) {
      return [...rows.values()]
        .toSorted((a, b) => a.tweetId.localeCompare(b.tweetId))
        .filter((row) => afterTweetId === undefined || row.tweetId > afterTweetId)
        .slice(0, limit)
    },
    async conversationPage(
      conversationId: string,
      afterTweetId: string | undefined,
      limit: number,
    ) {
      return [...rows.values()]
        .filter((row) => row.conversationId === conversationId)
        .toSorted((a, b) => a.tweetId.localeCompare(b.tweetId))
        .filter((row) => afterTweetId === undefined || row.tweetId > afterTweetId)
        .slice(0, limit)
    },
    async get(tweetId: string) {
      return rows.get(tweetId)
    },
    async fold<A>(init: A, step: (acc: A, record: TweetRecord) => A) {
      let acc = init
      for (const r of rows.values()) acc = step(acc, r)
      return acc
    },
    async conversation(id: string) {
      return [...rows.values()].filter((r) => r.conversationId === id)
    },
    async count() {
      return rows.size
    },
    async clear() {
      rows.clear()
    },
  }
  return box
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result))
    request.addEventListener('error', () => reject(request.error))
  })
}

async function seedCaptureIndexedDb(
  factory: IDBFactory,
  rows: ReadonlyArray<unknown>,
): Promise<void> {
  const opening = factory.open('xmd-capture', 1)
  opening.addEventListener('upgradeneeded', () => {
    const store = opening.result.createObjectStore('tweets', { keyPath: 'tweetId' })
    store.createIndex('by_conversation', 'conversationId')
    store.createIndex('by_capturedAt', 'capturedAt')
  })
  const database = await requestResult(opening)
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction('tweets', 'readwrite')
    for (const row of rows) tx.objectStore('tweets').put(row)
    tx.addEventListener('complete', () => resolve())
    tx.addEventListener('error', () => reject(tx.error))
    tx.addEventListener('abort', () => reject(tx.error))
  })
  database.close()
}

function installCaptureIndexedDb(): IDBFactory {
  const factory = new IDBFactory()
  vi.stubGlobal('indexedDB', factory)
  vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  return factory
}

interface IndexedDbProbe {
  readonly continuedFrom: string[]
  readonly indexNames: string[]
  readonly ranges: string[]
}

function installIndexedDbProbe(rows: ReadonlyArray<TweetRecord>): IndexedDbProbe {
  type Listener = () => void
  class Request<T> {
    result!: T
    error: DOMException | null = null
    readonly listeners = new Map<string, Listener[]>()

    addEventListener(type: string, listener: Listener): void {
      const listeners = this.listeners.get(type) ?? []
      listeners.push(listener)
      this.listeners.set(type, listeners)
    }

    succeed(result: T): void {
      this.result = result
      queueMicrotask(() => {
        for (const listener of this.listeners.get('success') ?? []) listener()
      })
    }
  }

  const probe: IndexedDbProbe = { continuedFrom: [], indexNames: [], ranges: [] }
  const indexRows = rows.toSorted((a, b) => {
    const conversationOrder = a.conversationId.localeCompare(b.conversationId)
    return conversationOrder === 0 ? a.tweetId.localeCompare(b.tweetId) : conversationOrder
  })
  const index = {
    openCursor(range: { only: string }) {
      probe.ranges.push(range.only)
      const matching = indexRows.filter((row) => row.conversationId === range.only)
      const request = new Request<IDBCursorWithValue | null>()
      let position = 0
      const publish = (): void => {
        const row = matching[position]
        if (row === undefined) {
          request.succeed(null)
          return
        }
        request.succeed({
          value: row,
          primaryKey: row.tweetId,
          continue: () => {
            position++
            publish()
          },
          continuePrimaryKey: (_key: IDBValidKey, primaryKey: IDBValidKey) => {
            probe.continuedFrom.push(String(primaryKey))
            position = matching.findIndex((candidate) => candidate.tweetId >= primaryKey)
            if (position < 0) position = matching.length
            publish()
          },
        } as IDBCursorWithValue)
      }
      publish()
      return request as unknown as IDBRequest<IDBCursorWithValue | null>
    },
  }
  const database = {
    transaction() {
      return {
        objectStore() {
          return {
            index(name: string) {
              probe.indexNames.push(name)
              return index
            },
          }
        },
      }
    },
  }
  vi.stubGlobal('IDBKeyRange', { only: (value: string) => ({ only: value }) })
  vi.stubGlobal('indexedDB', {
    cmp: (left: IDBValidKey, right: IDBValidKey) => String(left).localeCompare(String(right)),
    open: () => {
      const request = new Request<IDBDatabase>()
      request.succeed(database as unknown as IDBDatabase)
      return request as unknown as IDBOpenDBRequest
    },
  })
  return probe
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('makeCaptureDb', () => {
  it('persists a batch — count and allRecords reflect it', async () => {
    const db = makeCaptureDb({ store: fakeStore() })

    await db.putRecords([mk('1'), mk('2')])

    expect(await db.count()).toBe(2)
    expect((await db.allRecords()).map((r) => r.tweetId).toSorted()).toEqual(['1', '2'])
  })

  it('putRecords([]) is a no-op — it never touches the store', async () => {
    const store = fakeStore()
    const db = makeCaptureDb({ store })

    await db.putRecords([])

    expect(store.upsertCalls).toBe(0)
    expect(await db.count()).toBe(0)
  })

  it('merges on write — a richer tweetDetail replaces a stored timeline record', async () => {
    const db = makeCaptureDb({ store: fakeStore() })

    await db.putRecords([mk('1', { source: 'timeline', sourceRank: 1, text: 'thin' })])
    await db.putRecords([mk('1', { source: 'tweetDetail', sourceRank: 2, text: 'rich' })])

    expect(await db.count()).toBe(1)
    expect((await db.allRecords())[0]?.text).toBe('rich')
  })

  it('merges on write — a later thin sighting never clobbers a richer one', async () => {
    const db = makeCaptureDb({ store: fakeStore() })

    await db.putRecords([
      mk('1', { source: 'tweetDetail', sourceRank: 2, text: 'rich', capturedAt: 1000 }),
    ])
    await db.putRecords([
      mk('1', { source: 'timeline', sourceRank: 1, text: 'thin', capturedAt: 5000 }),
    ])

    expect((await db.allRecords())[0]?.text).toBe('rich')
  })

  it('folds duplicate ids within one batch before the store read-modify-write', async () => {
    const db = makeCaptureDb({ store: fakeStore() })

    await db.putRecords([
      mk('1', { source: 'tweetDetail', sourceRank: 2, text: 'rich' }),
      mk('1', { source: 'timeline', sourceRank: 1, text: 'thin', capturedAt: 5000 }),
    ])

    expect(await db.allRecords()).toEqual([
      expect.objectContaining({ tweetId: '1', text: 'rich', source: 'tweetDetail' }),
    ])
  })

  it('conversation(id) returns only that thread', async () => {
    const db = makeCaptureDb({ store: fakeStore() })

    await db.putRecords([
      mk('1', { conversationId: '101' }),
      mk('2', { conversationId: '101' }),
      mk('3', { conversationId: '102' }),
    ])

    expect((await db.conversation('101')).map((r) => r.tweetId).toSorted()).toEqual(['1', '2'])
  })

  it('clear empties the store', async () => {
    const db = makeCaptureDb({ store: fakeStore() })

    await db.putRecords([mk('1')])
    await db.clear()

    expect(await db.count()).toBe(0)
  })

  it('salvages healthy rows and Erase counts every physical row', async () => {
    const factory = installCaptureIndexedDb()
    const first = mk('1', { conversationId: '101' })
    const corrupt = { tweetId: '2', conversationId: '101' }
    const last = mk('3', { conversationId: '101' })
    await seedCaptureIndexedDb(factory, [first, corrupt, last])
    const db = makeCaptureDb()

    expect(await db.allRecords()).toEqual([first, last])
    expect(await db.conversation('101')).toEqual([first, last])
    expect(await db.fold<string[]>([], (ids, row) => [...ids, row.tweetId])).toEqual(['1', '3'])
    await db.withReadSnapshot(async (read) => {
      expect(await read.page()).toEqual([first, last])
      expect(await read.conversationPage('101')).toEqual([first, last])
      expect(await read.get('2')).toBeUndefined()
    })

    expect(await db.count()).toBe(3)
    await expect(db.clearAndCount()).resolves.toBe(3)
    await expect(db.count()).resolves.toBe(0)
  })

  it('self-heals a corrupt same-key row from canonical capture ingress', async () => {
    const factory = installCaptureIndexedDb()
    await seedCaptureIndexedDb(factory, [{ tweetId: '2', conversationId: '101' }])
    const canonical = mk('2', { conversationId: '101', text: 'recovered' })
    const db = makeCaptureDb()

    await db.putRecords([canonical])

    await expect(db.count()).resolves.toBe(1)
    await db.withReadSnapshot(async (read) => {
      expect(await read.get('2')).toEqual(canonical)
    })
  })

  it('clearAndCount is one FIFO write: it counts exactly its removal and keeps a later put', async () => {
    const firstWrite = deferred()
    const rows = new Map<string, TweetRecord>()
    let removed: string[] = []
    const store: CaptureStore = {
      async upsert(records, merge) {
        if (records[0]?.tweetId === '1001') await firstWrite.promise
        for (const incoming of records) {
          const existing = rows.get(incoming.tweetId)
          const winner = merge(existing, incoming)
          if (winner !== existing) rows.set(incoming.tweetId, winner)
        }
      },
      async allRecords() {
        return [...rows.values()]
      },
      async page(afterTweetId, limit) {
        return [...rows.values()]
          .toSorted((a, b) => a.tweetId.localeCompare(b.tweetId))
          .filter((row) => afterTweetId === undefined || row.tweetId > afterTweetId)
          .slice(0, limit)
      },
      async conversationPage(conversationId, afterTweetId, limit) {
        return [...rows.values()]
          .filter((row) => row.conversationId === conversationId)
          .toSorted((a, b) => a.tweetId.localeCompare(b.tweetId))
          .filter((row) => afterTweetId === undefined || row.tweetId > afterTweetId)
          .slice(0, limit)
      },
      async get(tweetId) {
        return rows.get(tweetId)
      },
      async fold<A>(init: A, step: (acc: A, record: TweetRecord) => A) {
        let acc = init
        for (const row of rows.values()) acc = step(acc, row)
        return acc
      },
      async conversation(id) {
        return [...rows.values()].filter((row) => row.conversationId === id)
      },
      async count() {
        return rows.size
      },
      async clear() {
        removed = [...rows.keys()]
        rows.clear()
      },
    }
    const db = makeCaptureDb({ store })

    const before = db.putRecords([mk('1001')])
    const clearing = db.clearAndCount()
    const after = db.putRecords([mk('1002')])
    firstWrite.resolve()

    const cleared = await clearing
    expect(cleared).toBe(removed.length)
    expect(removed).toEqual(['1001'])
    await Promise.all([before, after])
    expect((await db.allRecords()).map((row) => row.tweetId)).toEqual(['1002'])
  })

  it('holds a stable paged read snapshot ahead of later writes', async () => {
    const store = fakeStore()
    const db = makeCaptureDb({ store })
    await db.putRecords([mk('1'), mk('2'), mk('3')])
    const reading = deferred()
    const resume = deferred()

    const snapshot = db.withReadSnapshot(async (read) => {
      expect((await read.page()).map((row) => row.tweetId)).toEqual(['1', '2', '3'])
      expect((await read.get('2'))?.tweetId).toBe('2')
      reading.resolve()
      await resume.promise
      return (await read.conversationPage('3', '2')).map((row) => row.tweetId)
    })
    await reading.promise

    const laterWrite = db.putRecords([mk('4', { conversationId: '3' })])
    await Promise.resolve()
    expect(store.rows.has('4')).toBe(false)
    resume.resolve()

    await expect(snapshot).resolves.toEqual(['3'])
    await laterWrite
    expect(store.rows.has('4')).toBe(true)
  })

  it('pages one conversation through its index with a bounded primary-key continuation', async () => {
    const target = Array.from({ length: 130 }, (_, index) =>
      mk(largeTweetId(index), { conversationId: '7000' }),
    )
    const probe = installIndexedDbProbe([...target, mk('9001', { conversationId: '8000' })])
    const db = makeCaptureDb()

    await db.withReadSnapshot(async (read) => {
      const first = await read.conversationPage('7000')
      const second = await read.conversationPage('7000', first.at(-1)?.tweetId)

      expect(first).toHaveLength(128)
      expect(first[0]?.tweetId).toBe(largeTweetId(0))
      expect(first.at(-1)?.tweetId).toBe(largeTweetId(127))
      expect(second.map((row) => row.tweetId)).toEqual([largeTweetId(128), largeTweetId(129)])
    })
    expect(probe.indexNames).toEqual(['by_conversation', 'by_conversation'])
    expect(probe.ranges).toEqual(['7000', '7000'])
    expect(probe.continuedFrom).toEqual([largeTweetId(127)])
  })
})
