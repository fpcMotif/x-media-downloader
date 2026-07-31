import { describe, it, expect } from 'vitest'
import { makeCaptureDb, type CaptureStore } from './capture-db'
import type { TweetRecord } from '@/packages/capture/record'

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

  it('conversation(id) returns only that thread', async () => {
    const db = makeCaptureDb({ store: fakeStore() })

    await db.putRecords([
      mk('1', { conversationId: 'c1' }),
      mk('2', { conversationId: 'c1' }),
      mk('3', { conversationId: 'c2' }),
    ])

    expect((await db.conversation('c1')).map((r) => r.tweetId).toSorted()).toEqual(['1', '2'])
  })

  it('clear empties the store', async () => {
    const db = makeCaptureDb({ store: fakeStore() })

    await db.putRecords([mk('1')])
    await db.clear()

    expect(await db.count()).toBe(0)
  })
})
