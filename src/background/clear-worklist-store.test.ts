import { describe, expect, it, vi } from 'vitest'
import { makeClearWorklistStore, type ClearWorklistStorage } from './clear-worklist-store'
import {
  SWEEP_WORKLIST_STORE_VERSION,
  type StoredSweepWorklist,
  type SweepWorklist,
} from '../core/clear/worklist'

const entry = (
  tweetId: string,
  scope: 'bookmark' | 'like',
  state: 'queued' | 'downloaded' | 'cleared' | 'failed',
  at = 1,
  projectionRevision?: number,
) => ({
  tweetId,
  scope,
  state,
  at,
  ...(projectionRevision === undefined ? {} : { projectionRevision }),
})

const stored = (entries: SweepWorklist): StoredSweepWorklist => ({
  version: SWEEP_WORKLIST_STORE_VERSION,
  entries,
})

const storedEntries = (value: unknown): SweepWorklist => (value as StoredSweepWorklist).entries

function fakeStorage(
  initial: unknown = null,
): ClearWorklistStorage & { value: unknown; writes: unknown[] } {
  const box = {
    value: initial,
    writes: [] as unknown[],
    async get() {
      return box.value
    },
    async set(value: StoredSweepWorklist) {
      box.value = value
      box.writes.push(value)
    },
  }
  return box
}

