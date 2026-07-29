import { Schema } from 'effect'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  attemptReservedClear,
  decodeCompletionLedger,
  emptyCompletionLedger,
  encodeCompletionLedger,
  reserveClear,
  type ClearLedgerStore,
  type CompletionLedger,
  type Scope,
} from '../core/clear/ledger'
import { encodeClearSafetyState, initialClearSafetyState, issueClear } from '../core/clear/safety'
import { Settings as SettingsSchema, type Settings } from '../core/schema'
import type { SettingsRecord } from '../core/settings/storage'
import {
  ClearCoordinatorCorruptionError,
  decodeClearCoordinatorStore,
  makeClearCoordinator,
  type ClearClock,
  type ClearCoordinator,
  type ClearCoordinatorDeps,
  type ClearCoordinatorStorage,
  type ClearDownloadRow,
  type ClearSessionMarkerStorage,
  type ClearWakePort,
  type LegacyCompletionStorage,
} from './clear-coordinator'
import {
  ClearDatabaseConflictError,
  storeTombstone,
  type ClearDatabaseIdentity,
  type ClearDurableBackend,
  type StoredClearTombstone,
} from './clear-indexed-db'
import { MAX_CLEAR_CLOCK_DELAY_MS } from './clear-state-ports'
import type { StoredClearWorklistProjection } from './clear-worklist-projection'
import { makeSettingsWriter } from './settings-writer'

const TWEET = '12345678901234567890'
const SECOND_TWEET = '42'
const defaults = Schema.decodeUnknownSync(SettingsSchema)({})
const settings = (over: Partial<Settings> = {}): Settings => ({ ...defaults, ...over })
const CLEAR_ON = settings({ clearOnSave: true, autoUnbookmarkOnSave: true })
const initialSafety = initialClearSafetyState(1)!
const coordinatorRaw = (
  completion: CompletionLedger = emptyCompletionLedger(),
  safety = initialSafety,
) => ({
  version: 1 as const,
  completion: encodeCompletionLedger(completion),
  safety: encodeClearSafetyState(safety),
})

const wrapLedger = (value: unknown, current?: unknown): unknown => {
  const decoded = decodeCompletionLedger(value)
  if (!decoded.ok) return value
  const currentState = decodeClearCoordinatorStore(current, Number.MAX_SAFE_INTEGER)
  let latestTerminalAt = -1
  for (const states of decoded.ledger.tombstones.values())
    for (const tombstone of states.values())
      latestTerminalAt = Math.max(latestTerminalAt, tombstone.at)
  const migratedSafety =
    latestTerminalAt < 0
      ? initialSafety
      : { ...initialSafety, nextAttemptAt: latestTerminalAt + 2000 }
  return coordinatorRaw(
    decoded.ledger,
    currentState.ok ? currentState.state.safety : migratedSafety,
  )
}

const tombstoneKey = (tombstone: StoredClearTombstone): string =>
  `${tombstone.tweetId}\u0000${tombstone.scope}`
