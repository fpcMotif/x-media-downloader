import { forceCloseDatabase, IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { describe, expect, it, vi } from 'vitest'
import { emptyCompletionLedger, type CompletionLedger } from '../core/clear/ledger'
import {
  applyClearOutcome,
  initialClearSafetyState,
  issueClear,
  type ClearSafetyState,
} from '../core/clear/safety'
import {
  makeIndexedDbClearBackend,
  storeTombstone,
  type ClearDatabaseIdentity,
  type ClearDurableBackend,
  type ClearTombstoneKey,
} from './clear-indexed-db'
import {
  encodeClearCoordinatorStore,
  makeClearStateStore,
  type ClearCoordinatorStorage,
  type CoordinatorState,
  type ClearStorePointer,
} from './clear-state-store'
import type { StoredClearWorklistProjection } from './clear-worklist-projection'

const identity: ClearDatabaseIdentity = {
  key: 'identity',
  version: 1,
  storeId: 'store-a',
  receipt: {
    activeDigest: '0'.repeat(64),
    tombstoneCount: 0,
    tombstoneDigest: '0'.repeat(64),
  },
  source: { kind: 'fresh' },
}
const active = (revision: number, marker: string) => ({
  key: 'coordinator',
  version: 2,
  revision,
  marker,
})
const backend = (factory: IDBFactory, name: string): ClearDurableBackend =>
  makeIndexedDbClearBackend(name, factory, IDBKeyRange)
const ensureWorklistWake = async (): Promise<void> => {}
const projectDownloaded = (state: CoordinatorState) => ({
  state,
  value: undefined,
  worklist: [
    {
      tweetId: '1',
      scope: 'bookmark' as const,
      state: 'downloaded' as const,
      at: 10,
    },
  ],
})
const corruptDatabase = async (
  factory: IDBFactory,
  name: string,
  target: 'active' | 'valid-active' | 'valid-active-revision' | 'tombstone',
): Promise<void> => {
  const opening = factory.open(name)
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    opening.addEventListener('success', () => resolve(opening.result))
    opening.addEventListener('error', () => reject(opening.error))
  })
  const transaction = db.transaction(['active', 'tombstones'], 'readwrite')
  if (target === 'active') transaction.objectStore('active').delete('coordinator')
  else if (target === 'valid-active' || target === 'valid-active-revision') {
    const store = transaction.objectStore('active')
    const reading = store.get('coordinator')
    reading.addEventListener('success', () => {
      store.put({
        ...(reading.result as Record<string, unknown>),
        ...(target === 'valid-active-revision' ? { revision: 1 } : {}),
        safety: initialClearSafetyState(1)!,
        lastTerminalAt: -1,
      })
    })
  } else transaction.objectStore('tombstones').delete(['1', 'bookmark'])
  await new Promise<void>((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve())
    transaction.addEventListener('abort', () => reject(transaction.error))
    transaction.addEventListener('error', () => reject(transaction.error))
  })
  db.close()
}