const deferred = <T = void>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('makeClearWorklistStore', () => {
  it('selects pending sweep posts without claiming them before Clear seed', async () => {
    const storage = fakeStorage(stored({ 'bookmark:1': entry('1', 'bookmark', 'cleared') }))
    const store = makeClearWorklistStore({ storage })
    const pending = { tweetId: '2', items: ['item'] }

    await expect(
      store.selectSweepPosts('bookmark', [{ tweetId: '1', items: ['skip'] }, pending]),
    ).resolves.toEqual({ posts: [pending], skipped: 1 })
    expect(storage.writes).toEqual([])
  })

  it('claims only seeded tweets not already cleared in this scope', async () => {
    const storage = fakeStorage(stored({ 'bookmark:1': entry('1', 'bookmark', 'cleared') }))
    const store = makeClearWorklistStore({ storage, now: () => 42 })
    const result = await store.claimSeededSweepPosts('bookmark', ['1', '2'], 1)

    expect(result).toEqual({ claimed: 1, skipped: 1, terminalTweetIds: ['1'] })
    expect(storage.value).toEqual(
      stored({
        'bookmark:1': entry('1', 'bookmark', 'cleared'),
        'bookmark:2': entry('2', 'bookmark', 'queued', 42, 1),
      }),
    )
  })

  it('does not let a clear in one scope skip the other scope', async () => {
    const storage = fakeStorage(stored({ 'bookmark:1': entry('1', 'bookmark', 'cleared') }))
    const store = makeClearWorklistStore({ storage, now: () => 42 })

    await expect(store.claimSeededSweepPosts('like', ['1'], 1)).resolves.toEqual({
      claimed: 1,
      skipped: 0,
      terminalTweetIds: [],
    })

    expect(storage.value).toEqual(
      stored({
        'bookmark:1': entry('1', 'bookmark', 'cleared'),
        'like:1': entry('1', 'like', 'queued', 42, 1),
      }),
    )
  })

  it('rebuilds missing rows from durable projections and never regresses cleared', async () => {
    const storage = fakeStorage(
      stored({
        'bookmark:1': entry('1', 'bookmark', 'queued'),
        'like:1': entry('1', 'like', 'cleared'),
      }),
    )
    const store = makeClearWorklistStore({ storage, now: () => 42 })

    await store.applyProjection({
      version: 1,
      revision: 1,
      tweetId: '1',
      scope: 'bookmark',
      state: 'downloaded',
      at: 42,
    })
    await store.applyProjection({
      version: 1,
      revision: 1,
      tweetId: '1',
      scope: 'like',
      state: 'downloaded',
      at: 42,
    })
    await store.applyProjection({
      version: 1,
      revision: 1,
      tweetId: '2',
      scope: 'bookmark',
      state: 'failed',
      at: 42,
    })

    expect(storage.value).toEqual(
      stored({
        'bookmark:1': entry('1', 'bookmark', 'downloaded', 42, 1),
        'like:1': entry('1', 'like', 'cleared'),
        'bookmark:2': entry('2', 'bookmark', 'failed', 42, 1),
      }),
    )
    expect(storage.writes).toHaveLength(2)
  })

  it('does not resolve applyProjection before its write persists', async () => {
    const storage = fakeStorage(stored({ 'bookmark:1': entry('1', 'bookmark', 'queued') }))
    const write = deferred()
    storage.set = vi.fn<ClearWorklistStorage['set']>(() => write.promise)
    const store = makeClearWorklistStore({ storage })
    let settled = false
    const done = store
      .applyProjection({
        version: 1,
        revision: 1,
        tweetId: '1',
        scope: 'bookmark',
        state: 'downloaded',
        at: 42,
      })
      .then(() => (settled = true))

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    write.resolve()
    await done
    expect(settled).toBe(true)
  })

  it('retains an old reconstructed projection when terminal history is full', async () => {
    const storage = fakeStorage(
      stored(
        Object.fromEntries(
          Array.from({ length: 5000 }, (_, index) => {
            const tweetId = String(index + 1000)
            return [`bookmark:${tweetId}`, entry(tweetId, 'bookmark', 'cleared', index + 100)]
          }),
        ),
      ),
    )
    const store = makeClearWorklistStore({ storage })

    await expect(
      store.applyProjection({
        version: 1,
        revision: 1,
        tweetId: '1',
        scope: 'bookmark',
        state: 'failed',
        at: 1,
      }),
    ).resolves.toBe('applied')

    const value = storedEntries(storage.value)
    expect(Object.keys(value)).toHaveLength(5000)
    expect(value['bookmark:1']).toEqual(entry('1', 'bookmark', 'failed', 1, 1))
  })

  it('ignores a projection older than the claimed Clear revision despite clock rollback', async () => {
    const storage = fakeStorage(stored({ 'bookmark:1': entry('1', 'bookmark', 'queued', 5, 2) }))
    const store = makeClearWorklistStore({ storage })

    await expect(
      store.applyProjection({
        version: 1,
        revision: 1,
        tweetId: '1',
        scope: 'bookmark',
        state: 'failed',
        at: 50,
      }),
    ).resolves.toBe('already-applied')

    expect(storage.writes).toEqual([])
    expect(storage.value).toEqual(stored({ 'bookmark:1': entry('1', 'bookmark', 'queued', 5, 2) }))
  })

  it('lets terminal cleared evidence dominate a later queued timestamp', async () => {
    const storage = fakeStorage(stored({ 'bookmark:1': entry('1', 'bookmark', 'queued', 50) }))
    const store = makeClearWorklistStore({ storage })

    await expect(
      store.applyProjection({
        version: 1,
        revision: 1,
        tweetId: '1',
        scope: 'bookmark',
        state: 'cleared',
        at: 49,
      }),
    ).resolves.toBe('applied')

    expect(storage.value).toEqual(
      stored({ 'bookmark:1': entry('1', 'bookmark', 'cleared', 49, 1) }),
    )
  })

  it('retains the applied revision across requeue and rejects ack replay', async () => {
    const storage = fakeStorage(stored({ 'bookmark:1': entry('1', 'bookmark', 'queued', 1) }))
    const store = makeClearWorklistStore({ storage, now: () => 20 })
    const failed = {
      version: 1 as const,
      revision: 5,
      tweetId: '1',
      scope: 'bookmark' as const,
      state: 'failed' as const,
      at: 10,
    }
    await store.applyProjection(failed)
    await store.claimSeededSweepPosts('bookmark', ['1'], 6)

    await expect(store.applyProjection(failed)).resolves.toBe('already-applied')
    expect(storage.value).toEqual(stored({ 'bookmark:1': entry('1', 'bookmark', 'queued', 20, 6) }))
  })

  it('ignores a delayed seeded claim after a causally newer projection', async () => {
    const raw = stored({ 'bookmark:1': entry('1', 'bookmark', 'failed', 20, 7) })
    const storage = fakeStorage(raw)
    const store = makeClearWorklistStore({ storage, now: () => 30 })

    await expect(store.claimSeededSweepPosts('bookmark', ['1'], 6)).resolves.toEqual({
      claimed: 0,
      skipped: 1,
      terminalTweetIds: [],
    })

    expect(storage.value).toBe(raw)
    expect(storage.writes).toEqual([])
  })

  it('boot repair replays a missed claim but preserves a causally newer terminal row', async () => {
    const storage = fakeStorage(stored({ 'bookmark:1': entry('1', 'bookmark', 'failed', 5, 4) }))
    const store = makeClearWorklistStore({ storage, now: () => 20 })

    await store.ensureSeededSweepPosts('bookmark', ['1', '2'], 6)

    expect(storage.value).toEqual(
      stored({
        'bookmark:1': entry('1', 'bookmark', 'queued', 20, 6),
        'bookmark:2': entry('2', 'bookmark', 'queued', 20, 6),
      }),
    )

    await store.applyProjection({
      version: 1,
      tweetId: '1',
      scope: 'bookmark',
      state: 'failed',
      at: 21,
      revision: 7,
    })
    await store.ensureSeededSweepPosts('bookmark', ['1'], 6)
    expect(storedEntries(storage.value)['bookmark:1']).toEqual(
      entry('1', 'bookmark', 'failed', 21, 7),
    )
  })

  it('serializes fresh read-modify-writes without losing concurrent updates', async () => {
    const storage = fakeStorage()
    const store = makeClearWorklistStore({ storage, now: () => 42 })

    await Promise.all([
      store.claimSeededSweepPosts('bookmark', ['1'], 1),
      store.claimSeededSweepPosts('like', ['2'], 1),
    ])

    expect(storage.value).toEqual(
      stored({
        'bookmark:1': entry('1', 'bookmark', 'queued', 42, 1),
        'like:2': entry('2', 'like', 'queued', 42, 1),
      }),
    )
  })

  it('caps terminal history at 5000 without evicting queued work', async () => {
    const initial = stored(
      Object.fromEntries(
        Array.from({ length: 5000 }, (_, i) => {
          const tweetId = String(i + 1000)
          return [`bookmark:${tweetId}`, entry(tweetId, 'bookmark', 'cleared', i)]
        }),
      ),
    )
    const storage = fakeStorage(initial)
    const store = makeClearWorklistStore({ storage, now: () => 6000 })

    await store.claimSeededSweepPosts('bookmark', ['1'], 1)

    const value = storedEntries(storage.value)
    expect(Object.keys(value)).toHaveLength(5000)
    expect(value['bookmark:1000']).toBeUndefined()
    expect(value['bookmark:1']).toEqual(entry('1', 'bookmark', 'queued', 6000, 1))
  })

  it('propagates a storage failure and remains usable after it', async () => {
    const storage = fakeStorage()
    const error = new Error('storage unavailable')
    const onError = vi.fn<(error: unknown) => void>()
    const originalSet = storage.set
    storage.set = vi
      .fn<ClearWorklistStorage['set']>()
      .mockRejectedValueOnce(error)
      .mockImplementation(originalSet)
    const store = makeClearWorklistStore({ storage, onError, now: () => 42 })

    await expect(store.claimSeededSweepPosts('bookmark', ['1'], 1)).rejects.toBe(error)
    await expect(store.claimSeededSweepPosts('bookmark', ['2'], 1)).resolves.toEqual({
      claimed: 1,
      skipped: 0,
      terminalTweetIds: [],
    })
    expect(onError).toHaveBeenCalledWith(error)
    expect(storage.value).toEqual(stored({ 'bookmark:2': entry('2', 'bookmark', 'queued', 42, 1) }))
  })

  it('quarantines corrupt storage across every read and write path', async () => {
    const raw = {
      version: 2,
      entries: {
        'bookmark:1': { ...entry('1', 'bookmark', 'queued'), extra: true },
      },
    }
    const storage = fakeStorage(raw)
    const store = makeClearWorklistStore({ storage })
    const projection = {
      version: 1 as const,
      revision: 1,
      tweetId: '1',
      scope: 'bookmark' as const,
      state: 'failed' as const,
      at: 1,
    }

    await expect(store.selectSweepPosts('bookmark', [{ tweetId: '1', items: [] }])).rejects.toThrow(
      /corrupt/i,
    )
    await expect(store.claimSeededSweepPosts('bookmark', ['1'], 1)).rejects.toThrow(/corrupt/i)
    await expect(store.ensureSeededSweepPosts('bookmark', ['1'], 1)).rejects.toThrow(/corrupt/i)
    await expect(store.applyProjection(projection)).rejects.toThrow(/corrupt/i)
    expect(storage.value).toBe(raw)
    expect(storage.writes).toEqual([])
  })

  it('migrates a safe legacy map on the next write and writes only v2', async () => {
    const storage = fakeStorage({
      '1': entry('1', 'bookmark', 'cleared'),
    })
    const store = makeClearWorklistStore({ storage, now: () => 42 })

    await store.claimSeededSweepPosts('bookmark', ['2'], 1)

    expect(storage.value).toEqual(
      stored({
        'bookmark:1': entry('1', 'bookmark', 'cleared'),
        'bookmark:2': entry('2', 'bookmark', 'queued', 42, 1),
      }),
    )
  })

  it('rejects invalid seeded snowflakes before reading storage', async () => {
    const storage = fakeStorage()
    storage.get = vi.fn<ClearWorklistStorage['get']>(() =>
      Promise.reject(new Error('storage must not be read')),
    )
    const store = makeClearWorklistStore({ storage })

    await expect(store.claimSeededSweepPosts('bookmark', ['bad-id'], 1)).rejects.toThrow(
      /snowflake/i,
    )
    await expect(store.ensureSeededSweepPosts('bookmark', ['bad-id'], 1)).rejects.toThrow(
      /snowflake/i,
    )
    expect(storage.get).not.toHaveBeenCalled()
  })

  it('rejects a claim batch atomically before active capacity', async () => {
    const active = Object.fromEntries(
      Array.from({ length: 4999 }, (_, index) => {
        const tweetId = String(index + 1000)
        return [`bookmark:${tweetId}`, entry(tweetId, 'bookmark', 'queued')]
      }),
    )
    const raw = stored(active)
    const storage = fakeStorage(raw)
    const store = makeClearWorklistStore({ storage })

    await expect(store.claimSeededSweepPosts('bookmark', ['1', '2'], 1)).rejects.toThrow(
      /capacity/i,
    )
    expect(storage.value).toBe(raw)
    expect(storage.writes).toEqual([])
  })

  it('rejects boot repair atomically before active capacity', async () => {
    const active = Object.fromEntries(
      Array.from({ length: 5000 }, (_, index) => {
        const tweetId = String(index + 1000)
        return [`bookmark:${tweetId}`, entry(tweetId, 'bookmark', 'downloaded')]
      }),
    )
    const raw = stored(active)
    const storage = fakeStorage(raw)
    const store = makeClearWorklistStore({ storage })

    await expect(store.ensureSeededSweepPosts('bookmark', ['1'], 1)).rejects.toThrow(/capacity/i)
    expect(storage.value).toBe(raw)
    expect(storage.writes).toEqual([])
  })

  it.each(['downloaded', 'failed'] as const)(
    'rejects a missing %s projection atomically at active capacity',
    async (state) => {
      const active = Object.fromEntries(
        Array.from({ length: 5000 }, (_, index) => {
          const tweetId = String(index + 1000)
          return [`bookmark:${tweetId}`, entry(tweetId, 'bookmark', 'queued')]
        }),
      )
      const raw = stored(active)
      const storage = fakeStorage(raw)
      const store = makeClearWorklistStore({ storage })

      await expect(
        store.applyProjection({
          version: 1,
          revision: 1,
          tweetId: '1',
          scope: 'bookmark',
          state,
          at: 1,
        }),
      ).rejects.toThrow(/capacity/i)
      expect(storage.value).toBe(raw)
      expect(storage.writes).toEqual([])
    },
  )

  it('allows an existing active row to become terminal at capacity', async () => {
    const active = Object.fromEntries(
      Array.from({ length: 5000 }, (_, index) => {
        const tweetId = String(index + 1000)
        return [`bookmark:${tweetId}`, entry(tweetId, 'bookmark', 'queued')]
      }),
    )
    const storage = fakeStorage(stored(active))
    const store = makeClearWorklistStore({ storage })

    await expect(
      store.applyProjection({
        version: 1,
        revision: 1,
        tweetId: '1000',
        scope: 'bookmark',
        state: 'failed',
        at: 1,
      }),
    ).resolves.toBe('applied')
    expect(Object.keys(storedEntries(storage.value))).toHaveLength(5000)
    expect(storedEntries(storage.value)['bookmark:1000']).toEqual(
      entry('1000', 'bookmark', 'failed', 1, 1),
    )
  })

  it('retains a missing terminal projection beside 4999 active rows', async () => {
    const active = Object.fromEntries(
      Array.from({ length: 4999 }, (_, index) => {
        const tweetId = String(index + 1000)
        return [`bookmark:${tweetId}`, entry(tweetId, 'bookmark', 'queued')]
      }),
    )
    const storage = fakeStorage(stored(active))
    const store = makeClearWorklistStore({ storage })

    await expect(
      store.applyProjection({
        version: 1,
        revision: 1,
        tweetId: '1',
        scope: 'bookmark',
        state: 'failed',
        at: 1,
      }),
    ).resolves.toBe('applied')
    expect(Object.keys(storedEntries(storage.value))).toHaveLength(5000)
    expect(storedEntries(storage.value)['bookmark:1']).toEqual(
      entry('1', 'bookmark', 'failed', 1, 1),
    )
  })
})