const sameTombstone = (
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
const activeRevision = (active: unknown): number | undefined =>
  typeof active === 'object' &&
  active !== null &&
  !Array.isArray(active) &&
  typeof Reflect.get(active, 'revision') === 'number'
    ? (Reflect.get(active, 'revision') as number)
    : undefined

const makeStorage = (
  initial: unknown = coordinatorRaw(),
  hooks: {
    readonly onBootstrap?: () => void
    readonly onCommit?: () => void
    readonly onPointerSet?: () => void
  } = {},
) => {
  let sourceRaw = wrapLedger(initial)
  let identity: unknown
  let active: unknown
  let tombstones = new Map<string, StoredClearTombstone>()
  let worklist = new Map<string, StoredClearWorklistProjection>()
  let pointer: unknown = null
  let failNextCommit = false
  let commitCalls = 0
  let failAtCommit: number | undefined

  const bootstrap = vi.fn<ClearDurableBackend['bootstrap']>(
    async (nextIdentity, nextActive, imported) => {
      if (identity !== undefined) return 'exists'
      const importedMap = new Map<string, StoredClearTombstone>()
      for (const tombstone of imported) {
        const key = tombstoneKey(tombstone)
        if (importedMap.has(key)) throw new Error(`duplicate tombstone ${key}`)
        importedMap.set(key, tombstone)
      }
      hooks.onBootstrap?.()
      identity = nextIdentity
      active = nextActive
      tombstones = importedMap
      return 'created'
    },
  )
  const commit = vi.fn<ClearDurableBackend['commit']>(
    async ({
      expectedRevision,
      active: nextActive,
      observed,
      append,
      worklist: projections = [],
    }) => {
      commitCalls += 1
      if (failNextCommit || commitCalls === failAtCommit) {
        failNextCommit = false
        throw new Error('storage down')
      }
      if (activeRevision(active) !== expectedRevision)
        throw new ClearDatabaseConflictError('active revision changed')
      for (const item of observed)
        if (!sameTombstone(tombstones.get(`${item.key[0]}\u0000${item.key[1]}`), item.value))
          throw new ClearDatabaseConflictError('observed tombstone changed')
      const nextTombstones = new Map(tombstones)
      for (const tombstone of append) {
        const key = tombstoneKey(tombstone)
        const current = nextTombstones.get(key)
        if (current !== undefined && !sameTombstone(current, tombstone))
          throw new ClearDatabaseConflictError('conflicting tombstone')
        nextTombstones.set(key, tombstone)
      }
      tombstones = nextTombstones
      const nextWorklist = new Map(worklist)
      for (const projection of projections)
        nextWorklist.set(`${projection.tweetId}\u0000${projection.scope}`, projection)
      worklist = nextWorklist
      active = nextActive
      hooks.onCommit?.()
    },
  )
  const backend: ClearDurableBackend = {
    load: async () => ({ identity, active }),
    bootstrap,
    readTombstones: async (keys) =>
      keys.map((key) => ({
        key,
        value: tombstones.get(`${key[0]}\u0000${key[1]}`),
      })),
    commit,
    listMigrationTombstones: async () =>
      [...tombstones.values()].filter((tombstone) => tombstone.origin === 'migration'),
    listCleared: async (limit = 100) =>
      [...tombstones.values()]
        .filter((tombstone) => tombstone.state === 'cleared')
        .toSorted(
          (left, right) =>
            right.at - left.at ||
            left.tweetId.localeCompare(right.tweetId) ||
            left.scope.localeCompare(right.scope),
        )
        .slice(0, limit),
    listWorklistProjections: async (limit = 100) =>
      [...worklist.values()]
        .toSorted(
          (left, right) =>
            left.revision - right.revision ||
            left.tweetId.localeCompare(right.tweetId) ||
            left.scope.localeCompare(right.scope),
        )
        .slice(0, limit),
    ackWorklistProjection: async (expected) => {
      const key = `${expected.tweetId}\u0000${expected.scope}`
      const current = worklist.get(key)
      if (current === undefined) return 'missing'
      if (current.revision !== expected.revision) return 'stale'
      worklist.delete(key)
      return 'acked'
    },
  }
  const record: ClearCoordinatorStorage = {
    get: vi.fn<ClearCoordinatorStorage['get']>(async () => sourceRaw),
    remove: vi.fn<() => Promise<void>>(async () => {
      sourceRaw = null
    }),
  }
  const pointerStorage = {
    get: vi.fn<() => Promise<unknown>>(async () => pointer),
    set: vi.fn<(value: unknown) => Promise<void>>(async (value) => {
      pointer = value
      hooks.onPointerSet?.()
    }),
  }
  const raw = (): unknown => {
    if (active === undefined) return sourceRaw
    if (
      typeof active !== 'object' ||
      active === null ||
      Array.isArray(active) ||
      Reflect.get(active, 'version') !== 2
    )
      return active
    const completion = Reflect.get(active, 'completion')
    const safety = Reflect.get(active, 'safety')
    if (typeof completion !== 'object' || completion === null || Array.isArray(completion))
      return active
    const grouped: Record<string, Record<string, unknown>> = {}
    for (const {
      version: _version,
      origin: _origin,
      reverseAt: _reverseAt,
      ...row
    } of tombstones.values()) {
      grouped[row.tweetId] ??= {}
      grouped[row.tweetId]![row.scope] = row
    }
    return {
      version: 1,
      completion: {
        ...completion,
        tombstones: grouped,
      },
      safety,
    }
  }
  const replace = (value: unknown): void => {
    const replacement = wrapLedger(value, raw())
    sourceRaw = replacement
    const decoded = decodeClearCoordinatorStore(replacement, Number.MAX_SAFE_INTEGER)
    if (!decoded.ok) {
      if (identity !== undefined) active = replacement
      return
    }
    const completion = encodeCompletionLedger(decoded.state.completion)
    const cached: Record<string, Record<string, unknown>> = {}
    const nextTombstones = new Map<string, StoredClearTombstone>()
    let lastTerminalAt = -1
    for (const [tweetId, states] of decoded.state.completion.tombstones)
      for (const [scope, tombstone] of states) {
        const stored = storeTombstone(tombstone)
        nextTombstones.set(tombstoneKey(stored), stored)
        lastTerminalAt = Math.max(lastTerminalAt, tombstone.at)
        const entry = decoded.state.completion.entries.get(tweetId)
        if (
          entry !== undefined &&
          entry.clear[scope] === tombstone.state &&
          (tombstone.state === 'cleared' || tombstone.state === 'uncertain')
        ) {
          cached[tweetId] ??= {}
          cached[tweetId]![scope] = tombstone
        }
      }
    const revision = (activeRevision(active) ?? -1) + 1
    active = {
      key: 'coordinator',
      version: 2,
      revision,
      completion: { ...completion, tombstones: cached },
      safety: encodeClearSafetyState(decoded.state.safety),
      lastTerminalAt,
    }
    tombstones = nextTombstones
    sourceRaw = null
    identity ??= {
      key: 'identity',
      version: 1,
      storeId: 'test-clear-store',
      receipt: {
        activeDigest: '0'.repeat(64),
        tombstoneCount: 0,
        tombstoneDigest: '0'.repeat(64),
      },
      source: { kind: 'fresh' },
    } satisfies ClearDatabaseIdentity
    pointer ??= { version: 1, storeId: 'test-clear-store' }
  }
  return {
    record,
    backend,
    bootstrap,
    commit,
    pointerStorage,
    newStoreId: () => 'test-clear-store',
    raw,
    replace,
    failNext: () => {
      failNextCommit = true
    },
    failAfter: (writes: number) => {
      failAtCommit = commitCalls + writes
    },
  }
}

const durableDeps = (store: ReturnType<typeof makeStorage>) => ({
  storage: store.record,
  pointerStorage: store.pointerStorage,
  backend: store.backend,
  newStoreId: store.newStoreId,
  wake: { schedule: async () => {} },
  projectionWake: { ensure: async () => {} },
  projectScopeState: async () => {},
})

const makeClock = (
  start = 10,
): ClearClock & {
  readonly calls: Array<{ at: number; callback: () => void }>
  readonly set: (at: number) => void
  readonly fireNext: () => number
} => {
  let current = start
  const calls: Array<{ at: number; callback: () => void }> = []
  return {
    now: () => current,
    schedule: (callback, delayMs) => calls.push({ at: current + delayMs, callback }),
    calls,
    set: (at) => {
      current = at
    },
    fireNext: () => {
      calls.sort((a, b) => a.at - b.at)
      const next = calls.shift()
      if (next === undefined) throw new Error('No timer')
      current = Math.max(current, next.at)
      next.callback()
      return current
    },
  }
}

const mounted = (
  tabId: number,
  results: ReadonlyArray<{
    scope: Scope
    state: 'actionable' | 'already-clear' | 'not-applicable' | 'unknown'
  }>,
) => ({
  tabId,
  response: { _tag: 'LocateClearTweetResponse' as const, mounted: true, results },
})

const makeHarness = (over: Partial<ClearCoordinatorDeps> = {}, store = makeStorage()) => {
  const clock = makeClock()
  let currentSettings = CLEAR_ON
  const settingsTurns = vi.fn<() => void>()
  let policyTail: Promise<unknown> = Promise.resolve()
  const withClearPolicyTurn: ClearCoordinatorDeps['settings']['withClearPolicyTurn'] = async (
    callback,
  ) => {
    settingsTurns()
    // oxlint-disable-next-line promise/no-callback-in-promise -- models the serialized policy port
    const result = policyTail.then(async () => await callback(currentSettings))
    policyTail = result.then(
      () => undefined,
      () => undefined,
    )
    return await result
  }
  const locateClearTweet = vi.fn<ClearCoordinatorDeps['tabs']['locateClearTweet']>(async () => [])
  const clearTweetInTab = vi.fn<ClearCoordinatorDeps['tabs']['clearTweetInTab']>(
    async (_tabId, _tweetId, scopes) => ({
      _tag: 'ClearTweetResponse',
      results: scopes.map((scope) => ({ scope, state: 'cleared' as const })),
    }),
  )
  const search = vi.fn<ClearCoordinatorDeps['downloadSearch']['search']>(async () => ({
    state: 'complete',
    exists: true,
  }))
  const deps: ClearCoordinatorDeps = {
    ...durableDeps(store),
    sessionMarker: {
      get: async () => ({ version: 1, browserSessionEpoch: 1 }),
      set: async () => {},
    },
    clock,
    postTerminalDelay: () => 2000,
    downloadSearch: { search },
    settings: { withClearPolicyTurn },
    tabs: { locateClearTweet, clearTweetInTab },
    ...over,
  }
  const coordinator = makeClearCoordinator(deps)
  return {
    coordinator,
    restart: (next: Partial<ClearCoordinatorDeps> = {}) =>
      makeClearCoordinator({ ...deps, ...next }),
    store,
    clock,
    search,
    locateClearTweet,
    clearTweetInTab,
    settingsTurns,
    setSettings: (next: Settings) => {
      currentSettings = next
    },
  }
}

const stateOf = (raw: unknown) => {
  const decoded = decodeClearCoordinatorStore(raw, Number.MAX_SAFE_INTEGER)
  if (!decoded.ok) throw new Error(decoded.reason)
  return decoded.state
}

const ledgerOf = (raw: unknown): CompletionLedger => stateOf(raw).completion

const seed = (
  coordinator: ClearCoordinator,
  input: Partial<{
    tweetId: string
    expected: string[]
    starting: string[]
    manualScopes: Scope[]
    automaticScopes: Scope[]
    crossListAutomaticScopes: Scope[]
  }> = {},
): ReturnType<ClearCoordinator['seed']> =>
  coordinator.seed({
    byTweet: new Map([[input.tweetId ?? TWEET, input.expected ?? ['request-a']]]),
    startingByTweet: new Map([
      [input.tweetId ?? TWEET, input.starting ?? input.expected ?? ['request-a']],
    ]),
    manualScopes: input.manualScopes ?? [],
    automaticScopes: input.automaticScopes ?? ['bookmark'],
    crossListAutomaticScopes: input.crossListAutomaticScopes ?? [],
  })

const bind = (
  coordinator: ClearCoordinator,
  requestId = 'request-a',
  downloadId = 1,
  tweetId = TWEET,
): Promise<void> => coordinator.bindStarted({ tweetId, requestId, downloadId })

const reconcileOnBoot = (
  coordinator: ClearCoordinator,
  retryOwnedRequestIds: ReadonlySet<string>,
): Promise<void> =>
  coordinator.resumeOnBoot({
    retryOwnedRequestIds,
    adoptExternalSession: false,
  })

const driveFromSafetyWake = (coordinator: ClearCoordinator): Promise<void> =>
  coordinator.onSafetyWake({ retryOwnedRequestIds: new Set() })

const driveFromVisibilityPulse = (
  coordinator: ClearCoordinator,
  tabId: number,
  tweetIds: ReadonlyArray<string>,
): Promise<void> => coordinator.onVisibilityPulse(tabId, tweetIds)

const makeReady = async (
  harness: ReturnType<typeof makeHarness>,
  input: Parameters<typeof seed>[1] = {},
): Promise<void> => {
  await seed(harness.coordinator, input)
  await bind(harness.coordinator, input.expected?.[0] ?? 'request-a', 1, input.tweetId ?? TWEET)
  await harness.coordinator.recordTerminal({
    tweetId: input.tweetId ?? TWEET,
    requestId: input.expected?.[0] ?? 'request-a',
    downloadId: 1,
    outcome: 'complete',
  })
  harness.clock.fireNext()
  await vi.waitFor(() =>
    expect(ledgerOf(harness.store.raw()).entries.get(input.tweetId ?? TWEET)?.inProgress.size).toBe(
      0,
    ),
  )
  await vi.waitFor(() => expect(harness.settingsTurns).toHaveBeenCalled())
  await Promise.resolve()
  harness.settingsTurns.mockClear()
  harness.locateClearTweet.mockClear()
  harness.clearTweetInTab.mockClear()
}

describe('durable Completion Ledger coordinator', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('settles from an alarm-only restart after the worker dies before its timer', async () => {
    const wake = vi.fn<ClearWakePort['schedule']>(async () => {})
    const h = makeHarness({ wake: { schedule: wake } })
    await seed(h.coordinator)
    await bind(h.coordinator)
    await h.coordinator.recordTerminal({
      tweetId: TWEET,
      requestId: 'request-a',
      downloadId: 1,
      outcome: 'complete',
    })

    expect(wake).toHaveBeenCalledWith(30_010)
    h.clock.set(30_010)
    const restarted = h.restart()
    await restarted.onSafetyWake({ retryOwnedRequestIds: new Set() })

    expect(h.search).toHaveBeenCalledWith(1)
    expect(ledgerOf(h.store.raw()).entries.get(TWEET)?.inProgress.size).toBe(0)
  })

  it('rearms before a settle probe so a search failure survives another worker death', async () => {
    const wake = vi.fn<ClearWakePort['schedule']>(async () => {})
    const h = makeHarness({ wake: { schedule: wake } })
    await seed(h.coordinator)
    await bind(h.coordinator)
    await h.coordinator.recordTerminal({
      tweetId: TWEET,
      requestId: 'request-a',
      downloadId: 1,
      outcome: 'complete',
    })
    h.search.mockRejectedValueOnce(new Error('downloads unavailable'))

    h.clock.set(30_010)
    await h.restart().onSafetyWake({ retryOwnedRequestIds: new Set() })
    expect(wake).toHaveBeenCalledWith(60_010)
    expect(ledgerOf(h.store.raw()).entries.get(TWEET)?.settling['request-a']).toBeDefined()

    h.clock.set(60_010)
    await h.restart().onSafetyWake({ retryOwnedRequestIds: new Set() })
    expect(h.search).toHaveBeenCalledTimes(2)
    expect(ledgerOf(h.store.raw()).entries.get(TWEET)?.inProgress.size).toBe(0)
  })

  it('does not settle a due witness while the Transfer Registry owns its retry', async () => {
    const h = makeHarness()
    await seed(h.coordinator)
    await bind(h.coordinator)
    await h.coordinator.recordTerminal({
      tweetId: TWEET,
      requestId: 'request-a',
      downloadId: 1,
      outcome: 'complete',
    })
    h.clock.set(30_010)
    const restarted = h.restart()

    await restarted.onSafetyWake({
      retryOwnedRequestIds: new Set(['request-a']),
    })
    expect(h.search).not.toHaveBeenCalled()
    expect(ledgerOf(h.store.raw()).entries.get(TWEET)?.settling['request-a']).toBeDefined()

    await restarted.onSafetyWake({ retryOwnedRequestIds: new Set() })
    expect(h.search).toHaveBeenCalledWith(1)
    expect(ledgerOf(h.store.raw()).entries.get(TWEET)?.inProgress.size).toBe(0)
  })

  it('waits a fresh durable interval before probing an already-due witness on boot', async () => {
    const wake = vi.fn<ClearWakePort['schedule']>(async () => {})
    const h = makeHarness({ wake: { schedule: wake } })
    await seed(h.coordinator)
    await bind(h.coordinator)
    await h.coordinator.recordTerminal({
      tweetId: TWEET,
      requestId: 'request-a',
      downloadId: 1,
      outcome: 'complete',
    })
    h.clock.calls.length = 0
    h.clock.set(10_000)
    wake.mockClear()
    const restarted = h.restart()

    await reconcileOnBoot(restarted, new Set())
    await restarted.onSafetyWake({ retryOwnedRequestIds: new Set() })

    expect(h.search).not.toHaveBeenCalled()
    expect(wake).toHaveBeenCalledWith(40_000)
    expect(ledgerOf(h.store.raw()).entries.get(TWEET)?.settling['request-a']).toBeDefined()

    expect(h.clock.fireNext()).toBe(11_500)
    await vi.waitFor(() => expect(h.search).toHaveBeenCalledWith(1))
    await vi.waitFor(() =>
      expect(ledgerOf(h.store.raw()).entries.get(TWEET)?.inProgress.size).toBe(0),
    )
  })

  it('bounds a far-future settle timer and rechecks its deadline after clock rollback', async () => {
    const wake = vi.fn<ClearWakePort['schedule']>(async () => {})
    const h = makeHarness({ wake: { schedule: wake } })
    await seed(h.coordinator)
    await bind(h.coordinator)
    const observedAt = MAX_CLEAR_CLOCK_DELAY_MS + 1000
    const dueAt = observedAt + 1500
    h.clock.set(observedAt)
    await h.coordinator.recordTerminal({
      tweetId: TWEET,
      requestId: 'request-a',
      downloadId: 1,
      outcome: 'complete',
      at: observedAt,
    })
    h.clock.calls.length = 0
    h.clock.set(0)
    wake.mockClear()

    await reconcileOnBoot(h.restart(), new Set())

    expect(wake).toHaveBeenCalledWith(dueAt)
    expect(h.clock.calls).toHaveLength(1)
    expect(h.clock.calls[0]?.at).toBe(MAX_CLEAR_CLOCK_DELAY_MS)

    // Even a browser overflow firing the callback early cannot forge dueAt.
    const premature = h.clock.calls.shift()
    if (premature === undefined) throw new Error('Missing bounded timer')
    premature.callback()
    await Promise.resolve()
    expect(h.search).not.toHaveBeenCalled()
    expect(h.clock.calls[0]?.at).toBe(MAX_CLEAR_CLOCK_DELAY_MS)

    h.clock.set(MAX_CLEAR_CLOCK_DELAY_MS)
    h.clock.fireNext()
    await Promise.resolve()
    expect(h.search).not.toHaveBeenCalled()
    expect(h.clock.calls[0]?.at).toBe(dueAt)

    h.clock.fireNext()
    await vi.waitFor(() => expect(h.search).toHaveBeenCalledWith(1))
    await vi.waitFor(() =>
      expect(ledgerOf(h.store.raw()).entries.get(TWEET)?.inProgress.size).toBe(0),
    )
  })

  it('does not forge a settle timestamp when wall time rolls back during the probe', async () => {
    const h = makeHarness()
    await seed(h.coordinator)
    await bind(h.coordinator)
    h.search
      .mockImplementationOnce(async () => {
        h.clock.set(0)
        return { state: 'complete', exists: true }
      })
      .mockResolvedValue({ state: 'complete', exists: true })
    await h.coordinator.recordTerminal({
      tweetId: TWEET,
      requestId: 'request-a',
      downloadId: 1,
      outcome: 'complete',
    })

    h.clock.fireNext()
    await vi.waitFor(() => expect(h.search).toHaveBeenCalledTimes(1))
    expect(ledgerOf(h.store.raw()).entries.get(TWEET)?.settling['request-a']).toBeDefined()
    expect(h.clock.calls[0]?.at).toBe(10 + 1500)

    h.clock.fireNext()
    await vi.waitFor(() => expect(h.search).toHaveBeenCalledTimes(2))
    await vi.waitFor(() =>
      expect(ledgerOf(h.store.raw()).entries.get(TWEET)?.inProgress.size).toBe(0),
    )
  })

  it('rebinds persisted live handles without reopening terminal evidence', async () => {
    const h = makeHarness()
    await seed(h.coordinator)
    const before = h.store.raw()
    await expect(
      h.coordinator.rebindPersistedHandle({
        tweetId: TWEET,
        requestId: 'untracked',
        downloadId: 7,
      }),
    ).resolves.toBeUndefined()
    expect(h.store.raw()).toEqual(before)
    await h.coordinator.rebindPersistedHandle({
      tweetId: TWEET,
      requestId: 'request-a',
      downloadId: 7,
    })
    expect(ledgerOf(h.store.raw()).entries.get(TWEET)?.handles['request-a']?.downloadId).toBe(7)

    await h.coordinator.recordTerminal({
      tweetId: TWEET,
      requestId: 'request-a',
      downloadId: 7,
      outcome: 'failed',
    })
    const terminal = h.store.raw()
    await h.coordinator.rebindPersistedHandle({
      tweetId: TWEET,
      requestId: 'request-a',
      downloadId: 7,
    })
    expect(h.store.raw()).toEqual(terminal)
  })

  it('aborts a seed on storage failure and the serial lane recovers', async () => {
    const h = makeHarness()
    h.store.failNext()
    await expect(seed(h.coordinator)).rejects.toThrow('storage down')
    expect(ledgerOf(h.store.raw()).entries.size).toBe(0)
    await seed(h.coordinator, { tweetId: SECOND_TWEET })
    expect(ledgerOf(h.store.raw()).entries.has(SECOND_TWEET)).toBe(true)
  })

  it('establishes the recurring projection wake before an outbox commit', async () => {
    const order: string[] = []
    const store = makeStorage(undefined, {
      onCommit: () => order.push('commit'),
    })
    const h = makeHarness(
      {
        projectionWake: {
          ensure: async () => {
            order.push('wake')
          },
        },
      },
      store,
    )
    await seed(h.coordinator, {
      manualScopes: ['bookmark'],
      automaticScopes: [],
    })
    order.length = 0

    await h.coordinator.failUnbound({
      tweetId: TWEET,
      requestId: 'request-a',
    })

    expect(order.slice(0, 2)).toEqual(['wake', 'commit'])
  })

  it('serializes overlapping seeds without a lost update', async () => {
    const h = makeHarness()
    await Promise.all([
      seed(h.coordinator),
      seed(h.coordinator, { tweetId: SECOND_TWEET, expected: ['request-b'] }),
    ])
    expect([...ledgerOf(h.store.raw()).entries.keys()].toSorted()).toEqual([TWEET, SECOND_TWEET])
  })

  it('rejects invalid active seeds but safely ignores an all-tombstoned new entry', async () => {
    const tombstoned: ClearLedgerStore = {
      version: 1,
      entries: {},
      tombstones: {
        [TWEET]: {
          bookmark: { tweetId: TWEET, scope: 'bookmark', state: 'cleared', at: 1 },
        },
      },
    }
    const store = makeStorage(tombstoned)
    const h = makeHarness({}, store)
    const result = await seed(h.coordinator)
    expect(ledgerOf(store.raw()).entries.size).toBe(0)
    expect(result.trackedByTweet.size).toBe(0)
    await expect(seed(h.coordinator, { expected: [] })).rejects.toThrow('unique and nonempty')
    await expect(
      h.coordinator.seed({
        byTweet: new Map([[TWEET, ['a']]]),
        startingByTweet: new Map([[TWEET, ['a']]]),
        manualScopes: [],
        automaticScopes: ['bookmark', 'bookmark'],
        crossListAutomaticScopes: [],
      }),
    ).rejects.toThrow('unique')
    await expect(
      h.coordinator.seed({
        byTweet: new Map([[TWEET, ['a']]]),
        startingByTweet: new Map([[TWEET, ['b']]]),
        manualScopes: [],
        automaticScopes: ['bookmark'],
        crossListAutomaticScopes: [],
      }),
    ).rejects.toThrow('expected subset')
  })

  it('rejects oversized seeds before opening durable storage', async () => {
    const h = makeHarness()
    await expect(
      seed(h.coordinator, {
        expected: Array.from({ length: 65 }, (_, index) => `request-${index}`),
      }),
    ).rejects.toThrow('at most 64 request ids')
    const byTweet = new Map(
      Array.from({ length: 513 }, (_, index) => [String(index + 1), [`request-${index}`]]),
    )
    await expect(
      h.coordinator.seed({
        byTweet,
        startingByTweet: byTweet,
        manualScopes: [],
        automaticScopes: ['bookmark'],
        crossListAutomaticScopes: [],
      }),
    ).rejects.toThrow('at most 512 tweets')
    expect(h.store.bootstrap).not.toHaveBeenCalled()
  })

  it('repairs a manual Worklist from verified pre-outbox tombstones only', async () => {
    const projectScopeState = vi.fn<NonNullable<ClearCoordinatorDeps['projectScopeState']>>(
      async () => {},
    )
    const store = makeStorage({
      version: 1,
      entries: {},
      tombstones: {
        [TWEET]: {
          bookmark: { tweetId: TWEET, scope: 'bookmark', state: 'cleared', at: 7 },
          like: { tweetId: TWEET, scope: 'like', state: 'uncertain', at: 8 },
        },
      },
    } satisfies ClearLedgerStore)
    const h = makeHarness({ projectScopeState }, store)

    await seed(h.coordinator, {
      manualScopes: ['bookmark', 'like'],
      automaticScopes: [],
    })

    expect(projectScopeState).toHaveBeenCalledTimes(1)
    expect(projectScopeState).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 1,
        revision: expect.any(Number),
        tweetId: TWEET,
        scope: 'bookmark',
        state: 'cleared',
        at: 7,
      }),
    )
  })

  it('retains an outbox row when an untyped caller omits the required sink', async () => {
    const store = makeStorage({
      version: 1,
      entries: {},
      tombstones: {
        [TWEET]: {
          bookmark: { tweetId: TWEET, scope: 'bookmark', state: 'cleared', at: 7 },
        },
      },
    } satisfies ClearLedgerStore)
    const h = makeHarness({ projectScopeState: undefined as never }, store)

    await seed(h.coordinator, { manualScopes: ['bookmark'], automaticScopes: [] })

    await expect(store.backend.listWorklistProjections()).resolves.toEqual([
      expect.objectContaining({ tweetId: TWEET, scope: 'bookmark', state: 'cleared' }),
    ])
  })

  it('proves exact handle binding, is idempotent, and rejects a duplicate owner', async () => {
    const h = makeHarness()
    await h.coordinator.seed({
      byTweet: new Map([
        [TWEET, ['a']],
        [SECOND_TWEET, ['b']],
      ]),
      startingByTweet: new Map([
        [TWEET, ['a']],
        [SECOND_TWEET, ['b']],
      ]),
      manualScopes: [],
      automaticScopes: ['bookmark'],
      crossListAutomaticScopes: [],
    })
    await bind(h.coordinator, 'a', 7)
    await bind(h.coordinator, 'a', 7)
    await expect(bind(h.coordinator, 'b', 7, SECOND_TWEET)).rejects.toThrow('Could not bind')
    expect(ledgerOf(h.store.raw()).entries.get(TWEET)?.handles.a?.downloadId).toBe(7)
  })

  it('accepts Chrome download id zero through terminal and boot reconciliation', async () => {
    const terminal = makeHarness()
    await seed(terminal.coordinator)
    await bind(terminal.coordinator, 'request-a', 0)
    await terminal.coordinator.recordTerminal({
      tweetId: TWEET,
      requestId: 'request-a',
      downloadId: 0,
      outcome: 'complete',
    })
    terminal.clock.fireNext()
    await vi.waitFor(() =>
      expect(ledgerOf(terminal.store.raw()).entries.get(TWEET)?.inProgress.size).toBe(0),
    )

    const boot = makeHarness()
    await seed(boot.coordinator)
    await bind(boot.coordinator, 'request-a', 0)
    await reconcileOnBoot(boot.coordinator, new Set())
    expect(ledgerOf(boot.store.raw()).entries.get(TWEET)?.settling['request-a']).toMatchObject({
      downloadId: 0,
    })
    boot.clock.fireNext()
    await vi.waitFor(() =>
      expect(ledgerOf(boot.store.raw()).entries.get(TWEET)?.inProgress.size).toBe(0),
    )
  })

  it('ignores a terminal from a replaced handle', async () => {
    const h = makeHarness()
    await seed(h.coordinator)
    await bind(h.coordinator, 'request-a', 1)
    await bind(h.coordinator, 'request-a', 2)
    await h.coordinator.recordTerminal({
      tweetId: TWEET,
      requestId: 'request-a',
      downloadId: 1,
      outcome: 'failed',
    })
    const entry = ledgerOf(h.store.raw()).entries.get(TWEET)!
    expect(entry.failed.size).toBe(0)
    expect(entry.handles['request-a']?.downloadId).toBe(2)
  })

  it('arms durable recovery before persisting a settle witness, then starts its fast timer', async () => {
    const events: string[] = []
    const store = makeStorage(undefined, {
      onCommit: () => events.push('write'),
    })
    const clock = makeClock()
    const eventClock: ClearClock = {
      now: clock.now,
      schedule: (callback, delay) => {
        const witness = ledgerOf(store.raw()).entries.get(TWEET)?.settling['request-a']
        events.push(`schedule:${witness?.downloadId ?? 'missing'}`)
        clock.schedule(callback, delay)
      },
    }
    const h = makeHarness(
      {
        clock: eventClock,
        wake: {
          schedule: async () => {
            const witness = ledgerOf(store.raw()).entries.get(TWEET)?.settling['request-a']
            events.push(`alarm:${witness?.downloadId ?? 'missing'}`)
          },
        },
      },
      store,
    )
    await seed(h.coordinator)
    await bind(h.coordinator)
    events.length = 0
    await h.coordinator.recordTerminal({
      tweetId: TWEET,
      requestId: 'request-a',
      downloadId: 1,
      outcome: 'complete',
    })
    expect(events).toEqual(['alarm:missing', 'write', 'schedule:1'])
  })

  it.each<{
    label: string
    row: ClearDownloadRow | undefined | Error
    expected: 'settling' | 'failed' | 'handle'
  }>([
    { label: 'complete', row: { state: 'complete', exists: true }, expected: 'settling' },
    { label: 'interrupted', row: { state: 'interrupted' }, expected: 'failed' },
    { label: 'deleted', row: { state: 'complete', exists: false }, expected: 'failed' },
    { label: 'missing', row: undefined, expected: 'failed' },
    { label: 'in progress', row: { state: 'in_progress' }, expected: 'handle' },
    { label: 'search error', row: new Error('api'), expected: 'handle' },
  ])('reconciles a boot handle: $label', async ({ row, expected }) => {
    const h = makeHarness()
    await seed(h.coordinator)
    await bind(h.coordinator)
    h.search.mockImplementation(async () => {
      if (row instanceof Error) throw row
      return row
    })
    await reconcileOnBoot(h.coordinator, new Set())
    const entry = ledgerOf(h.store.raw()).entries.get(TWEET)!
    expect(
      entry.settling['request-a'] !== undefined
        ? 'settling'
        : entry.failed.has('request-a')
          ? 'failed'
          : 'handle',
    ).toBe(expected)
  })

  it('does not fail a live seed created while boot probes its snapshot', async () => {
    const h = makeHarness()
    await seed(h.coordinator)
    await bind(h.coordinator)
    h.search.mockImplementationOnce(async () => {
      await seed(h.coordinator, { expected: ['request-b'] })
      return { state: 'in_progress' }
    })

    await reconcileOnBoot(h.coordinator, new Set())

    const entry = ledgerOf(h.store.raw()).entries.get(TWEET)!
    expect(entry.inProgress.has('request-b')).toBe(true)
    expect(entry.failed.has('request-b')).toBe(false)
  })

  it('fails the seed-before-bind restart gap unless retry owns it', async () => {
    const failed = makeHarness()
    await seed(failed.coordinator)
    await reconcileOnBoot(failed.coordinator, new Set())
    expect(ledgerOf(failed.store.raw()).entries.get(TWEET)?.failed.has('request-a')).toBe(true)

    const retained = makeHarness()
    await seed(retained.coordinator)
    await reconcileOnBoot(retained.coordinator, new Set(['request-a']))
    expect(ledgerOf(retained.store.raw()).entries.get(TWEET)?.inProgress.has('request-a')).toBe(
      true,
    )
  })

  it('lets durable retry ownership supersede an interrupted prior witness', async () => {
    const h = makeHarness()
    await seed(h.coordinator)
    await bind(h.coordinator)
    h.search.mockResolvedValue({ state: 'interrupted' })
    await reconcileOnBoot(h.coordinator, new Set(['request-a']))
    expect(h.search).not.toHaveBeenCalled()
    const entry = ledgerOf(h.store.raw()).entries.get(TWEET)!
    expect(entry.handles['request-a']?.downloadId).toBe(1)
    expect(entry.failed.has('request-a')).toBe(false)
  })

  it('keeps a settle witness on transient search failure, then retries', async () => {
    const h = makeHarness()
    await seed(h.coordinator)
    await bind(h.coordinator)
    await h.coordinator.recordTerminal({
      tweetId: TWEET,
      requestId: 'request-a',
      downloadId: 1,
      outcome: 'complete',
    })
    h.search.mockRejectedValueOnce(new Error('transient')).mockResolvedValueOnce({
      state: 'complete',
      exists: true,
    })
    h.clock.fireNext()
    await vi.waitFor(() => expect(h.clock.calls).toHaveLength(1))
    expect(ledgerOf(h.store.raw()).entries.get(TWEET)?.settling['request-a']).toBeDefined()
    h.clock.fireNext()
    await vi.waitFor(() =>
      expect(ledgerOf(h.store.raw()).entries.get(TWEET)?.inProgress.size).toBe(0),
    )
  })

  it('retries a settle after a transient ledger write failure', async () => {
    const h = makeHarness()
    await seed(h.coordinator)
    await bind(h.coordinator)
    await h.coordinator.recordTerminal({
      tweetId: TWEET,
      requestId: 'request-a',
      downloadId: 1,
      outcome: 'complete',
    })
    h.store.failNext()
    h.clock.fireNext()
    await vi.waitFor(() => expect(h.clock.calls).toHaveLength(1))
    expect(ledgerOf(h.store.raw()).entries.get(TWEET)?.settling['request-a']).toBeDefined()
    h.clock.fireNext()
    await vi.waitFor(() =>
      expect(ledgerOf(h.store.raw()).entries.get(TWEET)?.inProgress.size).toBe(0),
    )
  })

  it('recovers reserved to retryable and attempted to uncertain tombstone', async () => {
    const h = makeHarness()
    await makeReady(h, { automaticScopes: ['bookmark', 'like'] })
    let ledger = ledgerOf(h.store.raw())
    ledger = reserveClear(ledger, TWEET, 'bookmark', h.clock.now())
    ledger = attemptReservedClear(ledger, TWEET, 'bookmark', h.clock.now())
    ledger = reserveClear(ledger, TWEET, 'like', h.clock.now())
    h.store.replace(coordinatorRaw(ledger, { ...initialSafety, attemptAts: [h.clock.now()] }))
    await reconcileOnBoot(h.restart(), new Set())
    const after = ledgerOf(h.store.raw()).entries.get(TWEET)!
    expect(after.clear.bookmark).toBe('uncertain')
    expect(after.clear.like).toBe('failed')
  })

  it('rechecks completion after Locate and withholds Clear after a racing re-seed', async () => {
    const h = makeHarness()
    await makeReady(h)
    h.locateClearTweet.mockImplementation(async () => {
      await seed(h.coordinator, { expected: ['request-b'] })
      return [mounted(1, [{ scope: 'bookmark', state: 'actionable' }])]
    })
    await driveFromSafetyWake(h.coordinator)
    expect(h.clearTweetInTab).not.toHaveBeenCalled()
    expect(ledgerOf(h.store.raw()).entries.get(TWEET)?.inProgress.has('request-b')).toBe(true)
  })

  it('reopens a stable request id before a replacement start can race Clear', async () => {
    const h = makeHarness()
    await makeReady(h)
    h.locateClearTweet.mockResolvedValue([mounted(1, [{ scope: 'bookmark', state: 'actionable' }])])
    const result = await seed(h.coordinator)
    expect(result.trackedByTweet.get(TWEET)).toEqual(new Set(['request-a']))
    const entry = ledgerOf(h.store.raw()).entries.get(TWEET)!
    expect(entry.inProgress.has('request-a')).toBe(true)
    expect(entry.done.has('request-a')).toBe(false)
    expect(entry.handles['request-a']).toBeUndefined()
    await driveFromSafetyWake(h.coordinator)
    expect(h.clearTweetInTab).not.toHaveBeenCalled()
  })

  it('preserves settled expected-only prerequisites while reopening actual starts', async () => {
    const h = makeHarness()
    await seed(h.coordinator, {
      expected: ['request-a', 'request-b'],
      starting: ['request-a', 'request-b'],
    })
    await bind(h.coordinator, 'request-a', 1)
    await bind(h.coordinator, 'request-b', 2)
    await h.coordinator.recordTerminal({
      tweetId: TWEET,
      requestId: 'request-a',
      downloadId: 1,
      outcome: 'complete',
    })
    await h.coordinator.recordTerminal({
      tweetId: TWEET,
      requestId: 'request-b',
      downloadId: 2,
      outcome: 'complete',
    })
    h.clock.fireNext()
    h.clock.fireNext()
    await vi.waitFor(() =>
      expect(ledgerOf(h.store.raw()).entries.get(TWEET)?.inProgress.size).toBe(0),
    )
    await seed(h.coordinator, {
      expected: ['request-a', 'request-b'],
      starting: ['request-a'],
    })
    const entry = ledgerOf(h.store.raw()).entries.get(TWEET)!
    expect(entry.inProgress.has('request-a')).toBe(true)
    expect(entry.done.has('request-a')).toBe(false)
    expect(entry.inProgress.has('request-b')).toBe(false)
    expect(entry.done.has('request-b')).toBe(true)
  })

  it('allows only one CAS winner across concurrent drives when result persistence fails', async () => {
    const h = makeHarness()
    await makeReady(h)
    h.locateClearTweet.mockResolvedValue([mounted(1, [{ scope: 'bookmark', state: 'actionable' }])])
    // reservation, Attempted, then the first result write
    h.store.failAfter(3)
    const outcomes = await Promise.allSettled([
      driveFromSafetyWake(h.coordinator),
      driveFromSafetyWake(h.coordinator),
    ])
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1)
    expect(h.clearTweetInTab).toHaveBeenCalledTimes(1)
    expect(ledgerOf(h.store.raw()).tombstones.get(TWEET)?.get('bookmark')?.state).toBe('cleared')
  })

  it('serializes whole drives so stale already-clear cannot steal an actionable reservation', async () => {
    const h = makeHarness()
    await makeReady(h)
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    h.locateClearTweet
      .mockImplementationOnce(async () => {
        await held
        return [mounted(1, [{ scope: 'bookmark', state: 'actionable' }])]
      })
      .mockResolvedValue([mounted(2, [{ scope: 'bookmark', state: 'already-clear' }])])

    const actionable = driveFromSafetyWake(h.coordinator)
    await vi.waitFor(() => expect(h.locateClearTweet).toHaveBeenCalledTimes(1))
    const stale = driveFromSafetyWake(h.coordinator)
    release()
    await Promise.all([actionable, stale])

    expect(h.clearTweetInTab).toHaveBeenCalledTimes(1)
    expect(h.clearTweetInTab).toHaveBeenCalledWith(1, TWEET, ['bookmark'], false)
    expect(ledgerOf(h.store.raw()).tombstones.get(TWEET)?.get('bookmark')?.state).toBe('cleared')
  })

  it('never sends on an issuance write failure, then releases and retries', async () => {
    const h = makeHarness()
    await makeReady(h)
    h.locateClearTweet.mockResolvedValue([mounted(1, [{ scope: 'bookmark', state: 'actionable' }])])
    // The reservation commits. The combined Attempted + budget charge does not.
    h.store.failAfter(2)

    await expect(driveFromSafetyWake(h.coordinator)).rejects.toThrow('storage down')

    const state = stateOf(h.store.raw())
    expect(h.clearTweetInTab).not.toHaveBeenCalled()
    expect(state.completion.entries.get(TWEET)?.clear.bookmark).toBe('failed')
    expect(state.safety.attemptAts).toEqual([])

    await driveFromSafetyWake(h.coordinator)
    expect(h.clearTweetInTab).toHaveBeenCalledTimes(1)
    expect(ledgerOf(h.store.raw()).tombstones.get(TWEET)?.get('bookmark')?.state).toBe('cleared')
  })

  it('fail-stops siblings and retries the exact known terminal result', async () => {
    let postTerminalDelay = 2000
    const h = makeHarness({ postTerminalDelay: () => postTerminalDelay })
    await makeReady(h)
    await makeReady(h, { tweetId: SECOND_TWEET, expected: ['request-b'] })
    h.locateClearTweet.mockImplementation(async (tweetId) => [
      mounted(tweetId === TWEET ? 1 : 2, [{ scope: 'bookmark', state: 'actionable' }]),
    ])
    const terminalAt = h.clock.now()
    // Reservation, atomic issuance, then atomic terminal feedback.
    h.store.failAfter(3)

    await expect(driveFromSafetyWake(h.coordinator)).rejects.toThrow('storage down')

    const attempted = stateOf(h.store.raw())
    expect(h.clearTweetInTab).toHaveBeenCalledTimes(1)
    const sentTweet = h.clearTweetInTab.mock.calls[0]![1]
    const siblingTweet = sentTweet === TWEET ? SECOND_TWEET : TWEET
    expect(attempted.completion.entries.get(sentTweet)?.clear.bookmark).toBe('attempted')
    expect(attempted.safety.attemptAts.at(-1)).toBe(terminalAt)
    expect(attempted.safety.nextAttemptAt).toBe(0)

    h.clock.set(terminalAt + 500)
    postTerminalDelay = 4000
    await driveFromVisibilityPulse(h.coordinator, siblingTweet === TWEET ? 1 : 2, [siblingTweet])

    const persisted = stateOf(h.store.raw())
    expect(h.clearTweetInTab).toHaveBeenCalledTimes(1)
    expect(persisted.completion.tombstones.get(sentTweet)?.get('bookmark')).toMatchObject({
      state: 'cleared',
      at: terminalAt,
    })
    expect(persisted.safety.nextAttemptAt).toBe(terminalAt + 2000)
    expect(persisted.completion.entries.get(siblingTweet)?.clear.bookmark).toBe('none')
  })

  it('autonomously retries a failed exact terminal write', async () => {
    let postTerminalDelay = 2000
    const h = makeHarness({ postTerminalDelay: () => postTerminalDelay })
    await makeReady(h)
    await makeReady(h, { tweetId: SECOND_TWEET, expected: ['request-b'] })
    h.locateClearTweet.mockImplementation(async (tweetId) => [
      mounted(tweetId === TWEET ? 1 : 2, [{ scope: 'bookmark', state: 'actionable' }]),
    ])
    const terminalAt = h.clock.now()
    h.store.failAfter(3)

    await expect(driveFromSafetyWake(h.coordinator)).rejects.toThrow('storage down')
    const sentTweet = h.clearTweetInTab.mock.calls[0]![1]
    const siblingTweet = sentTweet === TWEET ? SECOND_TWEET : TWEET
    expect(stateOf(h.store.raw()).completion.entries.get(sentTweet)?.clear.bookmark).toBe(
      'attempted',
    )
    expect(h.clock.calls).toContainEqual(expect.objectContaining({ at: terminalAt + 1000 }))

    postTerminalDelay = 4000
    h.clock.set(terminalAt + 5000)
    h.clock.fireNext()
    await vi.waitFor(() =>
      expect(
        stateOf(h.store.raw()).completion.tombstones.get(sentTweet)?.get('bookmark'),
      ).toMatchObject({ state: 'cleared', at: terminalAt }),
    )
    expect(stateOf(h.store.raw()).safety.nextAttemptAt).toBe(terminalAt + 2000)
    await vi.waitFor(() =>
      expect(h.clock.calls).toContainEqual(expect.objectContaining({ at: terminalAt + 5000 })),
    )
    h.clock.fireNext()
    await vi.waitFor(() => expect(h.clearTweetInTab).toHaveBeenCalledTimes(2))
    expect(h.clearTweetInTab).toHaveBeenLastCalledWith(
      sentTweet === TWEET ? 2 : 1,
      siblingTweet,
      ['bookmark'],
      false,
    )
  })

  it('paces each scope separately across a worker restart', async () => {
    const bothScopesOn = settings({
      clearOnSave: true,
      autoUnbookmarkOnSave: true,
      autoUnlikeOnSave: true,
    })
    const h = makeHarness()
    h.setSettings(bothScopesOn)
    await makeReady(h, { automaticScopes: ['bookmark', 'like'] })
    h.locateClearTweet.mockResolvedValue([
      mounted(1, [
        { scope: 'bookmark', state: 'actionable' },
        { scope: 'like', state: 'actionable' },
      ]),
    ])
    const terminalAt = h.clock.now()

    await driveFromSafetyWake(h.coordinator)

    expect(h.clearTweetInTab).toHaveBeenCalledTimes(1)
    expect(h.clearTweetInTab).toHaveBeenLastCalledWith(1, TWEET, ['bookmark'], false)
    expect(stateOf(h.store.raw()).safety.nextAttemptAt).toBe(terminalAt + 2000)

    const wake = vi.fn<ClearWakePort['schedule']>(async () => {})
    const restarted = makeClearCoordinator({
      ...durableDeps(h.store),
      sessionMarker: {
        get: async () => ({ version: 1, browserSessionEpoch: 1 }),
        set: async () => {},
      },
      wake: { schedule: wake },
      clock: h.clock,
      postTerminalDelay: () => 2000,
      downloadSearch: { search: h.search },
      settings: { withClearPolicyTurn: async (callback) => await callback(bothScopesOn) },
      tabs: { locateClearTweet: h.locateClearTweet, clearTweetInTab: h.clearTweetInTab },
    })
    h.clock.set(terminalAt + 1999)
    await driveFromSafetyWake(restarted)
    expect(h.clearTweetInTab).toHaveBeenCalledTimes(1)
    expect(wake).toHaveBeenCalledWith(terminalAt + 2000)

    h.clock.set(terminalAt + 2000)
    await driveFromSafetyWake(restarted)
    expect(h.clearTweetInTab).toHaveBeenCalledTimes(2)
    expect(h.clearTweetInTab).toHaveBeenLastCalledWith(1, TWEET, ['like'], false)
  })

  it('keeps a persisted attempt fail-closed when wall time rolls backward on restart', async () => {
    const wake = vi.fn<ClearWakePort['schedule']>(async () => {})
    const h = makeHarness({ wake: { schedule: wake } })
    h.setSettings(
      settings({
        clearOnSave: true,
        autoUnbookmarkOnSave: true,
        autoUnlikeOnSave: true,
      }),
    )
    await makeReady(h, { automaticScopes: ['bookmark', 'like'] })
    h.locateClearTweet.mockResolvedValue([
      mounted(1, [
        { scope: 'bookmark', state: 'actionable' },
        { scope: 'like', state: 'actionable' },
      ]),
    ])
    h.clock.set(10_000)
    await h.coordinator.onSafetyWake({ retryOwnedRequestIds: new Set() })
    expect(h.clearTweetInTab).toHaveBeenCalledTimes(1)

    wake.mockClear()
    h.clock.set(9_999)
    await h.restart().onSafetyWake({ retryOwnedRequestIds: new Set() })

    expect(h.clearTweetInTab).toHaveBeenCalledTimes(1)
    expect(wake).toHaveBeenCalledWith(12_000)
  })

  it('enforces the exact rolling-minute and browser-session caps', async () => {
    const minuteWake = vi.fn<ClearWakePort['schedule']>(async () => {})
    const minute = makeHarness({ wake: { schedule: minuteWake } })
    await makeReady(minute)
    minute.locateClearTweet.mockResolvedValue([
      mounted(1, [{ scope: 'bookmark', state: 'actionable' }]),
    ])
    const minuteState = stateOf(minute.store.raw())
    const attemptAts = Array.from({ length: 20 }, (_, index) => 1491 + index)
    minute.store.replace(
      coordinatorRaw(minuteState.completion, {
        ...initialSafety,
        attemptAts,
        nextAttemptAt: attemptAts.at(-1)! + 2000,
      }),
    )
    minute.clock.set(61_490)
    const minuteCoordinator = minute.restart()

    await driveFromSafetyWake(minuteCoordinator)
    expect(minute.clearTweetInTab).not.toHaveBeenCalled()
    expect(minuteWake).toHaveBeenCalledWith(61_491)

    minute.clock.set(61_491)
    await driveFromSafetyWake(minuteCoordinator)
    expect(minute.clearTweetInTab).toHaveBeenCalledTimes(1)
    expect(stateOf(minute.store.raw()).safety.attemptAts).toHaveLength(21)

    const sessionWake = vi.fn<ClearWakePort['schedule']>(async () => {})
    const session = makeHarness({ wake: { schedule: sessionWake } })
    await makeReady(session)
    sessionWake.mockClear()
    session.locateClearTweet.mockResolvedValue([
      mounted(1, [{ scope: 'bookmark', state: 'actionable' }]),
    ])
    const sessionState = stateOf(session.store.raw())
    session.clock.set(100_000)
    session.store.replace(
      coordinatorRaw(sessionState.completion, {
        ...initialSafety,
        attemptAts: Array.from({ length: 200 }, (_, index) => index + 1),
        nextAttemptAt: 2200,
      }),
    )
    const sessionCoordinator = session.restart()

    await driveFromSafetyWake(sessionCoordinator)
    expect(session.clearTweetInTab).not.toHaveBeenCalled()
    expect(session.locateClearTweet).not.toHaveBeenCalled()
    expect(sessionWake).not.toHaveBeenCalled()
    expect(stateOf(session.store.raw()).completion.entries.get(TWEET)?.clear.bookmark).toBe('none')
  })

  it('trips 15-minute backoff after the third bad outcome', async () => {
    const wake = vi.fn<ClearWakePort['schedule']>(async () => {})
    const h = makeHarness({ wake: { schedule: wake } })
    await makeReady(h)
    await makeReady(h, { tweetId: SECOND_TWEET, expected: ['request-b'] })
    const before = stateOf(h.store.raw())
    h.store.replace(coordinatorRaw(before.completion, { ...before.safety, failureStreak: 2 }))
    const restarted = h.restart()
    h.locateClearTweet.mockImplementation(async (tweetId) => [
      mounted(tweetId === TWEET ? 1 : 2, [{ scope: 'bookmark', state: 'actionable' }]),
    ])
    h.clearTweetInTab.mockResolvedValueOnce(undefined)
    const terminalAt = h.clock.now()

    await driveFromSafetyWake(restarted)

    const blocked = stateOf(h.store.raw())
    expect(h.clearTweetInTab).toHaveBeenCalledTimes(1)
    const sentTweet = h.clearTweetInTab.mock.calls[0]![1]
    const siblingTweet = sentTweet === TWEET ? SECOND_TWEET : TWEET
    expect(blocked.safety).toMatchObject({
      failureStreak: 0,
      backoffLevel: 1,
      blockedUntil: terminalAt + 15 * 60_000,
    })
    expect(wake).toHaveBeenCalledWith(terminalAt + 15 * 60_000)

    h.clock.set(terminalAt + 15 * 60_000 - 1)
    const siblingTabId = siblingTweet === TWEET ? 1 : 2
    await driveFromVisibilityPulse(restarted, siblingTabId, [siblingTweet])
    expect(h.clearTweetInTab).toHaveBeenCalledTimes(1)
    expect(stateOf(h.store.raw()).completion.entries.get(siblingTweet)?.clear.bookmark).toBe('none')

    h.clock.set(terminalAt + 15 * 60_000)
    await driveFromVisibilityPulse(restarted, siblingTabId, [siblingTweet])
    expect(h.locateClearTweet).toHaveBeenLastCalledWith(
      siblingTweet,
      ['bookmark'],
      siblingTabId,
      false,
    )
    expect(h.clearTweetInTab).toHaveBeenCalledTimes(2)
  })

  it('resets a proven browser session but external adoption preserves its budget', async () => {
    const priorSafety = {
      ...initialClearSafetyState(3)!,
      attemptAts: [1, 2],
      nextAttemptAt: 2002,
      failureStreak: 2,
      backoffLevel: 1,
      blockedUntil: 9,
    }
    const startupStore = makeStorage(coordinatorRaw(emptyCompletionLedger(), priorSafety))
    const startupMarker = vi.fn<ClearSessionMarkerStorage['set']>(async () => {})
    const startup = makeHarness(
      {
        sessionMarker: { get: async () => null, set: startupMarker },
      },
      startupStore,
    ).coordinator

    await startup.listClearLog()
    expect(startupMarker).not.toHaveBeenCalled()
    await startup.onBrowserStartup()

    expect(stateOf(startupStore.raw()).safety).toMatchObject({
      browserSessionEpoch: 4,
      attemptAts: [],
      failureStreak: 2,
      backoffLevel: 1,
      blockedUntil: 9,
    })
    expect(startupMarker).toHaveBeenCalledWith({ version: 1, browserSessionEpoch: 4 })

    const adoptedStore = makeStorage(coordinatorRaw(emptyCompletionLedger(), priorSafety))
    const adoptedMarker = vi.fn<ClearSessionMarkerStorage['set']>(async () => {})
    const adopted = makeHarness(
      {
        sessionMarker: { get: async () => null, set: adoptedMarker },
      },
      adoptedStore,
    ).coordinator
    await adopted.resumeOnBoot({
      retryOwnedRequestIds: new Set(),
      adoptExternalSession: true,
    })
    await adopted.onBrowserStartup()

    expect(stateOf(adoptedStore.raw()).safety).toEqual(priorSafety)
    expect(adoptedMarker).toHaveBeenCalledTimes(1)
    expect(adoptedMarker).toHaveBeenCalledWith({ version: 1, browserSessionEpoch: 3 })
  })

  it('cuts over a valid legacy ledger without deleting it and rejects corrupt source state', async () => {
    const legacy: ClearLedgerStore = {
      version: 1,
      entries: {},
      tombstones: {
        [TWEET]: {
          bookmark: { tweetId: TWEET, scope: 'bookmark', state: 'cleared', at: 7 },
        },
      },
    }
    const events: string[] = []
    const migratedStore = makeStorage(null, {
      onBootstrap: () => events.push('idb:bootstrap'),
      onPointerSet: () => events.push('pointer:set'),
    })
    const remove = vi.fn<LegacyCompletionStorage['remove']>(async () => {
      events.push('legacy:remove')
    })
    const migrated = makeHarness(
      { legacyStorage: { get: async () => legacy, remove } },
      migratedStore,
    ).coordinator

    expect(await migrated.listClearLog()).toEqual([
      {
        tweetId: TWEET,
        scope: 'bookmark',
        mechanism: 'dom-click',
        at: 7,
        permalink: `https://x.com/i/status/${TWEET}`,
      },
    ])
    expect(events).toEqual(['idb:bootstrap', 'pointer:set'])
    expect(remove).not.toHaveBeenCalled()
    expect(
      stateOf(migratedStore.raw()).completion.tombstones.get(TWEET)?.get('bookmark')?.state,
    ).toBe('cleared')

    const corruptStore = makeStorage(null)
    const corruptRemove = vi.fn<LegacyCompletionStorage['remove']>(async () => {})
    const corrupt = makeHarness(
      {
        legacyStorage: {
          get: async () => ({ version: 9, entries: {}, tombstones: {} }),
          remove: corruptRemove,
        },
      },
      corruptStore,
    ).coordinator
    await expect(corrupt.listClearLog()).rejects.toBeInstanceOf(ClearCoordinatorCorruptionError)
    expect(corruptStore.bootstrap).not.toHaveBeenCalled()
    expect(corruptStore.pointerStorage.set).not.toHaveBeenCalled()
    expect(corruptRemove).not.toHaveBeenCalled()
  })

  it('recovers an attempted Clear at persisted logical time after clock rollback', async () => {
    const h = makeHarness()
    await makeReady(h)
    const at = h.clock.now()
    const before = stateOf(h.store.raw())
    let completion = reserveClear(before.completion, TWEET, 'bookmark', at)
    completion = attemptReservedClear(completion, TWEET, 'bookmark', at)
    const safety = issueClear(before.safety, at)
    if (safety === undefined) throw new Error('test issuance failed')
    h.store.replace(coordinatorRaw(completion, safety))
    h.store.commit.mockClear()
    h.clock.set(at - 1)

    const setMarker = vi.fn<ClearSessionMarkerStorage['set']>(async () => {})
    const restarted = makeClearCoordinator({
      ...durableDeps(h.store),
      sessionMarker: { get: async () => null, set: setMarker },
      clock: h.clock,
      postTerminalDelay: () => 2000,
      downloadSearch: { search: h.search },
      settings: { withClearPolicyTurn: async (callback) => await callback(CLEAR_ON) },
      tabs: { locateClearTweet: async () => [], clearTweetInTab: h.clearTweetInTab },
    })

    await reconcileOnBoot(restarted, new Set())

    const recovered = stateOf(h.store.raw())
    expect(recovered.completion.tombstones.get(TWEET)?.get('bookmark')).toMatchObject({
      state: 'uncertain',
      at,
    })
    expect(recovered.safety).toMatchObject({
      browserSessionEpoch: 1,
      attemptAts: [at],
      failureStreak: 1,
      nextAttemptAt: at + 2000,
    })
    expect(setMarker).not.toHaveBeenCalled()

    await restarted.onBrowserStartup()
    const opened = stateOf(h.store.raw()).safety
    expect(opened).toMatchObject({
      browserSessionEpoch: 2,
      attemptAts: [],
      failureStreak: 1,
      nextAttemptAt: at + 2000,
    })
    expect(setMarker).toHaveBeenCalledWith({ version: 1, browserSessionEpoch: 2 })
    const durableWrites = h.store.commit.mock.invocationCallOrder
    const markerWrites = setMarker.mock.invocationCallOrder
    expect(durableWrites[0]).toBeLessThan(markerWrites[0]!)
    expect(markerWrites[0]).toBeLessThan(durableWrites.at(-1)!)
    expect(durableWrites.at(-1)).toBeLessThan(markerWrites.at(-1)!)
  })

  it('uses a policy snapshot for Locate, then releases reservation after a toggle', async () => {
    const h = makeHarness()
    await makeReady(h)
    h.locateClearTweet.mockImplementation(async () => {
      h.setSettings(settings({ clearOnSave: false }))
      return [mounted(1, [{ scope: 'bookmark', state: 'actionable' }])]
    })
    await driveFromSafetyWake(h.coordinator)
    expect(h.locateClearTweet).toHaveBeenCalledTimes(1)
    expect(h.clearTweetInTab).not.toHaveBeenCalled()
    expect(ledgerOf(h.store.raw()).entries.get(TWEET)?.clear.bookmark).toBe('failed')
  })

  it('releases a reservation when the policy authority fails, then retries', async () => {
    const h = makeHarness()
    await makeReady(h)
    h.locateClearTweet.mockResolvedValue([mounted(1, [{ scope: 'bookmark', state: 'actionable' }])])
    const policyError = new Error('settings unavailable')
    let calls = 0
    const coordinator = makeClearCoordinator({
      ...durableDeps(h.store),
      sessionMarker: {
        get: async () => ({ version: 1, browserSessionEpoch: 1 }),
        set: async () => {},
      },
      clock: h.clock,
      postTerminalDelay: () => 2000,
      downloadSearch: { search: h.search },
      tabs: { locateClearTweet: h.locateClearTweet, clearTweetInTab: h.clearTweetInTab },
      settings: {
        withClearPolicyTurn: async (callback) => {
          calls += 1
          if (calls === 2) throw policyError
          return await callback(CLEAR_ON)
        },
      },
    })
    await expect(driveFromSafetyWake(coordinator)).rejects.toBe(policyError)
    expect(h.clearTweetInTab).not.toHaveBeenCalled()
    expect(ledgerOf(h.store.raw()).entries.get(TWEET)?.clear.bookmark).toBe('failed')

    await driveFromSafetyWake(coordinator)
    expect(h.clearTweetInTab).toHaveBeenCalledTimes(1)
    expect(ledgerOf(h.store.raw()).tombstones.get(TWEET)?.get('bookmark')?.state).toBe('cleared')
  })

  it('releases a reservation when a concurrent seed makes issuance incomplete', async () => {
    const h = makeHarness()
    await makeReady(h)
    h.locateClearTweet.mockResolvedValue([mounted(1, [{ scope: 'bookmark', state: 'actionable' }])])
    let releasePolicy!: () => void
    let enteredPolicy!: () => void
    const policyHeld = new Promise<void>((resolve) => {
      releasePolicy = resolve
    })
    const policyEntered = new Promise<void>((resolve) => {
      enteredPolicy = resolve
    })
    let calls = 0
    const coordinator = makeClearCoordinator({
      ...durableDeps(h.store),
      sessionMarker: {
        get: async () => ({ version: 1, browserSessionEpoch: 1 }),
        set: async () => {},
      },
      clock: h.clock,
      postTerminalDelay: () => 2000,
      downloadSearch: { search: h.search },
      tabs: { locateClearTweet: h.locateClearTweet, clearTweetInTab: h.clearTweetInTab },
      settings: {
        withClearPolicyTurn: async (callback) => {
          calls += 1
          if (calls === 2) {
            enteredPolicy()
            await policyHeld
          }
          return await callback(CLEAR_ON)
        },
      },
    })

    const drive = driveFromSafetyWake(coordinator)
    await policyEntered
    expect(ledgerOf(h.store.raw()).entries.get(TWEET)?.clear.bookmark).toBe('reserved')
    await seed(coordinator, { expected: ['request-b'], starting: ['request-b'] })
    releasePolicy()
    await drive

    expect(h.clearTweetInTab).not.toHaveBeenCalled()
    expect(ledgerOf(h.store.raw()).entries.get(TWEET)?.clear.bookmark).toBe('failed')

    await bind(coordinator, 'request-b', 2)
    await coordinator.recordTerminal({
      tweetId: TWEET,
      requestId: 'request-b',
      downloadId: 2,
      outcome: 'complete',
    })
    h.clock.fireNext()
    await vi.waitFor(() => expect(h.clearTweetInTab).toHaveBeenCalledTimes(1))
    expect(ledgerOf(h.store.raw()).tombstones.get(TWEET)?.get('bookmark')?.state).toBe('cleared')
  })

  it.each([
    {
      label: 'manual ignores the automatic switch',
      input: { manualScopes: ['bookmark'] as Scope[], automaticScopes: [] as Scope[] },
      value: settings({ clearOnSave: true, autoUnbookmarkOnSave: false }),
      sends: 1,
      allLists: false,
    },
    {
      label: 'automatic requires its switch',
      input: { manualScopes: [] as Scope[], automaticScopes: ['bookmark'] as Scope[] },
      value: settings({ clearOnSave: true, autoUnbookmarkOnSave: false }),
      sends: 0,
      allLists: false,
    },
    {
      label: 'cross-list automatic requires and forwards cross-list policy',
      input: {
        manualScopes: [] as Scope[],
        automaticScopes: ['bookmark'] as Scope[],
        crossListAutomaticScopes: ['bookmark'] as Scope[],
      },
      value: settings({
        clearOnSave: true,
        autoUnbookmarkOnSave: true,
        clearAllListsOnSave: true,
      }),
      sends: 1,
      allLists: true,
    },
  ])('$label', async ({ input, value, sends, allLists }) => {
    const h = makeHarness()
    h.setSettings(value)
    await makeReady(h, input)
    h.locateClearTweet.mockResolvedValue([mounted(1, [{ scope: 'bookmark', state: 'actionable' }])])
    await driveFromSafetyWake(h.coordinator)
    expect(h.clearTweetInTab.mock.calls).toEqual(
      sends === 0 ? [] : [[1, TWEET, ['bookmark'], allLists]],
    )
  })

  it('locates all tabs, chooses one actionable target, and sends once', async () => {
    const h = makeHarness()
    await makeReady(h)
    h.locateClearTweet.mockResolvedValue([
      mounted(1, [{ scope: 'bookmark', state: 'unknown' }]),
      mounted(2, [{ scope: 'bookmark', state: 'actionable' }]),
      mounted(3, [{ scope: 'bookmark', state: 'actionable' }]),
    ])
    await driveFromSafetyWake(h.coordinator)
    expect(h.locateClearTweet).toHaveBeenCalledTimes(1)
    expect(h.clearTweetInTab).toHaveBeenCalledTimes(1)
    expect(h.clearTweetInTab).toHaveBeenCalledWith(2, TWEET, ['bookmark'], false)
  })

  it('records positive already-clear evidence without a destructive send', async () => {
    const h = makeHarness()
    await makeReady(h)
    h.locateClearTweet.mockResolvedValue([
      mounted(1, [{ scope: 'bookmark', state: 'already-clear' }]),
    ])
    await driveFromSafetyWake(h.coordinator)
    expect(h.clearTweetInTab).not.toHaveBeenCalled()
    expect(ledgerOf(h.store.raw()).entries.has(TWEET)).toBe(false)
    expect(ledgerOf(h.store.raw()).tombstones.has(TWEET)).toBe(false)
  })

  it('projects manual Locate already-clear evidence and excludes automatic scopes', async () => {
    const manualProjection = vi.fn<NonNullable<ClearCoordinatorDeps['projectScopeState']>>(
      async () => {},
    )
    const manual = makeHarness({ projectScopeState: manualProjection })
    await makeReady(manual, { manualScopes: ['bookmark'], automaticScopes: [] })
    manualProjection.mockClear()
    manual.locateClearTweet.mockResolvedValue([
      mounted(1, [{ scope: 'bookmark', state: 'already-clear' }]),
    ])

    await driveFromSafetyWake(manual.coordinator)

    expect(manualProjection).toHaveBeenCalledWith(
      expect.objectContaining({
        tweetId: TWEET,
        scope: 'bookmark',
        state: 'cleared',
      }),
    )

    const automaticProjection = vi.fn<NonNullable<ClearCoordinatorDeps['projectScopeState']>>(
      async () => {},
    )
    const automatic = makeHarness({ projectScopeState: automaticProjection })
    await makeReady(automatic)
    automatic.locateClearTweet.mockResolvedValue([
      mounted(1, [{ scope: 'bookmark', state: 'already-clear' }]),
    ])

    await driveFromSafetyWake(automatic.coordinator)

    expect(automaticProjection).not.toHaveBeenCalled()
  })

  it('lets an actionable tab beat stale already-clear evidence from another tab', async () => {
    const h = makeHarness()
    await makeReady(h)
    h.locateClearTweet.mockResolvedValue([
      mounted(1, [{ scope: 'bookmark', state: 'already-clear' }]),
      mounted(2, [{ scope: 'bookmark', state: 'actionable' }]),
    ])
    await driveFromSafetyWake(h.coordinator)
    expect(h.clearTweetInTab).toHaveBeenCalledWith(2, TWEET, ['bookmark'], false)
    expect(ledgerOf(h.store.raw()).tombstones.get(TWEET)?.get('bookmark')?.state).toBe('cleared')
  })

  it('contains projection failure and still drives the authoritative Clear', async () => {
    const projectScopeState = vi.fn<NonNullable<ClearCoordinatorDeps['projectScopeState']>>(
      async () => {
        throw new Error('worklist unavailable')
      },
    )
    const h = makeHarness({ projectScopeState })
    h.locateClearTweet.mockResolvedValue([mounted(1, [{ scope: 'bookmark', state: 'actionable' }])])
    await seed(h.coordinator, { manualScopes: ['bookmark'], automaticScopes: [] })
    await bind(h.coordinator)
    await h.coordinator.recordTerminal({
      tweetId: TWEET,
      requestId: 'request-a',
      downloadId: 1,
      outcome: 'complete',
    })
    h.clock.fireNext()
    await vi.waitFor(() => expect(h.clearTweetInTab).toHaveBeenCalledTimes(1))
    expect(projectScopeState).toHaveBeenCalledWith(
      expect.objectContaining({
        tweetId: TWEET,
        scope: 'bookmark',
        state: 'downloaded',
      }),
    )
  })

  it('maps a lost destructive reply to uncertain and never falls through', async () => {
    const h = makeHarness()
    await makeReady(h)
    h.locateClearTweet.mockResolvedValue([
      mounted(1, [{ scope: 'bookmark', state: 'actionable' }]),
      mounted(2, [{ scope: 'bookmark', state: 'actionable' }]),
    ])
    h.clearTweetInTab.mockResolvedValue(undefined)
    await driveFromSafetyWake(h.coordinator)
    expect(h.clearTweetInTab).toHaveBeenCalledTimes(1)
    expect(ledgerOf(h.store.raw()).entries.has(TWEET)).toBe(false)
    expect(ledgerOf(h.store.raw()).tombstones.get(TWEET)?.get('bookmark')?.state).toBe('uncertain')
  })

  it('retains no-target work; a pulse targets only its sender tab', async () => {
    const h = makeHarness()
    await makeReady(h)
    await driveFromSafetyWake(h.coordinator)
    expect(ledgerOf(h.store.raw()).entries.has(TWEET)).toBe(true)
    h.locateClearTweet.mockResolvedValue([
      mounted(7, [{ scope: 'bookmark', state: 'actionable' }]),
      mounted(8, [{ scope: 'bookmark', state: 'actionable' }]),
    ])
    await h.coordinator.onVisibilityPulse(7, [TWEET])
    expect(h.clearTweetInTab).toHaveBeenCalledWith(7, TWEET, ['bookmark'], false)
  })

  it('adopts a missing session marker without widening a targeted pulse', async () => {
    const h = makeHarness()
    await makeReady(h)
    await makeReady(h, { tweetId: SECOND_TWEET, expected: ['request-b'] })
    const setMarker = vi.fn<ClearSessionMarkerStorage['set']>(async () => {})
    h.locateClearTweet.mockImplementation(async (_tweetId) => [
      mounted(7, [{ scope: 'bookmark', state: 'actionable' }]),
    ])
    const restarted = makeClearCoordinator({
      ...durableDeps(h.store),
      sessionMarker: { get: async () => null, set: setMarker },
      clock: h.clock,
      postTerminalDelay: () => 2000,
      downloadSearch: { search: h.search },
      settings: { withClearPolicyTurn: async (callback) => await callback(CLEAR_ON) },
      tabs: { locateClearTweet: h.locateClearTweet, clearTweetInTab: h.clearTweetInTab },
    })

    await restarted.onVisibilityPulse(7, [TWEET])

    expect(setMarker).toHaveBeenCalledWith({ version: 1, browserSessionEpoch: 1 })
    expect(h.locateClearTweet).toHaveBeenCalledTimes(1)
    expect(h.locateClearTweet).toHaveBeenCalledWith(TWEET, ['bookmark'], 7, false)
    expect(h.clearTweetInTab).toHaveBeenCalledWith(7, TWEET, ['bookmark'], false)
    expect(ledgerOf(h.store.raw()).entries.has(SECOND_TWEET)).toBe(true)
  })

  it('adopts and drives a named safety wake', async () => {
    const h = makeHarness()
    await makeReady(h)
    const setMarker = vi.fn<ClearSessionMarkerStorage['set']>(async () => {})
    h.locateClearTweet.mockResolvedValue([mounted(1, [{ scope: 'bookmark', state: 'actionable' }])])
    const restarted = makeClearCoordinator({
      ...durableDeps(h.store),
      sessionMarker: { get: async () => null, set: setMarker },
      clock: h.clock,
      postTerminalDelay: () => 2000,
      downloadSearch: { search: h.search },
      settings: { withClearPolicyTurn: async (callback) => await callback(CLEAR_ON) },
      tabs: { locateClearTweet: h.locateClearTweet, clearTweetInTab: h.clearTweetInTab },
    })

    await restarted.onSafetyWake({ retryOwnedRequestIds: new Set() })

    expect(setMarker).toHaveBeenCalledWith({ version: 1, browserSessionEpoch: 1 })
    expect(h.clearTweetInTab).toHaveBeenCalledTimes(1)
  })

  it('resumes durable ready Clear work after adopting an external session on boot', async () => {
    const h = makeHarness()
    await makeReady(h)
    const setMarker = vi.fn<ClearSessionMarkerStorage['set']>(async () => {})
    h.locateClearTweet.mockResolvedValue([mounted(1, [{ scope: 'bookmark', state: 'actionable' }])])
    const restarted = makeClearCoordinator({
      ...durableDeps(h.store),
      sessionMarker: { get: async () => null, set: setMarker },
      clock: h.clock,
      postTerminalDelay: () => 2000,
      downloadSearch: { search: h.search },
      settings: { withClearPolicyTurn: async (callback) => await callback(CLEAR_ON) },
      tabs: { locateClearTweet: h.locateClearTweet, clearTweetInTab: h.clearTweetInTab },
    })

    await restarted.resumeOnBoot({
      retryOwnedRequestIds: new Set(),
      adoptExternalSession: true,
    })

    expect(setMarker).toHaveBeenCalledWith({ version: 1, browserSessionEpoch: 1 })
    expect(h.clearTweetInTab).toHaveBeenCalledWith(1, TWEET, ['bookmark'], false)
  })

  it('keeps Settings writes free while boot reconciliation waits on Chrome', async () => {
    const h = makeHarness()
    await seed(h.coordinator)
    await bind(h.coordinator, 'request-a', 7)

    let currentSettings: unknown = CLEAR_ON
    const settingsSet = vi.fn<SettingsRecord['set']>(async (next) => {
      currentSettings = next
    })
    const writer = makeSettingsWriter({
      get: async () => currentSettings,
      set: settingsSet,
    })
    let signalSearch!: () => void
    const searchStarted = new Promise<void>((resolve) => {
      signalSearch = resolve
    })
    let releaseSearch!: () => void
    const searchCanFinish = new Promise<void>((resolve) => {
      releaseSearch = resolve
    })
    const restarted = makeClearCoordinator({
      ...durableDeps(h.store),
      sessionMarker: {
        get: async () => ({ version: 1, browserSessionEpoch: 1 }),
        set: async () => {},
      },
      clock: h.clock,
      postTerminalDelay: () => 2000,
      downloadSearch: {
        search: async () => {
          signalSearch()
          await searchCanFinish
          return { state: 'in_progress' }
        },
      },
      settings: { withClearPolicyTurn: writer.withSnapshotTurn },
      tabs: { locateClearTweet: h.locateClearTweet, clearTweetInTab: h.clearTweetInTab },
    })

    const resume = restarted.resumeOnBoot({
      retryOwnedRequestIds: new Set(),
      adoptExternalSession: false,
    })
    await searchStarted
    const update = writer.update({ theme: 'dark' })

    await vi.waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(1))
    await expect(update).resolves.toMatchObject({ theme: 'dark' })

    releaseSearch()
    await resume
  })

  it('a pulse for unknown or incomplete ids never consults policy', async () => {
    const h = makeHarness()
    await seed(h.coordinator)
    await h.coordinator.onVisibilityPulse(7, [TWEET, SECOND_TWEET])
    expect(h.settingsTurns).not.toHaveBeenCalled()
    expect(h.locateClearTweet).not.toHaveBeenCalled()
  })

  it('seed compacts expired automatic failures and keeps tombstones', async () => {
    const tombstoned: ClearLedgerStore = {
      version: 1,
      entries: {},
      tombstones: {
        [SECOND_TWEET]: {
          bookmark: { tweetId: SECOND_TWEET, scope: 'bookmark', state: 'uncertain', at: 1 },
        },
      },
    }
    const store = makeStorage(tombstoned)
    const h = makeHarness({}, store)
    await seed(h.coordinator)
    await h.coordinator.failUnbound({ tweetId: TWEET, requestId: 'request-a' })
    h.clock.set(24 * 60 * 60 * 1000 + 10)
    await seed(h.coordinator, { tweetId: '43', expected: ['request-b'] })
    const ledger = ledgerOf(store.raw())
    expect(ledger.entries.has(TWEET)).toBe(false)
    expect(ledger.entries.has('43')).toBe(true)
    expect(ledger.tombstones.get(SECOND_TWEET)?.get('bookmark')).toBeDefined()
  })

  it('preserves corrupt raw storage and blocks every mutation', async () => {
    const raw = { version: 9, entries: {}, tombstones: {} }
    const store = makeStorage(raw)
    const h = makeHarness({}, store)
    await expect(seed(h.coordinator)).rejects.toBeInstanceOf(ClearCoordinatorCorruptionError)
    expect(store.raw()).toBe(raw)
    expect(store.bootstrap).not.toHaveBeenCalled()
    expect(store.commit).not.toHaveBeenCalled()
  })

  it('rejects an issued budget with no terminal pacing deadline', async () => {
    const h = makeHarness()
    await makeReady(h)
    const completion = stateOf(h.store.raw()).completion
    const raw = coordinatorRaw(completion, {
      ...initialSafety,
      attemptAts: [h.clock.now()],
      nextAttemptAt: 0,
    })
    h.store.replace(raw)
    h.store.commit.mockClear()
    const restarted = h.restart()

    await expect(driveFromSafetyWake(restarted)).rejects.toBeInstanceOf(
      ClearCoordinatorCorruptionError,
    )

    expect(h.store.raw()).toBe(raw)
    expect(h.store.commit).not.toHaveBeenCalled()
    expect(h.locateClearTweet).not.toHaveBeenCalled()
    expect(h.clearTweetInTab).not.toHaveBeenCalled()
  })

  it('rejects mismatched backoff and terminal-feedback tuples', async () => {
    const terminalCompletion: CompletionLedger = {
      entries: new Map(),
      tombstones: new Map([
        [
          TWEET,
          new Map([
            ['bookmark', { tweetId: TWEET, scope: 'bookmark', state: 'cleared', at: 10_000 }],
          ]),
        ],
      ]),
    }
    const invalid = [
      coordinatorRaw(emptyCompletionLedger(), {
        ...initialSafety,
        backoffLevel: 3,
        blockedUntil: 0,
      }),
      coordinatorRaw(terminalCompletion, {
        ...initialSafety,
        attemptAts: [0],
        nextAttemptAt: 2000,
      }),
    ]

    for (const raw of invalid) {
      const store = makeStorage(raw)
      const coordinator = makeHarness({}, store).coordinator
      // oxlint-disable-next-line no-await-in-loop -- each corrupt raw is independently preserved
      await expect(coordinator.listClearLog()).rejects.toBeInstanceOf(
        ClearCoordinatorCorruptionError,
      )
      expect(store.raw()).toBe(raw)
      expect(store.bootstrap).not.toHaveBeenCalled()
      expect(store.commit).not.toHaveBeenCalled()
    }
  })
})