describe('IndexedDB Clear durable backend', () => {
  it('upgrades a v1 Clear database without replacing existing authority', async () => {
    const factory = new IDBFactory()
    const opening = factory.open('upgrade-v1', 1)
    opening.addEventListener('upgradeneeded', () => {
      const db = opening.result
      db.createObjectStore('meta', { keyPath: 'key' })
      db.createObjectStore('active', { keyPath: 'key' })
      const tombstones = db.createObjectStore('tombstones', {
        keyPath: ['tweetId', 'scope'],
      })
      tombstones.createIndex('by_cleared_time', ['state', 'reverseAt', 'tweetId', 'scope'])
      tombstones.createIndex('by_origin', 'origin')
    })
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      opening.addEventListener('success', () => resolve(opening.result))
      opening.addEventListener('error', () => reject(opening.error))
    })
    const transaction = db.transaction(['meta', 'active'], 'readwrite')
    transaction.objectStore('meta').add(identity)
    transaction.objectStore('active').add(active(0, 'v1'))
    await new Promise<void>((resolve, reject) => {
      transaction.addEventListener('complete', () => resolve())
      transaction.addEventListener('abort', () => reject(transaction.error))
    })
    db.close()

    const durable = backend(factory, 'upgrade-v1')

    await expect(durable.load()).resolves.toEqual({
      identity,
      active: active(0, 'v1'),
    })
    await expect(durable.listWorklistProjections()).resolves.toEqual([])
  })

  it('reopens after the browser abnormally closes its cached connection', async () => {
    const factory = new IDBFactory()
    let opened: IDBDatabase | undefined
    const tracking = {
      cmp: factory.cmp.bind(factory),
      databases: factory.databases.bind(factory),
      deleteDatabase: factory.deleteDatabase.bind(factory),
      open: ((name: string, version?: number) => {
        const request = version === undefined ? factory.open(name) : factory.open(name, version)
        request.addEventListener('success', () => {
          opened = request.result
        })
        return request
      }) as IDBFactory['open'],
    } as IDBFactory
    const durable = makeIndexedDbClearBackend('forced-close', tracking, IDBKeyRange)
    await durable.bootstrap(identity, active(0, 'base'), [])
    const first = opened
    expect(first).toBeDefined()

    ;(forceCloseDatabase as unknown as (db: IDBDatabase) => void)(first!)
    await expect(durable.load()).resolves.toEqual({
      identity,
      active: active(0, 'base'),
    })
    expect(opened).not.toBe(first)
  })

  it('commits active state and immutable tombstones atomically', async () => {
    const durable = backend(new IDBFactory(), 'atomic')
    await durable.bootstrap(identity, active(0, 'base'), [])
    const key: ClearTombstoneKey = ['1', 'bookmark']
    const cleared = storeTombstone({
      tweetId: '1',
      scope: 'bookmark',
      state: 'cleared',
      at: 10,
    })

    await durable.commit({
      expectedRevision: 0,
      active: active(1, 'terminal'),
      observed: [{ key, value: undefined }],
      append: [cleared],
    })

    expect(await durable.load()).toEqual({
      identity,
      active: active(1, 'terminal'),
    })
    expect(await durable.readTombstones([key])).toEqual([{ key, value: cleared }])

    const secondKey: ClearTombstoneKey = ['2', 'bookmark']
    await expect(
      durable.commit({
        expectedRevision: 0,
        active: active(2, 'stale'),
        observed: [{ key: secondKey, value: undefined }],
        append: [
          storeTombstone({
            tweetId: '2',
            scope: 'bookmark',
            state: 'cleared',
            at: 11,
          }),
        ],
      }),
    ).rejects.toThrow('Clear database conflict')
    expect((await durable.load()).active).toEqual(active(1, 'terminal'))
    expect(await durable.readTombstones([secondKey])).toEqual([
      { key: secondKey, value: undefined },
    ])

    await expect(
      durable.commit({
        expectedRevision: 1,
        active: active(2, 'conflict'),
        observed: [{ key, value: cleared }],
        append: [
          storeTombstone({
            tweetId: '1',
            scope: 'bookmark',
            state: 'uncertain',
            at: 12,
          }),
        ],
      }),
    ).rejects.toThrow('Clear database conflict')
    expect((await durable.load()).active).toEqual(active(1, 'terminal'))
    expect(await durable.readTombstones([key])).toEqual([{ key, value: cleared }])
  })

  it('commits Worklist intent with active state and never on a lost CAS', async () => {
    const durable = backend(new IDBFactory(), 'projection-atomic')
    await durable.bootstrap(identity, active(0, 'base'), [])
    const first: StoredClearWorklistProjection = {
      version: 1,
      revision: 1,
      tweetId: '1',
      scope: 'bookmark',
      state: 'downloaded',
      at: 10,
    }

    await durable.commit({
      expectedRevision: 0,
      active: active(1, 'downloaded'),
      observed: [],
      append: [],
      worklist: [first],
    })
    expect(await durable.listWorklistProjections()).toEqual([first])

    const stale: StoredClearWorklistProjection = {
      ...first,
      revision: 2,
      tweetId: '2',
      state: 'failed',
      at: 11,
    }
    await expect(
      durable.commit({
        expectedRevision: 0,
        active: active(2, 'stale'),
        observed: [],
        append: [],
        worklist: [stale],
      }),
    ).rejects.toThrow('Clear database conflict')
    expect(await durable.listWorklistProjections()).toEqual([first])
  })

  it('coalesces per scope and exact ack cannot delete a newer revision', async () => {
    const durable = backend(new IDBFactory(), 'projection-ack')
    await durable.bootstrap(identity, active(0, 'base'), [])
    const first: StoredClearWorklistProjection = {
      version: 1,
      revision: 1,
      tweetId: '1',
      scope: 'bookmark',
      state: 'downloaded',
      at: 10,
    }
    const second: StoredClearWorklistProjection = {
      ...first,
      revision: 2,
      state: 'cleared',
      at: 11,
    }
    await durable.commit({
      expectedRevision: 0,
      active: active(1, 'downloaded'),
      observed: [],
      append: [],
      worklist: [first],
    })
    await durable.commit({
      expectedRevision: 1,
      active: active(2, 'cleared'),
      observed: [],
      append: [],
      worklist: [second],
    })

    await expect(durable.ackWorklistProjection(first)).resolves.toBe('stale')
    expect(await durable.listWorklistProjections()).toEqual([second])
    await expect(durable.ackWorklistProjection(second)).resolves.toBe('acked')
    await expect(durable.ackWorklistProjection(second)).resolves.toBe('missing')
    expect(await durable.listWorklistProjections()).toEqual([])
  })

  it('reads only the newest 100 cleared facts in stable order', async () => {
    const durable = backend(new IDBFactory(), 'cursor')
    const rows = Array.from({ length: 105 }, (_, index) =>
      storeTombstone({
        tweetId: String(index + 1),
        scope: index % 2 === 0 ? 'bookmark' : 'like',
        state: 'cleared',
        at: index,
      }),
    )
    rows.push(
      storeTombstone({
        tweetId: '999',
        scope: 'bookmark',
        state: 'uncertain',
        at: 999,
      }),
    )
    await durable.bootstrap(identity, active(0, 'base'), rows)

    const result = await durable.listCleared()

    expect(result).toHaveLength(100)
    expect(result.map((row) => (row as { readonly at: number }).at)).toEqual(
      Array.from({ length: 100 }, (_, index) => 104 - index),
    )
    await expect(durable.listCleared(0)).resolves.toEqual([])
    await expect(durable.listCleared(101)).rejects.toThrow('Invalid Clear Log limit')
  })

  it('uses tweet and scope keys to break equal-time cursor ties', async () => {
    const durable = backend(new IDBFactory(), 'cursor-ties')
    await durable.bootstrap(identity, active(0, 'base'), [
      storeTombstone({
        tweetId: '2',
        scope: 'bookmark',
        state: 'cleared',
        at: 10,
      }),
      storeTombstone({
        tweetId: '1',
        scope: 'like',
        state: 'cleared',
        at: 10,
      }),
      storeTombstone({
        tweetId: '1',
        scope: 'bookmark',
        state: 'cleared',
        at: 10,
      }),
      storeTombstone({
        tweetId: '0',
        scope: 'bookmark',
        state: 'uncertain',
        at: 99,
      }),
    ])

    expect(
      (await durable.listCleared()).map(
        (row) =>
          `${(row as { readonly tweetId: string }).tweetId}/${
            (row as { readonly scope: string }).scope
          }`,
      ),
    ).toEqual(['1/bookmark', '1/like', '2/bookmark'])
  })

  it('lets exactly one stale concurrent writer win', async () => {
    const factory = new IDBFactory()
    const first = backend(factory, 'race')
    const second = backend(factory, 'race')
    await first.bootstrap(identity, active(0, 'base'), [])
    const firstKey: ClearTombstoneKey = ['1', 'bookmark']
    const secondKey: ClearTombstoneKey = ['2', 'bookmark']
    const [firstObserved, secondObserved] = await Promise.all([
      first.readTombstones([firstKey]),
      second.readTombstones([secondKey]),
    ])

    const outcomes = await Promise.allSettled([
      first.commit({
        expectedRevision: 0,
        active: active(1, 'first'),
        observed: firstObserved,
        append: [
          storeTombstone({
            tweetId: '1',
            scope: 'bookmark',
            state: 'cleared',
            at: 1,
          }),
        ],
      }),
      second.commit({
        expectedRevision: 0,
        active: active(1, 'second'),
        observed: secondObserved,
        append: [
          storeTombstone({
            tweetId: '2',
            scope: 'bookmark',
            state: 'cleared',
            at: 2,
          }),
        ],
      }),
    ])

    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1)
    const loaded = await first.load()
    const winner = (loaded.active as { readonly marker: string }).marker
    const rows = await first.readTombstones([firstKey, secondKey])
    expect(rows.map(({ value }) => value !== undefined)).toEqual(
      winner === 'first' ? [true, false] : [false, true],
    )
  })
})

const safetyAt = (lastTerminalAt: number): ClearSafetyState => ({
  ...initialClearSafetyState(1)!,
  nextAttemptAt: lastTerminalAt + 2000,
})

const ledgerWithTombstone = (): CompletionLedger => ({
  entries: new Map(),
  tombstones: new Map([
    [
      '1',
      new Map([
        [
          'bookmark',
          {
            tweetId: '1',
            scope: 'bookmark',
            state: 'cleared',
            at: 7,
          },
        ],
      ]),
    ],
  ]),
})

describe('Clear database migration recovery', () => {
  it('does not commit Worklist intent until its recovery wake is durable', async () => {
    const factory = new IDBFactory()
    const durable = backend(factory, 'projection-wake-failure')
    let pointer: ClearStorePointer | null = null
    let wakeAvailable = false
    const ensureWake = vi.fn<() => Promise<void>>(async () => {
      if (!wakeAvailable) throw new Error('alarm unavailable')
    })
    const store = makeClearStateStore({
      storage: { get: async () => null, remove: async () => {} },
      legacyStorage: { get: async () => null, remove: async () => {} },
      pointerStorage: {
        get: async () => pointer,
        set: async (value) => {
          pointer = value
        },
      },
      sessionMarker: { get: async () => null, set: async () => {} },
      backend: durable,
      clock: { now: () => 10, schedule: () => {} },
      samplePostTerminalDelay: () => 2000,
      newStoreId: () => 'projection-wake-failure',
      ensureWorklistWake: ensureWake,
      trace: () => {},
    })
    await store.initialize()

    await expect(store.turn([], projectDownloaded)).rejects.toThrow('alarm unavailable')
    expect(await durable.listWorklistProjections()).toEqual([])

    wakeAvailable = true
    await expect(store.turn([], projectDownloaded)).resolves.toBeUndefined()
    expect(ensureWake).toHaveBeenCalledTimes(2)
    expect(await durable.listWorklistProjections()).toEqual([
      {
        version: 1,
        revision: 1,
        tweetId: '1',
        scope: 'bookmark',
        state: 'downloaded',
        at: 10,
      },
    ])
  })

  it('reloads and retries a stale state-store writer after a CAS conflict', async () => {
    const factory = new IDBFactory()
    let pointer: ClearStorePointer | null = null
    const makeStore = () =>
      makeClearStateStore({
        storage: { get: async () => null, remove: async () => {} },
        legacyStorage: {
          get: async () => null,
          remove: async () => {},
        },
        pointerStorage: {
          get: async () => pointer,
          set: async (value) => {
            pointer = value
          },
        },
        sessionMarker: {
          get: async () => ({ version: 1, browserSessionEpoch: 1 }),
          set: async () => {},
        },
        backend: backend(factory, 'state-store-race'),
        clock: { now: () => 10, schedule: () => {} },
        samplePostTerminalDelay: () => 2000,
        newStoreId: () => 'state-store-race',
        ensureWorklistWake,
        trace: () => {},
      })
    const first = makeStore()
    const second = makeStore()
    await Promise.all([first.initialize(), second.initialize()])

    await Promise.all([
      first.turn([], (state) => ({
        state: { ...state, safety: { ...state.safety, failureStreak: 1 } },
        value: undefined,
      })),
      second.turn([], (state) => ({
        state: { ...state, safety: { ...state.safety, nextAttemptAt: 5 } },
        value: undefined,
      })),
    ])

    const current = await makeStore().snapshot()
    expect(current.safety).toMatchObject({
      failureStreak: 1,
      nextAttemptAt: 5,
    })
  })

  it('opens one epoch across concurrent startup contexts and preserves a later attempt', async () => {
    const factory = new IDBFactory()
    let pointer: ClearStorePointer | null = null
    let marker: unknown = null
    let now = 1
    let releaseSecond!: () => void
    let secondEntered!: () => void
    const secondBlocked = new Promise<void>((resolve) => {
      secondEntered = resolve
    })
    const release = new Promise<void>((resolve) => {
      releaseSecond = resolve
    })
    const makeStore = (durable: ClearDurableBackend) =>
      makeClearStateStore({
        storage: { get: async () => null, remove: async () => {} },
        legacyStorage: { get: async () => null, remove: async () => {} },
        pointerStorage: {
          get: async () => pointer,
          set: async (value) => {
            pointer = value
          },
        },
        sessionMarker: {
          get: async () => marker,
          set: async (value) => {
            marker = value
          },
        },
        backend: durable,
        clock: { now: () => now, schedule: () => {} },
        samplePostTerminalDelay: () => 2000,
        newStoreId: () => 'startup-race',
        ensureWorklistWake,
        trace: () => {},
      })
    const first = makeStore(backend(factory, 'startup-race'))
    const secondDurable = backend(factory, 'startup-race')
    let pauseCommit = true
    const second = makeStore({
      ...secondDurable,
      commit: async (input) => {
        if (pauseCommit) {
          pauseCommit = false
          secondEntered()
          await release
        }
        await secondDurable.commit(input)
      },
    })
    await first.initialize()
    await first.turn([], (state) => {
      const issued = issueClear(state.safety, 1)
      const safety =
        issued === undefined ? undefined : applyClearOutcome(issued, 'uncertain', 1, 2000)
      if (safety === undefined) throw new Error('test outcome failed')
      return { state: { ...state, safety }, value: undefined }
    })
    await second.initialize()

    now = 3000
    const staleStartup = second.onBrowserStartup()
    await secondBlocked
    expect(await first.onBrowserStartup()).toBe(true)
    await first.turn([], (state) => {
      const issued = issueClear(state.safety, now)
      const safety =
        issued === undefined ? undefined : applyClearOutcome(issued, 'uncertain', now, 2000)
      if (safety === undefined) throw new Error('test outcome failed')
      return { state: { ...state, safety }, value: undefined }
    })
    releaseSecond()
    expect(await staleStartup).toBe(true)

    const current = await makeStore(backend(factory, 'startup-race')).snapshot()
    expect(current.safety).toMatchObject({
      browserSessionEpoch: 2,
      attemptAts: [3000],
    })
    expect(marker).toEqual({ version: 1, browserSessionEpoch: 2 })
  })

  it('keeps attempts from an unrelated startup CAS winner', async () => {
    const factory = new IDBFactory()
    let pointer: ClearStorePointer | null = null
    let marker: unknown = null
    let now = 1
    let releaseStartup!: () => void
    let startupEntered!: () => void
    const blocked = new Promise<void>((resolve) => {
      startupEntered = resolve
    })
    const release = new Promise<void>((resolve) => {
      releaseStartup = resolve
    })
    const makeStore = (durable: ClearDurableBackend) =>
      makeClearStateStore({
        storage: { get: async () => null, remove: async () => {} },
        legacyStorage: { get: async () => null, remove: async () => {} },
        pointerStorage: {
          get: async () => pointer,
          set: async (value) => {
            pointer = value
          },
        },
        sessionMarker: {
          get: async () => marker,
          set: async (value) => {
            marker = value
          },
        },
        backend: durable,
        clock: { now: () => now, schedule: () => {} },
        samplePostTerminalDelay: () => 2000,
        newStoreId: () => 'startup-unrelated-race',
        ensureWorklistWake,
        trace: () => {},
      })
    const writer = makeStore(backend(factory, 'startup-unrelated-race'))
    const startupDurable = backend(factory, 'startup-unrelated-race')
    let pauseCommit = true
    const startup = makeStore({
      ...startupDurable,
      commit: async (input) => {
        if (pauseCommit) {
          pauseCommit = false
          startupEntered()
          await release
        }
        await startupDurable.commit(input)
      },
    })
    await writer.initialize()
    await writer.turn([], (state) => {
      const issued = issueClear(state.safety, 1)
      const safety =
        issued === undefined ? undefined : applyClearOutcome(issued, 'uncertain', 1, 2000)
      if (safety === undefined) throw new Error('test outcome failed')
      return { state: { ...state, safety }, value: undefined }
    })
    await startup.initialize()

    now = 3000
    const opening = startup.onBrowserStartup()
    await blocked
    await writer.turn([], (state) => {
      const issued = issueClear(state.safety, now)
      const safety =
        issued === undefined ? undefined : applyClearOutcome(issued, 'uncertain', now, 2000)
      if (safety === undefined) throw new Error('test outcome failed')
      return { state: { ...state, safety }, value: undefined }
    })
    releaseStartup()
    await opening

    const current = await makeStore(backend(factory, 'startup-unrelated-race')).snapshot()
    expect(current.safety).toMatchObject({
      browserSessionEpoch: 2,
      attemptAts: [3000],
    })
  })

  it('finishes an interrupted startup claim during external session adoption', async () => {
    const factory = new IDBFactory()
    let pointer: ClearStorePointer | null = null
    let marker: unknown = null
    let releaseStartup!: () => void
    let startupEntered!: () => void
    const blocked = new Promise<void>((resolve) => {
      startupEntered = resolve
    })
    const release = new Promise<void>((resolve) => {
      releaseStartup = resolve
    })
    const makeStore = (durable: ClearDurableBackend) =>
      makeClearStateStore({
        storage: { get: async () => null, remove: async () => {} },
        legacyStorage: { get: async () => null, remove: async () => {} },
        pointerStorage: {
          get: async () => pointer,
          set: async (value) => {
            pointer = value
          },
        },
        sessionMarker: {
          get: async () => marker,
          set: async (value) => {
            marker = value
          },
        },
        backend: durable,
        clock: { now: () => 10, schedule: () => {} },
        samplePostTerminalDelay: () => 2000,
        newStoreId: () => 'startup-claim-recovery',
        ensureWorklistWake,
        trace: () => {},
      })
    const stalledDurable = backend(factory, 'startup-claim-recovery')
    let pauseCommit = true
    const stalled = makeStore({
      ...stalledDurable,
      commit: async (input) => {
        if (pauseCommit) {
          pauseCommit = false
          startupEntered()
          await release
        }
        await stalledDurable.commit(input)
      },
    })
    await stalled.initialize()
    const opening = stalled.onBrowserStartup()
    await blocked

    const resumed = makeStore(backend(factory, 'startup-claim-recovery'))
    await resumed.initialize()
    expect(resumed.isGateOpen()).toBe(false)
    await resumed.adoptExternalSession()
    expect(resumed.isGateOpen()).toBe(true)
    expect((await resumed.snapshot()).safety.browserSessionEpoch).toBe(2)

    releaseStartup()
    await opening
    expect(marker).toEqual({ version: 1, browserSessionEpoch: 2 })
  })

  it('treats pointer publication as cutover and retains later legacy writes', async () => {
    const factory = new IDBFactory()
    const legacyValue = encodeClearCoordinatorStore({
      completion: ledgerWithTombstone(),
      safety: safetyAt(7),
    })
    let local: unknown = null
    let pointer: ClearStorePointer | null = null
    const remove = vi.fn<() => Promise<void>>(async () => {
      local = null
    })
    const makeStore = () =>
      makeClearStateStore({
        storage: {
          get: async () => local,
          remove,
        },
        legacyStorage: {
          get: async () => null,
          remove: async () => {},
        },
        pointerStorage: {
          get: async () => pointer,
          set: async (value) => {
            pointer = value
            local = legacyValue
          },
        },
        sessionMarker: {
          get: async () => null,
          set: async () => {},
        },
        backend: backend(factory, 'fresh-source-race'),
        clock: { now: () => 10, schedule: () => {} },
        samplePostTerminalDelay: () => 2000,
        newStoreId: () => 'fresh-race-store',
        ensureWorklistWake,
        trace: () => {},
      })

    await makeStore().initialize()
    expect(pointer).toEqual({ version: 1, storeId: 'fresh-race-store' })
    expect(local).toBe(legacyValue)
    expect(remove).not.toHaveBeenCalled()
    await makeStore().initialize()
    expect(local).toBe(legacyValue)
    expect(remove).not.toHaveBeenCalled()
  })

  it.each(['active', 'valid-active', 'valid-active-revision', 'tombstone'] as const)(
    'preserves the legacy source when migrated %s state is corrupt',
    async (target) => {
      const factory = new IDBFactory()
      const databaseName = `migration-corrupt-${target}`
      const legacyValue = encodeClearCoordinatorStore({
        completion: ledgerWithTombstone(),
        safety: safetyAt(7),
      })
      let local: unknown = legacyValue
      let pointer: ClearStorePointer | null = null
      let blockPointer = true
      const remove = vi.fn<() => Promise<void>>(async () => {
        local = null
      })
      const setPointer = vi.fn<(value: ClearStorePointer) => Promise<void>>(async (value) => {
        if (blockPointer) throw new Error('pointer unavailable')
        pointer = value
      })
      const makeStore = () =>
        makeClearStateStore({
          storage: {
            get: async () => local,
            remove,
          },
          legacyStorage: {
            get: async () => null,
            remove: async () => {},
          },
          pointerStorage: {
            get: async () => pointer,
            set: setPointer,
          },
          sessionMarker: {
            get: async () => null,
            set: async () => {},
          },
          backend: backend(factory, databaseName),
          clock: { now: () => 10, schedule: () => {} },
          samplePostTerminalDelay: () => 2000,
          newStoreId: () => 'corruption-store',
          ensureWorklistWake,
          trace: () => {},
        })

      await expect(makeStore().initialize()).rejects.toThrow('pointer unavailable')
      await corruptDatabase(factory, databaseName, target)
      blockPointer = false
      setPointer.mockClear()

      await expect(makeStore().initialize()).rejects.toThrow(
        target === 'active'
          ? 'active coordinator envelope'
          : target === 'valid-active-revision'
            ? 'runtime revisions'
            : 'migration target',
      )
      expect(setPointer).not.toHaveBeenCalled()
      expect(remove).not.toHaveBeenCalled()
      expect(pointer).toBeNull()
      expect(local).toBe(legacyValue)
    },
  )

  it('resumes after IDB bootstrap succeeds but pointer publication crashes', async () => {
    const factory = new IDBFactory()
    const databaseName = 'migration-crash'
    const legacyValue = encodeClearCoordinatorStore({
      completion: ledgerWithTombstone(),
      safety: safetyAt(7),
    })
    let local: unknown = legacyValue
    const remove = vi.fn<() => Promise<void>>(async () => {
      local = null
    })
    const storage: ClearCoordinatorStorage = {
      get: async () => local,
      remove,
    }
    let pointer: ClearStorePointer | null = null
    let failPointer = true
    const pointerStorage = {
      get: async () => pointer,
      set: vi.fn<(value: ClearStorePointer) => Promise<void>>(async (value) => {
        pointer = value
        if (failPointer) {
          failPointer = false
          throw new Error('pointer storage down')
        }
      }),
    }
    const makeStore = () =>
      makeClearStateStore({
        storage,
        legacyStorage: {
          get: async () => null,
          remove: async () => {},
        },
        pointerStorage,
        sessionMarker: {
          get: async () => null,
          set: async () => {},
        },
        backend: backend(factory, databaseName),
        clock: { now: () => 10, schedule: () => {} },
        samplePostTerminalDelay: () => 2000,
        newStoreId: () => 'migration-store',
        ensureWorklistWake,
        trace: () => {},
      })

    await expect(makeStore().initialize()).rejects.toThrow('pointer storage down')
    expect(remove).not.toHaveBeenCalled()
    expect(local).toBe(legacyValue)
    expect(pointer).toEqual({ version: 1, storeId: 'migration-store' })
    const afterCrash = backend(factory, databaseName)
    expect((await afterCrash.load()).identity).toMatchObject({
      storeId: 'migration-store',
      source: { kind: 'coordinator' },
    })
    expect(await afterCrash.readTombstones([['1', 'bookmark']])).toMatchObject([
      {
        value: { state: 'cleared', at: 7 },
      },
    ])

    const restarted = makeStore()
    await restarted.initialize()

    expect(pointer).toEqual({ version: 1, storeId: 'migration-store' })
    expect(remove).not.toHaveBeenCalled()
    expect(local).toBe(legacyValue)
    expect(await restarted.listClearLog()).toEqual([
      {
        tweetId: '1',
        scope: 'bookmark',
        mechanism: 'dom-click',
        at: 7,
        permalink: 'https://x.com/i/status/1',
      },
    ])
  })

  it('ignores a changed legacy source after a persisted pointer crash', async () => {
    const factory = new IDBFactory()
    const databaseName = 'migration-receipt-mismatch'
    let local: unknown = encodeClearCoordinatorStore({
      completion: emptyCompletionLedger(),
      safety: initialClearSafetyState(1)!,
    })
    let pointer: ClearStorePointer | null = null
    let failPointer = true
    const remove = vi.fn<() => Promise<void>>(async () => {
      local = null
    })
    const makeStore = () =>
      makeClearStateStore({
        storage: {
          get: async () => local,
          remove,
        },
        legacyStorage: {
          get: async () => null,
          remove: async () => {},
        },
        pointerStorage: {
          get: async () => pointer,
          set: async (value) => {
            pointer = value
            if (failPointer) {
              failPointer = false
              throw new Error('pointer acknowledgement lost')
            }
          },
        },
        sessionMarker: {
          get: async () => null,
          set: async () => {},
        },
        backend: backend(factory, databaseName),
        clock: { now: () => 10, schedule: () => {} },
        samplePostTerminalDelay: () => 2000,
        newStoreId: () => 'receipt-store',
        ensureWorklistWake,
        trace: () => {},
      })

    await expect(makeStore().initialize()).rejects.toThrow('pointer acknowledgement lost')
    const lateLegacyWrite = encodeClearCoordinatorStore({
      completion: emptyCompletionLedger(),
      safety: initialClearSafetyState(2)!,
    })
    local = lateLegacyWrite

    await makeStore().initialize()
    expect(remove).not.toHaveBeenCalled()
    expect(pointer).toEqual({ version: 1, storeId: 'receipt-store' })
    expect(local).toBe(lateLegacyWrite)
  })

  it('fails closed when a pointer and database identity split', async () => {
    const factory = new IDBFactory()
    const databaseName = 'split-brain'
    let pointer: ClearStorePointer | null = {
      version: 1,
      storeId: 'orphan',
    }
    const remove = vi.fn<() => Promise<void>>(async () => {})
    const makeStore = () =>
      makeClearStateStore({
        storage: {
          get: async () => null,
          remove,
        },
        legacyStorage: {
          get: async () => null,
          remove: async () => {},
        },
        pointerStorage: {
          get: async () => pointer,
          set: async (value) => {
            pointer = value
          },
        },
        sessionMarker: {
          get: async () => null,
          set: async () => {},
        },
        backend: backend(factory, databaseName),
        clock: { now: () => 10, schedule: () => {} },
        samplePostTerminalDelay: () => 2000,
        newStoreId: () => 'real-store',
        ensureWorklistWake,
        trace: () => {},
      })

    await expect(makeStore().initialize()).rejects.toThrow('pointer has no database')
    expect(remove).not.toHaveBeenCalled()

    pointer = null
    await makeStore().initialize()
    pointer = { version: 1, storeId: 'different-store' }

    await expect(makeStore().initialize()).rejects.toThrow('pointer mismatch')
    expect(remove).not.toHaveBeenCalled()
  })

  it('bootstraps a fresh empty ledger without legacy writes', async () => {
    const factory = new IDBFactory()
    let pointer: ClearStorePointer | null = null
    const store = makeClearStateStore({
      storage: { get: async () => null, remove: async () => {} },
      legacyStorage: {
        get: async () => null,
        remove: async () => {},
      },
      pointerStorage: {
        get: async () => pointer,
        set: async (value) => {
          pointer = value
        },
      },
      sessionMarker: {
        get: async () => null,
        set: async () => {},
      },
      backend: backend(factory, 'fresh'),
      clock: { now: () => 10, schedule: () => {} },
      samplePostTerminalDelay: () => 2000,
      newStoreId: () => 'fresh-store',
      ensureWorklistWake,
      trace: () => {},
    })

    await store.initialize()

    expect(pointer).toEqual({ version: 1, storeId: 'fresh-store' })
    expect((await store.snapshot()).completion).toEqual(emptyCompletionLedger())
  })
})
