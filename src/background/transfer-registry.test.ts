import { describe, expect, it, vi } from 'vitest'
import {
  emptyTransferRegistryStore,
  type TransferRegistryStore,
  type TransferRequest,
} from '../core/download/transfer-registry'
import { mediaRequestId, sidecarRequestId } from '../core/download/request-identity'
import {
  makeTransferRegistry,
  TransferRegistryCorruptionError,
  TransferRegistryTransitionError,
  type TransferRegistryDeps,
} from './transfer-registry'

const request = (over: Partial<TransferRequest> = {}): TransferRequest => ({
  id: 'media-1',
  projectionId: 'projection-1',
  url: 'https://video.example/a.mp4',
  filename: 'a.mp4',
  mode: 'direct',
  historyPolicy: 'record',
  ...over,
})
const sweepItem = (id: string, postId: string) => ({
  id,
  platform: 'x' as const,
  postId,
  author: 'alice',
  type: 'photo' as const,
  url: `https://pbs.twimg.com/media/${id}.jpg`,
  ext: 'jpg',
  index: 0,
})
const profile = {
  profileId: 'profile-1',
  rpcUrl: 'http://127.0.0.1:6800/jsonrpc',
  secret: 's',
}
const options = { split: 4 }
const reservation = { 'media-1': { profile, gid: '0000000000000001', options } }
const fetchedOwner = (requestId: string, projectionId: string) => ({
  tag: 'transfer' as const,
  requestId,
  projectionId,
  attempt: 0,
  since: 10,
})

function setup(initial: unknown = emptyTransferRegistryStore) {
  let value = initial
  let now = 10
  let nextWriteError: Error | undefined
  const writes: TransferRegistryStore[] = []
  const deps: TransferRegistryDeps = {
    storage: {
      get: vi.fn<TransferRegistryDeps['storage']['get']>(async () => value),
      set: vi.fn<TransferRegistryDeps['storage']['set']>(async (next) => {
        if (nextWriteError !== undefined) {
          const error = nextWriteError
          nextWriteError = undefined
          throw error
        }
        value = next
        writes.push(next)
      }),
    },
    clock: {
      now: () => now,
      schedule: vi.fn<TransferRegistryDeps['clock']['schedule']>(() => () => {}),
    },
    wake: {
      schedule: vi.fn<TransferRegistryDeps['wake']['schedule']>(async () => {}),
    },
    downloads: {
      search: vi.fn<TransferRegistryDeps['downloads']['search']>(async (id) => [
        { id, state: 'in_progress', exists: true },
      ]),
      cancel: vi.fn<TransferRegistryDeps['downloads']['cancel']>(async () => {}),
    },
    startRetry: vi.fn<TransferRegistryDeps['startRetry']>(async () => ({
      tag: 'started',
      downloadId: 33,
    })),
    reserveFetched: vi.fn<TransferRegistryDeps['reserveFetched']>(async () => ({
      tag: 'reserved',
      leaseId: 'lease-1',
    })),
    startReservedFetched: vi.fn<TransferRegistryDeps['startReservedFetched']>(async () => ({
      tag: 'started',
      downloadId: 33,
    })),
    startAria2: vi.fn<TransferRegistryDeps['startAria2']>(async (_request, token) => ({
      tag: 'started',
      gid: token.gid!,
    })),
    discardRecoveredStaging: vi.fn<TransferRegistryDeps['discardRecoveredStaging']>(async () => {}),
    refreshUrl: vi.fn<TransferRegistryDeps['refreshUrl']>(async (entry) => entry.url),
    observeTerminalFetched: vi.fn<TransferRegistryDeps['observeTerminalFetched']>(
      async () => undefined,
    ),
    releaseFetched: vi.fn<TransferRegistryDeps['releaseFetched']>(async () => {}),
    releaseAutonomousFetched: vi.fn<TransferRegistryDeps['releaseAutonomousFetched']>(
      async () => {},
    ),
    aria2: {
      tellStatus: vi.fn<TransferRegistryDeps['aria2']['tellStatus']>(async (_entry, gid) => ({
        gid,
        status: 'active',
        completedLength: '1',
        totalLength: '2',
      })),
    },
    clear: {
      bindTransfer: vi.fn<TransferRegistryDeps['clear']['bindTransfer']>(async () => {}),
      abandonTransfer: vi.fn<TransferRegistryDeps['clear']['abandonTransfer']>(async () => {}),
    },
    projectTerminal: vi.fn<TransferRegistryDeps['projectTerminal']>(async () => {}),
    projectLegacyTerminal: vi.fn<TransferRegistryDeps['projectLegacyTerminal']>(async () => {}),
  }
  return {
    deps,
    writes,
    value: () => value as TransferRegistryStore,
    setNow: (value_: number) => {
      now = value_
    },
    failNextWrite: (error: Error) => {
      nextWriteError = error
    },
  }
}

type Registry = ReturnType<typeof makeTransferRegistry>
const preparePermitted = async (registry: Registry, ...input: Parameters<Registry['prepare']>) => {
  const prepared = await registry.prepare(...input)
  await registry.releasePreparedStarts(prepared.launches)
  return prepared
}

describe('TransferRegistry v4 adapter', () => {
  it('arms the release watchdog before persisting newly permitted work', async () => {
    const s = setup()
    const registry = makeTransferRegistry(s.deps)
    await registry.ready()
    const prepared = await registry.prepare([request()])
    vi.mocked(s.deps.wake.schedule).mockClear()
    const persist = vi.mocked(s.deps.storage.set).getMockImplementation()!
    let wakeWasLatched = false
    vi.mocked(s.deps.storage.set).mockImplementation(async (next) => {
      if (next.entries['media-1']?.phase.tag === 'direct-ready')
        wakeWasLatched = vi.mocked(s.deps.wake.schedule).mock.calls.some(([at]) => at === 6_010)
      await persist(next)
    })

    await registry.releasePreparedStarts(prepared.launches)
    expect(wakeWasLatched).toBe(true)
  })

  it('keeps an armed call wake durable and renews it without a second call', async () => {
    const s = setup()
    const registry = makeTransferRegistry(s.deps)
    await registry.ready()
    const prepared = await preparePermitted(registry, [request()])
    await registry.armDirectCall('media-1', prepared.launches[0]!)
    expect(s.deps.wake.schedule).toHaveBeenLastCalledWith(6_010)

    s.setNow(6_010)
    expect(s.deps.clock.now()).toBe(6_010)
    await registry.onWake()

    expect(s.deps.wake.schedule).toHaveBeenLastCalledWith(12_010)
    expect(s.deps.startRetry).not.toHaveBeenCalled()
  })

  it('uses the armed-call watchdog to reach boot quarantine after worker death', async () => {
    const s = setup()
    const first = makeTransferRegistry(s.deps)
    await first.ready()
    const prepared = await preparePermitted(first, [request()])
    await first.armDirectCall('media-1', prepared.launches[0]!)
    expect(s.deps.wake.schedule).toHaveBeenLastCalledWith(6_010)

    // The watchdog is the only promised next event after this cut.
    const restarted = makeTransferRegistry(s.deps)
    await restarted.ready()

    expect(s.value().entries['media-1']?.phase).toMatchObject({
      tag: 'unresolved-launch',
      reason: 'worker-restart',
    })
  })

  it('latches normalized retry work before its boot write', async () => {
    const initial: TransferRegistryStore = {
      ...emptyTransferRegistryStore,
      entries: {
        'media-1': {
          request: request(),
          createdAt: 1,
          phase: { tag: 'retry-refreshing', attempt: 1, since: 1, priorDownloadId: 7 },
        },
      },
    }
    const s = setup(initial)
    const persist = vi.mocked(s.deps.storage.set).getMockImplementation()!
    vi.mocked(s.deps.storage.set).mockImplementation(async (next) => {
      expect(s.deps.wake.schedule).toHaveBeenCalledWith(6_010)
      await persist(next)
    })

    const registry = makeTransferRegistry(s.deps)
    await registry.ready()

    expect(s.value().entries['media-1']?.phase).toMatchObject({ tag: 'retry-wait', retryAt: 10 })
  })

  it('persists rollback-rebased boot work before arming timers or wake alarms', async () => {
    const old = 1_000_000
    const initial: TransferRegistryStore = {
      version: 4,
      entries: {
        capacity: {
          request: request({
            id: 'capacity',
            projectionId: 'projection-capacity',
            mode: 'fetched',
          }),
          createdAt: old,
          phase: { tag: 'fetched-capacity-wait', attempt: 0, retryAt: old },
        },
        retry: {
          request: request({ id: 'retry', projectionId: 'projection-retry' }),
          createdAt: old,
          phase: { tag: 'retry-wait', attempt: 1, retryAt: old, priorDownloadId: 7 },
        },
        active: {
          request: request({ id: 'active', projectionId: 'projection-active' }),
          createdAt: old,
          phase: { tag: 'active', downloadId: 8, attempt: 0, startedAt: old, nextProbeAt: old },
        },
        terminal: {
          request: request({ id: 'terminal', projectionId: 'projection-terminal' }),
          createdAt: old,
          phase: {
            tag: 'terminal-pending',
            evidence: { tag: 'start-failed' },
            observedAt: old,
            projectAt: old,
          },
        },
        armed: {
          request: request({ id: 'armed', projectionId: 'projection-armed' }),
          createdAt: old,
          phase: { tag: 'launching', attempt: 0, since: old },
        },
      },
      profiles: {},
      legacy: {},
    }
    const s = setup(initial)
    vi.mocked(s.deps.clock.schedule).mockImplementation((_run, _delayMs) => {
      expect(s.writes).not.toHaveLength(0)
      return () => {}
    })

    const registry = makeTransferRegistry(s.deps)
    await registry.ready()

    expect(s.writes).toHaveLength(1)
    expect(s.value().entries.capacity?.phase).toMatchObject({ retryAt: 5_010 })
    expect(s.value().entries.retry?.phase).toMatchObject({ retryAt: 2_010 })
    expect(s.value().entries.active?.phase).toMatchObject({ startedAt: 10, nextProbeAt: 10 })
    expect(s.value().entries.terminal?.phase).toMatchObject({ observedAt: 10, projectAt: 10 })
    expect(s.value().entries.armed?.phase).toEqual({
      tag: 'unresolved-launch',
      attempt: 0,
      since: 10,
      reason: 'worker-restart',
    })
    expect(vi.mocked(s.deps.clock.schedule).mock.calls.map(([, delay]) => delay)).toEqual(
      expect.arrayContaining([0, 2_000, 5_000]),
    )
    expect(s.deps.wake.schedule).toHaveBeenCalledWith(10)
    expect(s.deps.startRetry).not.toHaveBeenCalled()
  })

  it('holds a booted Sweep pre-call state until receipt repair releases it', async () => {
    const s = setup()
    const first = makeTransferRegistry(s.deps)
    await first.ready()
    const item = {
      id: 'media-1',
      platform: 'x' as const,
      postId: '123',
      author: 'alice',
      type: 'photo' as const,
      url: 'https://pbs.twimg.com/media/a.jpg',
      ext: 'jpg',
      index: 0,
    }
    const swept = request({
      mode: 'fetched',
      item,
      sweepReceipt: { receiptId: 'sweep-1', tweetId: '123', scope: 'bookmark' },
    })
    await first.prepareGroups([{ mainId: swept.id, requests: [swept] }])
    expect(s.value().entries[swept.id]?.phase.tag).toBe('fetched-prepared')

    vi.mocked(s.deps.clock.schedule).mockClear()
    const restarted = makeTransferRegistry(s.deps)
    await restarted.ready()
    await Promise.resolve()
    expect(s.deps.clock.schedule).not.toHaveBeenCalled()

    await restarted.confirmSweepOwnership(new Map([['sweep-1', 1]]))
    await restarted.releaseConfirmedSweepStarts()
    expect(s.deps.clock.schedule).toHaveBeenCalledWith(expect.any(Function), 0)
  })

  it('releases only durably confirmed Sweep receipts after the boot barrier opens', async () => {
    const firstItem = sweepItem('media-1', '123')
    const secondItem = sweepItem('media-2', '456')
    const firstRequest = request({
      mode: 'fetched',
      item: firstItem,
      sweepReceipt: { receiptId: 'sweep-1', tweetId: '123', scope: 'bookmark' },
    })
    const secondRequest = request({
      id: 'media-2',
      projectionId: 'projection-2',
      mode: 'fetched',
      item: secondItem,
      sweepReceipt: { receiptId: 'sweep-2', tweetId: '456', scope: 'bookmark' },
    })
    const s = setup()
    const first = makeTransferRegistry(s.deps)
    await first.ready()
    await first.prepare([firstRequest, secondRequest])

    const restarted = makeTransferRegistry(s.deps)
    await restarted.ready()
    await restarted.confirmSweepOwnership(new Map([['sweep-1', 1]]))
    await restarted.releaseConfirmedSweepStarts()
    await restarted.onWake()

    expect(s.deps.reserveFetched).toHaveBeenCalledOnce()
    expect(s.deps.reserveFetched).toHaveBeenCalledWith(
      firstRequest,
      expect.objectContaining({ id: 'media-1' }),
    )
    expect(s.value().entries['media-1']?.phase.tag).toBe('active')
    expect(s.value().entries['media-2']?.phase.tag).toBe('fetched-prepared')
  })

  it('gates a confirmed Sweep terminal projection until Clear boot opens the barrier', async () => {
    const item = sweepItem('media-1', '123')
    const swept = request({
      item,
      sweepReceipt: { receiptId: 'sweep-1', tweetId: '123', scope: 'bookmark' },
    })
    const s = setup({
      version: 4,
      entries: {
        'media-1': {
          request: swept,
          createdAt: 1,
          sweepOwnership: { receiptId: 'sweep-1', clearSeedId: 7 },
          phase: {
            tag: 'terminal-pending',
            evidence: { tag: 'browser', downloadId: 42, state: 'complete' },
            observedAt: 2,
            projectAt: 2,
          },
        },
      },
      profiles: {},
      legacy: {},
    } satisfies TransferRegistryStore)
    const registry = makeTransferRegistry(s.deps)
    await registry.ready()
    await Promise.resolve()
    expect(await registry.listPendingTerminalProjectionIds()).toEqual(['projection-1'])
    await registry.onWake()
    expect(s.deps.projectTerminal).not.toHaveBeenCalled()

    await registry.releaseConfirmedSweepStarts()
    await registry.onWake()
    expect(s.deps.projectTerminal).toHaveBeenCalledOnce()
    expect(s.value().entries['media-1']).toBeUndefined()
    expect(await registry.listPendingTerminalProjectionIds()).toEqual([])
  })

  it('keeps every prepared mode inert across a crash before admission permits it', async () => {
    const direct = request({ id: 'direct-1', projectionId: 'projection-direct' })
    const fetched = request({
      id: 'fetched-1',
      projectionId: 'projection-fetched',
      mode: 'fetched',
    })
    const aria = request({
      id: 'aria-1',
      projectionId: 'projection-aria',
      mode: 'aria2',
    })
    const s = setup()
    const first = makeTransferRegistry(s.deps)
    await first.ready()
    await first.prepare([direct, fetched, aria], {
      'aria-1': { profile, gid: '0000000000000001', options },
    })

    const restarted = makeTransferRegistry(s.deps)
    await restarted.ready()
    await restarted.onWake()

    expect(s.deps.startRetry).not.toHaveBeenCalled()
    expect(s.deps.reserveFetched).not.toHaveBeenCalled()
    expect(s.deps.startReservedFetched).not.toHaveBeenCalled()
    expect(s.deps.startAria2).not.toHaveBeenCalled()
    expect(s.value().entries['direct-1']?.phase.tag).toBe('direct-prepared')
    expect(s.value().entries['fetched-1']?.phase.tag).toBe('fetched-prepared')
    expect(s.value().entries['aria-1']?.phase.tag).toBe('aria2-prepared')
    expect((await restarted.clearRecovery()).retryOwnedRequestIds).toEqual(
      new Set(['direct-1', 'fetched-1', 'aria-1']),
    )
  })

  it('resumes every v4 pre-call mode from durable boot state and persisted aria2 options', async () => {
    const direct = request({ id: 'direct-1', projectionId: 'projection-direct' })
    const fetched = request({
      id: 'fetched-1',
      projectionId: 'projection-fetched',
      mode: 'fetched',
    })
    const aria = request({
      id: 'aria-1',
      projectionId: 'projection-aria',
      mode: 'aria2',
    })
    const ariaOptions = { split: 7, dir: '/persisted' }
    const s = setup()
    vi.mocked(s.deps.startRetry).mockResolvedValue({ tag: 'started', downloadId: 31 })
    vi.mocked(s.deps.startReservedFetched).mockResolvedValue({
      tag: 'started',
      downloadId: 32,
    })
    const first = makeTransferRegistry(s.deps)
    await first.ready()
    const prepared = await first.prepare([direct, fetched, aria], {
      'aria-1': {
        profile,
        gid: '0000000000000001',
        options: ariaOptions,
      },
    })
    await first.releasePreparedStarts(prepared.launches)
    vi.mocked(s.deps.clock.schedule).mockImplementation((run, delayMs) => {
      if (delayMs === 0) queueMicrotask(run)
      return () => {}
    })

    const restarted = makeTransferRegistry(s.deps)
    await restarted.ready()
    await vi.waitFor(() => {
      expect(s.deps.startRetry).toHaveBeenCalledOnce()
      expect(s.deps.startReservedFetched).toHaveBeenCalledOnce()
      expect(s.deps.startAria2).toHaveBeenCalledOnce()
    })
    expect(s.deps.startAria2).toHaveBeenCalledWith(
      aria,
      expect.objectContaining({ id: 'aria-1', gid: '0000000000000001' }),
      expect.objectContaining(profile),
      ariaOptions,
    )
    expect(s.value().entries['direct-1']?.phase.tag).toBe('active')
    expect(s.value().entries['fetched-1']?.phase.tag).toBe('active')
    expect(s.value().entries['aria-1']?.phase.tag).toBe('aria2-active')
  })

  it('never replays any external call after its exact arm survived a crash', async () => {
    const direct = request({ id: 'direct-1', projectionId: 'projection-direct' })
    const fetched = request({
      id: 'fetched-1',
      projectionId: 'projection-fetched',
      mode: 'fetched',
    })
    const aria = request({
      id: 'aria-1',
      projectionId: 'projection-aria',
      mode: 'aria2',
    })
    const s = setup()
    const first = makeTransferRegistry(s.deps)
    await first.ready()
    const prepared = await first.prepare([direct, fetched, aria], {
      'aria-1': {
        profile,
        gid: '0000000000000001',
        options,
      },
    })
    await first.releasePreparedStarts(prepared.launches)
    const byId = new Map(prepared.launches.map((token) => [token.id, token]))
    await first.armDirectCall('direct-1', byId.get('direct-1')!)
    await first.armFetchedCall('fetched-1', byId.get('fetched-1')!, 'lease-1')
    await first.armAria2Call('aria-1', byId.get('aria-1')!)

    const restarted = makeTransferRegistry(s.deps)
    await restarted.ready()
    await restarted.onWake()
    expect(s.deps.startRetry).not.toHaveBeenCalled()
    expect(s.deps.reserveFetched).not.toHaveBeenCalled()
    expect(s.deps.startReservedFetched).not.toHaveBeenCalled()
    expect(s.deps.startAria2).not.toHaveBeenCalled()
    expect(s.deps.aria2.tellStatus).toHaveBeenCalledOnce()
    expect(s.value().entries['direct-1']?.phase.tag).toBe('unresolved-launch')
    expect(s.value().entries['fetched-1']?.phase.tag).toBe('unresolved-launch')
    expect(s.value().entries['aria-1']?.phase.tag).toBe('aria2-active')
  })

  it('never writes a fresh sibling when any artifact in its group is already durable', async () => {
    const s = setup()
    const registry = makeTransferRegistry(s.deps)
    await registry.ready()
    const item = {
      id: 'media-1',
      platform: 'x' as const,
      postId: '123',
      author: 'alice',
      type: 'photo' as const,
      url: 'https://pbs.twimg.com/media/a.jpg',
      ext: 'jpg',
      index: 0,
    }
    const mainId = mediaRequestId(item)
    const main = request({ id: mainId, item, projectionId: 'main-projection' })
    const sidecarId = sidecarRequestId(item)
    const sidecar = request({
      id: sidecarId,
      projectionId: 'sidecar-projection',
      url: 'data:application/json,{}',
      filename: 'a.json',
      historyPolicy: 'off',
    })
    await registry.prepare([main])
    const writesBeforeDuplicate = s.writes.length

    await expect(registry.prepareGroups([{ mainId, requests: [main, sidecar] }])).resolves.toEqual({
      launches: [],
      duplicateMainIds: [mainId],
    })
    expect(s.writes).toHaveLength(writesBeforeDuplicate)
    expect(s.value().entries[sidecarId]).toBeUndefined()

    const afterCrash = makeTransferRegistry(s.deps)
    await afterCrash.ready()
    expect(s.value().entries[sidecarId]).toBeUndefined()
  })

  it('keeps a Fetched capacity wait across boot and retries it from the wake alarm', async () => {
    const s = setup()
    const first = makeTransferRegistry(s.deps)
    await first.ready()
    const token = (await preparePermitted(first, [request({ mode: 'fetched' })])).launches[0]!
    await first.deferLaunch('media-1', token)
    expect(s.value().entries['media-1']?.phase).toEqual({
      tag: 'fetched-capacity-wait',
      attempt: 0,
      retryAt: 5010,
    })
    expect(s.deps.wake.schedule).toHaveBeenLastCalledWith(5010)

    const restarted = makeTransferRegistry(s.deps)
    await restarted.ready()
    expect(s.value().entries['media-1']?.phase.tag).toBe('fetched-capacity-wait')
    vi.mocked(s.deps.reserveFetched).mockResolvedValueOnce({ tag: 'busy' })
    s.setNow(5010)
    await restarted.onWake()
    expect(s.value().entries['media-1']?.phase).toEqual({
      tag: 'fetched-capacity-wait',
      attempt: 0,
      retryAt: 10010,
    })

    s.setNow(10010)
    await restarted.onWake()
    expect(s.deps.reserveFetched).toHaveBeenCalledTimes(2)
    expect(s.deps.startReservedFetched).toHaveBeenCalledOnce()
    expect(s.value().entries['media-1']?.phase).toMatchObject({
      tag: 'active',
      downloadId: 33,
    })
  })

  it('forgets only a boot-quarantined row and releases an unowned terminal Fetched lease', async () => {
    const s = setup()
    const first = makeTransferRegistry(s.deps)
    await first.ready()
    const token = (await preparePermitted(first, [request({ mode: 'fetched' })])).launches[0]!
    await first.armFetchedCall('media-1', token, 'lease-1')
    const recovered = makeTransferRegistry(s.deps)
    await recovered.ready()
    expect(await recovered.inspectRecovery()).toHaveLength(1)
    await expect(recovered.forgetRecovery('media-1')).resolves.toBe(true)
    expect(await recovered.inspectRecovery()).toEqual([])
    vi.mocked(s.deps.observeTerminalFetched).mockResolvedValue({
      tag: 'matched',
      leaseId: 'lease-1',
      owner: fetchedOwner('media-1', 'projection-1'),
      downloadId: 77,
      terminal: true,
    })
    await recovered.onDownloadChanged({
      id: 77,
      state: { current: 'complete' },
    })
    expect(s.deps.releaseAutonomousFetched).toHaveBeenCalledWith(77)
    expect(s.deps.projectTerminal).not.toHaveBeenCalled()
  })

  it('surfaces a crash-held prepared row, retries its Clear close, then unlocks Save', async () => {
    const intent = request({
      item: {
        id: 'media-1',
        platform: 'x',
        postId: 'post-1',
        author: 'alice',
        type: 'video',
        url: 'https://video.example/a.mp4',
        ext: 'mp4',
        index: 0,
      },
    })
    const s = setup()
    const first = makeTransferRegistry(s.deps)
    await first.ready()
    await first.prepare([intent])
    expect(s.value().entries[intent.id]?.phase.tag).toBe('direct-prepared')
    await expect(first.inspectRecovery()).resolves.toEqual([])
    await expect(first.forgetRecovery(intent.id)).resolves.toBe(false)
    expect(s.value().entries[intent.id]?.phase.tag).toBe('direct-prepared')

    const recovered = makeTransferRegistry(s.deps)
    await recovered.ready()
    await expect(recovered.inspectRecovery()).resolves.toEqual([
      {
        id: intent.id,
        kind: 'prepared-launch',
        mode: 'direct',
        createdAt: 10,
      },
    ])
    expect(s.deps.startRetry).not.toHaveBeenCalled()
    vi.mocked(s.deps.clear.abandonTransfer).mockRejectedValueOnce(new Error('worker stopped'))

    await expect(recovered.forgetRecovery(intent.id)).rejects.toThrow('worker stopped')
    expect(s.value().entries[intent.id]?.phase.tag).toBe('forget-pending')
    await expect(recovered.inspectRecovery()).resolves.toEqual([
      {
        id: intent.id,
        kind: 'forget-pending',
        mode: 'direct',
        createdAt: 10,
      },
    ])
    expect(s.deps.clear.abandonTransfer).toHaveBeenCalledWith('post-1', intent.id, undefined)
    expect(s.deps.wake.schedule).toHaveBeenLastCalledWith(6010)

    s.setNow(6010)
    await recovered.onWake()
    expect(s.deps.clear.abandonTransfer).toHaveBeenCalledTimes(2)
    expect(s.value().entries[intent.id]).toBeUndefined()
    await expect(
      recovered.prepare([{ ...intent, projectionId: 'projection-after-forget' }]),
    ).resolves.toMatchObject({
      launches: [expect.objectContaining({ id: intent.id })],
    })
  })

  it('hides a live grouped preparation, then exposes every artifact after restart', async () => {
    const item = {
      id: 'media-1',
      platform: 'x' as const,
      postId: '123',
      author: 'alice',
      type: 'photo' as const,
      url: 'https://pbs.twimg.com/media/a.jpg',
      ext: 'jpg',
      index: 0,
    }
    const mainId = mediaRequestId(item)
    const sidecarId = sidecarRequestId(item)
    const main = request({ id: mainId, item, projectionId: 'main-projection' })
    const sidecar = request({
      id: sidecarId,
      projectionId: 'sidecar-projection',
      url: 'data:application/json,{}',
      filename: 'a.json',
      historyPolicy: 'off',
    })
    const s = setup()
    const live = makeTransferRegistry(s.deps)
    await live.ready()
    await live.prepareGroups([{ mainId, requests: [main, sidecar] }])

    await expect(live.inspectRecovery()).resolves.toEqual([])
    await expect(live.forgetRecovery(mainId)).resolves.toBe(false)

    const restarted = makeTransferRegistry(s.deps)
    await restarted.ready()
    const recovery = await restarted.inspectRecovery()
    expect(recovery.map(({ id }) => id)).toEqual([mainId, sidecarId].toSorted())
    expect(recovery.every(({ kind }) => kind === 'prepared-launch')).toBe(true)
  })

  it('exposes a prepared row when its permit commit fails', async () => {
    const s = setup()
    const registry = makeTransferRegistry(s.deps)
    await registry.ready()
    const prepared = await registry.prepare([request()])
    s.failNextWrite(new Error('storage stopped'))

    await expect(registry.releasePreparedStarts(prepared.launches)).rejects.toThrow(
      'storage stopped',
    )
    await expect(registry.inspectRecovery()).resolves.toEqual([
      {
        id: 'media-1',
        kind: 'prepared-launch',
        mode: 'direct',
        createdAt: 10,
      },
    ])
  })

  it('returns exact persisted sweep intents for boot repair', async () => {
    const s = setup()
    const registry = makeTransferRegistry(s.deps)
    await registry.ready()
    const swept = request({
      sweepReceipt: { receiptId: 'sweep-1', tweetId: '123', scope: 'bookmark' },
    })
    const other = request({ id: 'media-2', projectionId: 'projection-2' })
    await registry.prepare([other, swept])

    await expect(registry.listSweepReceiptIntents()).resolves.toEqual([swept])
  })

  it('persists forget intent and leaves the mutation lane free while Clear hangs', async () => {
    const s = setup()
    const first = makeTransferRegistry(s.deps)
    await first.ready()
    const token = (
      await preparePermitted(first, [
        request({
          item: {
            id: 'media-1',
            platform: 'x',
            postId: 'post-1',
            author: 'alice',
            type: 'video',
            url: 'https://video.example/a.mp4',
            ext: 'mp4',
            index: 0,
          },
        }),
      ])
    ).launches[0]!
    await first.armDirectCall('media-1', token)
    const recovered = makeTransferRegistry(s.deps)
    await recovered.ready()
    let finishAbandon!: () => void
    vi.mocked(s.deps.clear.abandonTransfer).mockReturnValue(
      new Promise<void>((resolve) => {
        finishAbandon = resolve
      }),
    )

    const forgetting = recovered.forgetRecovery('media-1')
    await vi.waitFor(() =>
      expect(s.deps.clear.abandonTransfer).toHaveBeenCalledWith('post-1', 'media-1', undefined),
    )
    expect(s.value().entries['media-1']?.phase.tag).toBe('forget-pending')
    const duplicateForget = recovered.forgetRecovery('media-1')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(s.deps.clear.abandonTransfer).toHaveBeenCalledOnce()
    const independent = recovered.prepare([
      request({
        id: 'media-2',
        projectionId: 'projection-2',
        filename: 'b.mp4',
      }),
    ])
    await expect(independent).resolves.toMatchObject({
      launches: [expect.objectContaining({ id: 'media-2' })],
    })

    finishAbandon()
    await expect(Promise.all([forgetting, duplicateForget])).resolves.toEqual([true, true])
    expect(s.value().entries['media-1']).toBeUndefined()
  })

  it('keeps an exact current forget wake across an unrelated commit and re-drives it', async () => {
    const s = setup()
    const first = makeTransferRegistry(s.deps)
    await first.ready()
    const token = (
      await preparePermitted(first, [
        request({
          item: {
            id: 'media-1',
            platform: 'x',
            postId: 'post-1',
            author: 'alice',
            type: 'video',
            url: 'https://video.example/a.mp4',
            ext: 'mp4',
            index: 0,
          },
        }),
      ])
    ).launches[0]!
    await first.armDirectCall('media-1', token)
    const recovered = makeTransferRegistry(s.deps)
    await recovered.ready()
    vi.mocked(s.deps.clear.abandonTransfer).mockRejectedValueOnce(new Error('worker stopped'))

    await expect(recovered.forgetRecovery('media-1')).rejects.toThrow('worker stopped')
    expect(s.value().entries['media-1']?.phase.tag).toBe('forget-pending')
    expect(s.deps.wake.schedule).toHaveBeenLastCalledWith(6010)

    await recovered.prepare([request({ id: 'media-2', projectionId: 'projection-2' })])
    expect(s.deps.wake.schedule).toHaveBeenLastCalledWith(6010)
    await recovered.onWake()
    expect(s.deps.clear.abandonTransfer).toHaveBeenCalledOnce()

    s.setNow(6010)
    await recovered.onWake()
    await vi.waitFor(() => expect(s.value().entries['media-1']).toBeUndefined())
    expect(s.deps.clear.abandonTransfer).toHaveBeenCalledTimes(2)
  })

  it('keeps an exact legacy forget wake across an unrelated commit and re-drives it', async () => {
    const legacy: TransferRegistryStore = {
      ...emptyTransferRegistryStore,
      legacy: {
        legacy: {
          downloadId: 7,
          startedAt: 1,
          tweetId: 'post-1',
          phase: { tag: 'unresolved' },
        },
      },
    }
    const s = setup(legacy)
    const registry = makeTransferRegistry(s.deps)
    await registry.ready()
    vi.mocked(s.deps.clear.abandonTransfer).mockRejectedValueOnce(new Error('worker stopped'))

    await expect(registry.forgetRecovery('legacy')).rejects.toThrow('worker stopped')
    expect(s.value().legacy.legacy?.phase.tag).toBe('forget-pending')
    expect(s.deps.wake.schedule).toHaveBeenLastCalledWith(6010)

    await registry.prepare([request({ id: 'media-2', projectionId: 'projection-2' })])
    expect(s.deps.wake.schedule).toHaveBeenLastCalledWith(6010)
    await registry.onWake()
    expect(s.deps.clear.abandonTransfer).toHaveBeenCalledOnce()

    s.setNow(6010)
    await registry.onWake()
    await vi.waitFor(() => expect(s.value().legacy.legacy).toBeUndefined())
    expect(s.deps.clear.abandonTransfer).toHaveBeenCalledTimes(2)
    expect(s.deps.clear.abandonTransfer).toHaveBeenLastCalledWith('post-1', 'legacy', 7)
  })

  it('claims an exact Fetched handle before launch quarantine', async () => {
    const s = setup()
    const first = makeTransferRegistry(s.deps)
    await first.ready()
    const token = (await preparePermitted(first, [request({ mode: 'fetched' })])).launches[0]!
    await first.armFetchedCall('media-1', token, 'lease-1')
    await first.bindStarted('media-1', token, { kind: 'browser', id: 7 })
    const recovered = makeTransferRegistry({
      ...s.deps,
      fetchedBoot: [
        {
          tag: 'matched',
          leaseId: 'lease-1',
          owner: {
            tag: 'transfer',
            requestId: 'media-1',
            projectionId: 'projection-1',
            attempt: 0,
            since: 10,
          },
          downloadId: 7,
          terminal: false,
        },
      ],
    })
    await recovered.ready()
    expect(s.value().entries['media-1']?.phase).toMatchObject({
      tag: 'active',
      downloadId: 7,
    })
  })

  it('projects exact terminal Fetched boot evidence without an active probe gap', async () => {
    const s = setup()
    const first = makeTransferRegistry(s.deps)
    await first.ready()
    const token = (await preparePermitted(first, [request({ mode: 'fetched' })])).launches[0]!
    await first.armFetchedCall('media-1', token, 'lease-1')
    await first.bindStarted('media-1', token, { kind: 'browser', id: 7 })
    const recovered = makeTransferRegistry({
      ...s.deps,
      fetchedBoot: [
        {
          tag: 'matched',
          leaseId: 'lease-1',
          owner: fetchedOwner('media-1', 'projection-1'),
          downloadId: 7,
          terminal: true,
          terminalState: 'complete',
        },
      ],
    })

    await recovered.ready()
    await vi.waitFor(() =>
      expect(s.deps.projectTerminal).toHaveBeenCalledWith(
        expect.objectContaining({
          projectionId: 'projection-1',
          evidence: { tag: 'browser', downloadId: 7, state: 'complete' },
        }),
      ),
    )
    expect(s.deps.downloads.search).not.toHaveBeenCalledWith(7)
    expect(s.value().entries['media-1']).toBeUndefined()
  })

  it('binds and projects a terminal Fetched handoff before treating it as orphaned', async () => {
    const s = setup()
    const registry = makeTransferRegistry(s.deps)
    await registry.ready()
    const token = (await preparePermitted(registry, [request({ mode: 'fetched' })])).launches[0]!
    await registry.armFetchedCall('media-1', token, 'lease-1')
    vi.mocked(s.deps.observeTerminalFetched).mockResolvedValue({
      tag: 'matched',
      leaseId: 'lease-1',
      owner: fetchedOwner('media-1', 'projection-1'),
      downloadId: 77,
      terminal: true,
    })

    await registry.onDownloadChanged({ id: 77, state: { current: 'complete' } })

    expect(s.deps.observeTerminalFetched).toHaveBeenCalledWith(77)
    expect(s.deps.releaseAutonomousFetched).not.toHaveBeenCalled()
    expect(s.deps.projectTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        projectionId: 'projection-1',
        evidence: { tag: 'browser', downloadId: 77, state: 'complete' },
      }),
    )
    expect(s.value().entries['media-1']).toBeUndefined()
  })

  it('adopts exact Fetched evidence after a Direct-only boot already quarantined the call', async () => {
    const s = setup()
    const first = makeTransferRegistry(s.deps)
    await first.ready()
    const token = (await preparePermitted(first, [request({ mode: 'fetched' })])).launches[0]!
    await first.armFetchedCall('media-1', token, 'lease-1')

    const directOnlyBoot = makeTransferRegistry(s.deps)
    await directOnlyBoot.ready()
    expect(s.value().entries['media-1']?.phase).toMatchObject({
      tag: 'unresolved-launch',
      reason: 'worker-restart',
    })

    await directOnlyBoot.reconcileFetchedBoot([
      {
        tag: 'matched',
        leaseId: 'lease-1',
        owner: {
          tag: 'transfer',
          requestId: 'media-1',
          projectionId: 'projection-1',
          attempt: 0,
          since: 10,
        },
        downloadId: 7,
        terminal: false,
      },
    ])

    expect(s.value().entries['media-1']?.phase).toMatchObject({
      tag: 'active',
      downloadId: 7,
    })
  })

  it('does not arm a stale writer when a later Fetched boot observation fails to persist', async () => {
    const second = request({
      id: 'media-2',
      projectionId: 'projection-2',
      mode: 'fetched',
    })
    const s = setup()
    const first = makeTransferRegistry(s.deps)
    await first.ready()
    const prepared = await preparePermitted(first, [request({ mode: 'fetched' }), second])
    const firstToken = prepared.launches.find(({ id }) => id === 'media-1')!
    const secondToken = prepared.launches.find(({ id }) => id === 'media-2')!
    await first.armFetchedCall('media-1', firstToken, 'lease-1')
    await first.armFetchedCall('media-2', secondToken, 'lease-2')

    const storageSet = vi.mocked(s.deps.storage.set)
    const persist = storageSet.getMockImplementation()!
    let bootWrites = 0
    storageSet.mockImplementation(async (next) => {
      bootWrites += 1
      if (bootWrites === 2) throw new Error('storage stopped')
      await persist(next)
    })
    vi.mocked(s.deps.clock.schedule).mockClear()
    vi.mocked(s.deps.wake.schedule).mockClear()
    const failed = makeTransferRegistry({
      ...s.deps,
      fetchedBoot: [
        {
          tag: 'matched',
          leaseId: 'lease-1',
          owner: fetchedOwner('media-1', 'projection-1'),
          downloadId: 7,
          terminal: false,
        },
        {
          tag: 'matched',
          leaseId: 'lease-2',
          owner: fetchedOwner('media-2', 'projection-2'),
          downloadId: 8,
          terminal: false,
        },
      ],
    })

    await expect(failed.ready()).rejects.toThrow('storage stopped')
    expect(s.deps.clock.schedule).not.toHaveBeenCalled()
    // The second write fails closed, but its first observation had already
    // installed a conservative durable wake before storage mutation.
    expect(s.deps.wake.schedule).toHaveBeenCalledWith(6_010)
  })

  it('discards exact Fetched staging before retrying it', async () => {
    const s = setup()
    const first = makeTransferRegistry(s.deps)
    await first.ready()
    const token = (await preparePermitted(first, [request({ mode: 'fetched' })])).launches[0]!
    await first.armFetchedCall('media-1', token, 'lease-1')
    vi.mocked(s.deps.clock.schedule).mockImplementation((run, delayMs) => {
      if (delayMs === 0) queueMicrotask(run)
      return () => {}
    })
    const recovered = makeTransferRegistry({
      ...s.deps,
      fetchedBoot: [
        {
          tag: 'staging',
          leaseId: 'lease-1',
          owner: {
            tag: 'transfer',
            requestId: 'media-1',
            projectionId: 'projection-1',
            attempt: 0,
            since: 10,
          },
        },
      ],
    })
    await recovered.ready()
    await vi.waitFor(() => expect(s.deps.discardRecoveredStaging).toHaveBeenCalledWith(['lease-1']))
    await vi.waitFor(() =>
      expect(s.value().entries['media-1']?.phase).toMatchObject({
        tag: 'active',
        downloadId: 33,
      }),
    )
    expect(s.deps.discardRecoveredStaging).toHaveBeenCalledBefore(vi.mocked(s.deps.reserveFetched))
  })

  it('discards mismatched Fetched staging but retains a mismatched live handoff', async () => {
    const s = setup()
    const registry = makeTransferRegistry({
      ...s.deps,
      fetchedBoot: [
        {
          tag: 'staging',
          leaseId: 'staging-lease',
          owner: {
            tag: 'transfer',
            requestId: 'missing-request',
            projectionId: 'missing-projection',
            attempt: 0,
            since: 10,
          },
        },
        {
          tag: 'matched',
          leaseId: 'live-lease',
          owner: {
            tag: 'transfer',
            requestId: 'missing-request',
            projectionId: 'missing-projection',
            attempt: 0,
            since: 10,
          },
          downloadId: 7,
          terminal: false,
        },
      ],
    })

    await registry.ready()

    await vi.waitFor(() =>
      expect(s.deps.discardRecoveredStaging).toHaveBeenCalledWith(['staging-lease']),
    )
    expect(s.deps.releaseFetched).not.toHaveBeenCalled()
    expect(s.deps.projectTerminal).not.toHaveBeenCalled()
  })

  it('backs off and retries exact staging cleanup in the same worker', async () => {
    const s = setup()
    const first = makeTransferRegistry(s.deps)
    await first.ready()
    const token = (await preparePermitted(first, [request({ mode: 'fetched' })])).launches[0]!
    await first.armFetchedCall('media-1', token, 'lease-1')
    vi.mocked(s.deps.clock.schedule).mockImplementation((run, delayMs) => {
      if (delayMs === 0) queueMicrotask(run)
      return () => {}
    })
    const observation = {
      tag: 'staging' as const,
      leaseId: 'lease-1',
      owner: {
        tag: 'transfer' as const,
        requestId: 'media-1',
        projectionId: 'projection-1',
        attempt: 0,
        since: 10,
      },
    }
    vi.mocked(s.deps.discardRecoveredStaging)
      .mockRejectedValueOnce(new Error('worker stopped'))
      .mockRejectedValueOnce(new Error('still stopping'))

    const recovered = makeTransferRegistry({ ...s.deps, fetchedBoot: [observation] })
    await expect(recovered.ready()).resolves.toBeUndefined()
    await vi.waitFor(() => expect(s.deps.discardRecoveredStaging).toHaveBeenCalledOnce())
    expect(s.value().entries['media-1']?.phase).toMatchObject({
      tag: 'ready',
    })
    expect(s.deps.reserveFetched).not.toHaveBeenCalled()
    expect(s.deps.wake.schedule).toHaveBeenLastCalledWith(6010)

    s.setNow(6010)
    await recovered.onWake()
    expect(s.deps.discardRecoveredStaging).toHaveBeenCalledTimes(2)
    expect(s.deps.wake.schedule).toHaveBeenLastCalledWith(18010)
    expect(s.deps.reserveFetched).not.toHaveBeenCalled()

    s.setNow(18010)
    await recovered.onWake()
    expect(s.deps.discardRecoveredStaging).toHaveBeenCalledTimes(3)
    expect(s.deps.discardRecoveredStaging).toHaveBeenNthCalledWith(1, ['lease-1'])
    expect(s.deps.discardRecoveredStaging).toHaveBeenNthCalledWith(2, ['lease-1'])
    expect(s.deps.discardRecoveredStaging).toHaveBeenNthCalledWith(3, ['lease-1'])
    await vi.waitFor(() => expect(s.deps.startReservedFetched).toHaveBeenCalledOnce())
    expect(s.deps.projectTerminal).not.toHaveBeenCalled()
  })

  it('blocks only the failed staging cleanup row and resumes unrelated due work', async () => {
    const s = setup()
    const first = makeTransferRegistry(s.deps)
    await first.ready()
    const fetched = request({ mode: 'fetched' })
    const direct = request({ id: 'media-2', projectionId: 'projection-2' })
    const prepared = await preparePermitted(first, [fetched, direct])
    const fetchedToken = prepared.launches.find(({ id }) => id === fetched.id)!
    await first.armFetchedCall(fetched.id, fetchedToken, 'lease-1')
    vi.mocked(s.deps.clock.schedule).mockImplementation((run, delayMs) => {
      if (delayMs === 0) queueMicrotask(run)
      return () => {}
    })
    vi.mocked(s.deps.discardRecoveredStaging).mockRejectedValue(new Error('still owned'))

    const restarted = makeTransferRegistry({
      ...s.deps,
      fetchedBoot: [
        {
          tag: 'staging',
          leaseId: 'lease-1',
          owner: {
            tag: 'transfer',
            requestId: fetched.id,
            projectionId: fetched.projectionId,
            attempt: 0,
            since: 10,
          },
        },
      ],
    })
    await restarted.ready()
    await vi.waitFor(() => expect(s.deps.startRetry).toHaveBeenCalledOnce())

    expect(s.deps.reserveFetched).not.toHaveBeenCalled()
    expect(s.deps.startReservedFetched).not.toHaveBeenCalled()
    expect(s.value().entries[fetched.id]?.phase.tag).toBe('ready')
    await vi.waitFor(() => {
      expect(s.value().entries[direct.id]?.phase.tag).toBe('active')
      expect(s.deps.wake.schedule).toHaveBeenLastCalledWith(6010)
    })
  })

  it('persists browser intent then its exact handle without owning Clear binding', async () => {
    const s = setup()
    const registry = makeTransferRegistry(s.deps)
    await registry.ready()
    const token = (await preparePermitted(registry, [request()])).launches[0]!
    await registry.armDirectCall('media-1', token)
    await registry.bindStarted('media-1', token, { kind: 'browser', id: 7 })
    expect(s.writes.map((state) => state.entries['media-1']?.phase.tag)).toEqual([
      'direct-prepared',
      'direct-ready',
      'launching',
      'active',
    ])
  })

  it.each(['direct', 'fetched', 'aria2'] as const)(
    'rejects a second stale %s arm instead of returning false proof',
    async (mode) => {
      const s = setup()
      const registry = makeTransferRegistry(s.deps)
      await registry.ready()
      const prepared = await registry.prepare(
        [request({ mode })],
        mode === 'aria2' ? reservation : undefined,
      )
      const token = prepared.launches[0]!
      await registry.releasePreparedStarts([token])

      let staleArm: Promise<void>
      if (mode === 'direct') {
        await registry.armDirectCall(token.id, token)
        staleArm = registry.armDirectCall(token.id, token)
      } else if (mode === 'fetched') {
        await registry.armFetchedCall(token.id, token, 'lease-1')
        staleArm = registry.armFetchedCall(token.id, token, 'lease-2')
      } else {
        await registry.armAria2Call(token.id, token)
        staleArm = registry.armAria2Call(token.id, token)
      }
      await expect(staleArm).rejects.toBeInstanceOf(TransferRegistryTransitionError)
    },
  )

  it('cancels and quarantines a browser handle rejected by a stale bind', async () => {
    const s = setup()
    const registry = makeTransferRegistry(s.deps)
    await registry.ready()
    const token = (await registry.prepare([request()])).launches[0]!
    await registry.releasePreparedStarts([token])

    await expect(
      registry.bindStarted(token.id, token, { kind: 'browser', id: 7 }),
    ).rejects.toBeInstanceOf(TransferRegistryTransitionError)
    await registry.resolveUntrackedStart(token.id, token, { kind: 'browser', id: 7 })

    expect(s.deps.downloads.cancel).toHaveBeenCalledWith(7)
    expect(s.value().entries[token.id]?.phase).toMatchObject({
      tag: 'browser-unresolved',
      downloadId: 7,
      reason: 'handle-bind-failed',
    })
  })

  it.each(['direct', 'aria2'] as const)(
    'does not let a wake race the live %s queue before its exact arm',
    async (mode) => {
      const s = setup()
      const registry = makeTransferRegistry(s.deps)
      await registry.ready()
      const prepared = await registry.prepare(
        [request({ mode })],
        mode === 'aria2' ? reservation : undefined,
      )
      const token = prepared.launches[0]!

      await registry.releasePreparedStarts([token])
      await registry.onWake()
      expect(s.deps.startRetry).not.toHaveBeenCalled()
      expect(s.deps.startAria2).not.toHaveBeenCalled()

      if (mode === 'aria2') await registry.armAria2Call(token.id, token)
      else await registry.armDirectCall(token.id, token)
      expect(s.value().entries[token.id]?.phase.tag).toBe(
        mode === 'aria2' ? 'aria2-call-armed' : 'launching',
      )
    },
  )

  it('cancels a Direct handle whose exact launch went stale while start was pending', async () => {
    const s = setup()
    let finishStart!: (result: { readonly tag: 'started'; readonly downloadId: number }) => void
    vi.mocked(s.deps.startRetry).mockReturnValue(
      new Promise((resolve) => {
        finishStart = resolve
      }),
    )
    const first = makeTransferRegistry(s.deps)
    await first.ready()
    const prepared = await preparePermitted(first, [request()])
    const token = prepared.launches[0]!
    const restarted = makeTransferRegistry(s.deps)
    await restarted.ready()

    const waking = restarted.onWake()
    await vi.waitFor(() => expect(s.deps.startRetry).toHaveBeenCalledOnce())
    await restarted.rejectStart(token.id, token)
    finishStart({ tag: 'started', downloadId: 77 })
    await waking

    expect(s.deps.downloads.cancel).toHaveBeenCalledWith(77)
    expect(s.value().entries[token.id]).toBeUndefined()
  })

  it('does not own current or legacy Clear rebinding during boot', async () => {
    const current: TransferRegistryStore = {
      version: 4,
      entries: {
        'media-1': {
          request: request({
            item: {
              id: 'media-1',
              platform: 'x',
              postId: 'post-1',
              author: 'alice',
              type: 'video',
              url: 'https://video.example/a.mp4',
              ext: 'mp4',
              index: 0,
            },
          }),
          createdAt: 1,
          phase: {
            tag: 'active',
            downloadId: 7,
            attempt: 0,
            startedAt: 1,
            nextProbeAt: 1,
          },
        },
      },
      profiles: {},
      legacy: {
        legacy: {
          downloadId: 8,
          startedAt: 1,
          tweetId: 'post-2',
          phase: { tag: 'active', nextProbeAt: 1 },
        },
      },
    }
    const s = setup(current)
    const registry = makeTransferRegistry(s.deps)
    await expect(registry.ready()).resolves.toBeUndefined()
    await vi.waitFor(() => {
      expect(s.deps.downloads.search).toHaveBeenCalledWith(7)
      expect(s.deps.downloads.search).toHaveBeenCalledWith(8)
    })
  })

  it('commits a legacy terminal delta without another Chrome search', async () => {
    const initial: TransferRegistryStore = {
      version: 4,
      entries: {},
      profiles: {},
      legacy: {
        'legacy-media': {
          downloadId: 8,
          startedAt: 1,
          tweetId: 'post-1',
          phase: { tag: 'active', nextProbeAt: 6010 },
        },
      },
    }
    const s = setup(initial)
    const calls: string[] = []
    const releaseFetched = vi.fn<TransferRegistryDeps['releaseFetched']>(async () => {
      calls.push('release')
    })
    const projectLegacyTerminal = vi.fn<NonNullable<TransferRegistryDeps['projectLegacyTerminal']>>(
      async () => {
        calls.push('project')
      },
    )
    const registry = makeTransferRegistry({
      ...s.deps,
      releaseFetched,
      projectLegacyTerminal,
    })
    await registry.ready()
    vi.mocked(s.deps.downloads.search).mockClear()

    await registry.onDownloadChanged({
      id: 8,
      state: { current: 'complete' },
    })

    expect(s.deps.downloads.search).not.toHaveBeenCalled()
    expect(releaseFetched).toHaveBeenCalledWith(8)
    expect(projectLegacyTerminal).toHaveBeenCalledWith('legacy-media', 'complete', 8, 10, 'post-1')
    expect(calls).toEqual(['project', 'release'])
    expect(s.value().legacy['legacy-media']).toBeUndefined()
  })

  it('retains a legacy Fetched lease and terminal row when its durable projector fails', async () => {
    const initial: TransferRegistryStore = {
      version: 4,
      entries: {},
      profiles: {},
      legacy: {
        'legacy-media': {
          downloadId: 8,
          startedAt: 1,
          phase: { tag: 'active', nextProbeAt: 6010 },
        },
      },
    }
    const s = setup(initial)
    const projectLegacyTerminal =
      vi.fn<NonNullable<TransferRegistryDeps['projectLegacyTerminal']>>()
    projectLegacyTerminal.mockRejectedValueOnce(new Error('history unavailable'))
    const registry = makeTransferRegistry({ ...s.deps, projectLegacyTerminal })
    await registry.ready()

    await registry.onDownloadChanged({ id: 8, state: { current: 'complete' } })

    expect(s.deps.releaseFetched).not.toHaveBeenCalled()
    expect(s.value().legacy['legacy-media']?.phase).toMatchObject({ tag: 'terminal-pending' })

    s.setNow(6010)
    await registry.onWake()

    expect(projectLegacyTerminal).toHaveBeenCalledTimes(2)
    expect(s.deps.releaseFetched).toHaveBeenCalledWith(8)
    expect(s.value().legacy['legacy-media']).toBeUndefined()
  })

  it('enriches durable terminal evidence with exact safe Chrome bytes', async () => {
    const s = setup()
    vi.mocked(s.deps.downloads.search).mockImplementation(async () => {
      expect(s.value().entries['media-1']?.phase).toMatchObject({
        tag: 'terminal-pending',
        evidence: { tag: 'browser', downloadId: 7, state: 'complete' },
      })
      return [
        {
          id: 7,
          state: 'interrupted',
          exists: false,
          bytesReceived: 42,
          totalBytes: -1,
        },
      ]
    })
    const registry = makeTransferRegistry(s.deps)
    await registry.ready()
    const token = (await preparePermitted(registry, [request()])).launches[0]!
    await registry.armDirectCall('media-1', token)
    await registry.bindStarted('media-1', token, { kind: 'browser', id: 7 })
    await registry.onDownloadChanged({ id: 7, state: { current: 'complete' } })
    expect(s.deps.projectTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        projectionId: 'projection-1',
        requestId: 'media-1',
        evidence: {
          tag: 'browser',
          downloadId: 7,
          state: 'complete',
          bytesReceived: 42,
        },
      }),
    )
    expect(s.deps.projectTerminal).not.toHaveBeenCalledWith(
      expect.objectContaining({
        evidence: expect.objectContaining({ totalBytes: expect.anything() }),
      }),
    )
    expect(s.deps.releaseFetched).not.toHaveBeenCalled()
    expect(s.value().entries['media-1']).toBeUndefined()
  })

  it('commits and projects the exact terminal delta when Chrome search is empty', async () => {
    const s = setup()
    vi.mocked(s.deps.downloads.search).mockImplementation(async () => {
      expect(s.value().entries['media-1']?.phase).toMatchObject({
        tag: 'terminal-pending',
        evidence: { tag: 'browser', downloadId: 7, state: 'complete' },
      })
      return []
    })
    const registry = makeTransferRegistry(s.deps)
    await registry.ready()
    const token = (await preparePermitted(registry, [request()])).launches[0]!
    await registry.armDirectCall('media-1', token)
    await registry.bindStarted('media-1', token, { kind: 'browser', id: 7 })
    await registry.onDownloadChanged({ id: 7, state: { current: 'complete' } })
    expect(s.deps.projectTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        projectionId: 'projection-1',
        requestId: 'media-1',
        evidence: { tag: 'browser', downloadId: 7, state: 'complete' },
      }),
    )
    expect(s.value().entries['media-1']).toBeUndefined()
  })

  it('projects the exact delta without bytes when Chrome returns an unkeyed row', async () => {
    const s = setup()
    vi.mocked(s.deps.downloads.search).mockResolvedValue([
      {
        state: 'interrupted',
        exists: true,
        bytesReceived: 99,
      } as unknown as { readonly id: number },
    ])
    const registry = makeTransferRegistry(s.deps)
    await registry.ready()
    const token = (await preparePermitted(registry, [request()])).launches[0]!
    await registry.armDirectCall('media-1', token)
    await registry.bindStarted('media-1', token, { kind: 'browser', id: 7 })
    await registry.onDownloadChanged({ id: 7, state: { current: 'complete' } })
    expect(s.deps.projectTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'complete',
        evidence: { tag: 'browser', downloadId: 7, state: 'complete' },
      }),
    )
    expect(s.value().entries['media-1']).toBeUndefined()
  })

  it('leaves the lane free after a durable terminal commit while Chrome search hangs', async () => {
    const s = setup()
    let finishSearch!: () => void
    vi.mocked(s.deps.downloads.search).mockReturnValue(
      new Promise<readonly []>((resolve) => {
        finishSearch = () => resolve([])
      }),
    )
    const registry = makeTransferRegistry(s.deps)
    await registry.ready()
    const token = (await preparePermitted(registry, [request()])).launches[0]!
    await registry.armDirectCall('media-1', token)
    await registry.bindStarted('media-1', token, { kind: 'browser', id: 7 })

    const changed = registry.onDownloadChanged({
      id: 7,
      state: { current: 'complete' },
    })
    await vi.waitFor(() =>
      expect(s.value().entries['media-1']?.phase).toMatchObject({
        tag: 'terminal-pending',
        evidence: { tag: 'browser', downloadId: 7, state: 'complete' },
      }),
    )
    expect(s.deps.projectTerminal).not.toHaveBeenCalled()

    await registry.onWake()
    expect(s.deps.projectTerminal).toHaveBeenCalledOnce()
    expect(s.value().entries['media-1']).toBeUndefined()

    finishSearch()
    await changed
    expect(s.deps.projectTerminal).toHaveBeenCalledOnce()
  })

  it('leaves the mutation lane free while terminal projection hangs', async () => {
    const s = setup()
    vi.mocked(s.deps.downloads.search).mockResolvedValue([])
    let finishProjection!: () => void
    vi.mocked(s.deps.projectTerminal).mockReturnValue(
      new Promise<void>((resolve) => {
        finishProjection = resolve
      }),
    )
    const registry = makeTransferRegistry(s.deps)
    await registry.ready()
    const token = (await preparePermitted(registry, [request()])).launches[0]!
    await registry.armDirectCall('media-1', token)
    await registry.bindStarted('media-1', token, { kind: 'browser', id: 7 })

    const changed = registry.onDownloadChanged({
      id: 7,
      state: { current: 'complete' },
    })
    await vi.waitFor(() => expect(s.deps.projectTerminal).toHaveBeenCalledOnce())
    let prepared = false
    const independent = registry
      .prepare([
        request({
          id: 'media-2',
          projectionId: 'projection-2',
          filename: 'b.mp4',
        }),
      ])
      .then(() => (prepared = true))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const laneWasFree = prepared

    finishProjection()
    await Promise.all([changed, independent])
    expect(laneWasFree).toBe(true)
  })

  it('reclaims a known unresolved browser handle only after an exact live search', async () => {
    const unresolved: TransferRegistryStore = {
      version: 4,
      entries: {
        'media-1': {
          request: request(),
          createdAt: 1,
          phase: {
            tag: 'browser-unresolved',
            attempt: 0,
            since: 1,
            reason: 'handle-bind-failed',
            downloadId: 7,
            nextProbeAt: 1,
          },
        },
      },
      profiles: {},
      legacy: {},
    }
    const s = setup(unresolved)
    vi.mocked(s.deps.downloads.search).mockResolvedValue([{ id: 7, state: 'in_progress' }])
    const registry = makeTransferRegistry(s.deps)
    await registry.ready()
    await vi.waitFor(() =>
      expect(s.value().entries['media-1']?.phase).toMatchObject({
        tag: 'active',
        downloadId: 7,
      }),
    )
  })

  it('defers a missing browser-unresolved row and does not hot-loop before its deadline', async () => {
    const unresolved: TransferRegistryStore = {
      version: 4,
      entries: {
        'media-1': {
          request: request(),
          createdAt: 1,
          phase: {
            tag: 'browser-unresolved',
            attempt: 0,
            since: 1,
            reason: 'handle-bind-failed',
            downloadId: 7,
            nextProbeAt: 1,
          },
        },
      },
      profiles: {},
      legacy: {},
    }
    const s = setup(unresolved)
    vi.mocked(s.deps.downloads.search).mockResolvedValue([])
    const registry = makeTransferRegistry(s.deps)
    await registry.ready()
    await vi.waitFor(() =>
      expect(s.value().entries['media-1']?.phase).toMatchObject({
        tag: 'browser-unresolved',
        nextProbeAt: 6010,
      }),
    )
    vi.mocked(s.deps.downloads.search).mockClear()
    s.setNow(11)
    await registry.onWake()
    await registry.probeStuck()
    expect(s.deps.downloads.search).not.toHaveBeenCalled()
  })

  it('ignores a late browser probe after an exact terminal delta wins', async () => {
    const active: TransferRegistryStore = {
      version: 4,
      entries: {
        'media-1': {
          request: request(),
          createdAt: 1,
          phase: {
            tag: 'active',
            downloadId: 7,
            attempt: 0,
            startedAt: 1,
            nextProbeAt: 1,
          },
        },
      },
      profiles: {},
      legacy: {},
    }
    const s = setup(active)
    let finishProbe!: (rows: readonly { id: number; state: string }[]) => void
    vi.mocked(s.deps.downloads.search)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishProbe = resolve
        }),
      )
      .mockResolvedValue([])
    const registry = makeTransferRegistry(s.deps)
    await registry.ready()
    await vi.waitFor(() => expect(s.deps.downloads.search).toHaveBeenCalledOnce())

    await registry.onDownloadChanged({
      id: 7,
      state: { current: 'complete' },
    })
    expect(s.value().entries['media-1']).toBeUndefined()

    finishProbe([{ id: 7, state: 'in_progress' }])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(s.value().entries['media-1']).toBeUndefined()
  })

  it('quarantines a missing active handle during a scheduled browser probe', async () => {
    const s = setup()
    vi.mocked(s.deps.downloads.search).mockResolvedValue([])
    const first = makeTransferRegistry(s.deps)
    await first.ready()
    const token = (await preparePermitted(first, [request()])).launches[0]!
    await first.armDirectCall('media-1', token)
    await first.bindStarted('media-1', token, { kind: 'browser', id: 7 })
    s.setNow(6010)
    await first.probeStuck()
    expect(s.value().entries['media-1']?.phase).toMatchObject({
      tag: 'browser-unresolved',
      downloadId: 7,
      nextProbeAt: 12010,
    })
    expect(s.deps.wake.schedule).toHaveBeenLastCalledWith(12010)

    const restarted = makeTransferRegistry(s.deps)
    await restarted.ready()
    vi.mocked(s.deps.downloads.search).mockClear()
    s.setNow(6011)
    await restarted.onWake()
    expect(s.deps.downloads.search).not.toHaveBeenCalled()
    expect(s.deps.wake.schedule).toHaveBeenLastCalledWith(12010)
  })

  it.each(['direct', 'fetched'] as const)(
    'retries a definite %s retry-start failure while attempts remain',
    async (mode) => {
      const s = setup()
      if (mode === 'fetched')
        vi.mocked(s.deps.startReservedFetched).mockResolvedValueOnce({ tag: 'failed' })
      else vi.mocked(s.deps.startRetry).mockRejectedValueOnce(new Error('offline'))
      const registry = makeTransferRegistry(s.deps)
      await registry.ready()
      const token = (await preparePermitted(registry, [request({ mode })])).launches[0]!
      if (mode === 'fetched') await registry.armFetchedCall('media-1', token, 'lease-1')
      else await registry.armDirectCall('media-1', token)
      await registry.bindStarted('media-1', token, { kind: 'browser', id: 7 })
      await registry.onDownloadChanged({
        id: 7,
        state: { current: 'interrupted' },
        error: { current: 'NETWORK_FAILED' },
      })
      s.setNow(2010)
      await registry.onWake()
      expect(s.value().entries['media-1']?.phase).toEqual({
        tag: 'retry-wait',
        attempt: 2,
        retryAt: 6010,
        priorDownloadId: 7,
      })
      expect(s.deps.wake.schedule).toHaveBeenLastCalledWith(6010)
      expect(s.deps.projectTerminal).not.toHaveBeenCalled()
    },
  )

  it('projects an exact retry handle to Clear after the Registry commit', async () => {
    const retryRequest = request()
    const waiting: TransferRegistryStore = {
      version: 4,
      entries: {
        'media-1': {
          request: retryRequest,
          createdAt: 1,
          phase: {
            tag: 'retry-wait',
            attempt: 1,
            retryAt: 1,
            priorDownloadId: 7,
          },
        },
      },
      profiles: {},
      legacy: {},
    }
    const s = setup(waiting)
    const registry = makeTransferRegistry(s.deps)
    await registry.ready()

    await registry.onWake()

    expect(s.value().entries['media-1']?.phase).toMatchObject({
      tag: 'active',
      downloadId: 33,
    })
    expect(s.deps.clear.bindTransfer).toHaveBeenCalledWith(retryRequest, 33, 7)
  })

  it('lets only the work planner reserve a refreshed Fetched retry', async () => {
    const waiting: TransferRegistryStore = {
      version: 4,
      entries: {
        'media-1': {
          request: request({ mode: 'fetched' }),
          createdAt: 1,
          phase: {
            tag: 'retry-wait',
            attempt: 1,
            retryAt: 1,
            priorDownloadId: 7,
          },
        },
      },
      profiles: {},
      legacy: {},
    }
    const s = setup(waiting)
    const registry = makeTransferRegistry(s.deps)
    await registry.ready()
    vi.mocked(s.deps.clock.schedule).mockImplementation((run, delayMs) => {
      if (delayMs === 0) queueMicrotask(run)
      return () => {}
    })
    let releaseReserve!: () => void
    const reserveGate = new Promise<void>((resolve) => {
      releaseReserve = resolve
    })
    vi.mocked(s.deps.reserveFetched).mockImplementation(async () => {
      await reserveGate
      return { tag: 'reserved', leaseId: 'lease-1' }
    })

    await registry.onWake()
    await vi.waitFor(() => expect(s.deps.reserveFetched).toHaveBeenCalledOnce())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(s.deps.reserveFetched).toHaveBeenCalledOnce()

    releaseReserve()
    await vi.waitFor(() =>
      expect(s.value().entries['media-1']?.phase).toMatchObject({
        tag: 'active',
        downloadId: 33,
      }),
    )
    expect(s.deps.startReservedFetched).toHaveBeenCalledOnce()
  })

  it('leaves the mutation lane free while retry URL refresh hangs', async () => {
    const waiting: TransferRegistryStore = {
      version: 4,
      entries: {
        'media-1': {
          request: request(),
          createdAt: 1,
          phase: {
            tag: 'retry-wait',
            attempt: 1,
            retryAt: 1,
            priorDownloadId: 7,
          },
        },
      },
      profiles: {},
      legacy: {},
    }
    const s = setup(waiting)
    let finishRefresh!: (url: string) => void
    vi.mocked(s.deps.refreshUrl).mockReturnValue(
      new Promise<string>((resolve) => {
        finishRefresh = resolve
      }),
    )
    const registry = makeTransferRegistry(s.deps)
    await registry.ready()

    const waking = registry.onWake()
    await vi.waitFor(() => expect(s.deps.refreshUrl).toHaveBeenCalledOnce())
    expect((await registry.clearRecovery()).retryOwnedRequestIds.has('media-1')).toBe(true)
    let prepared = false
    const independent = registry
      .prepare([
        request({
          id: 'media-2',
          projectionId: 'projection-2',
          filename: 'b.mp4',
        }),
      ])
      .then(() => (prepared = true))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const laneWasFree = prepared

    finishRefresh('https://video.example/refreshed.mp4')
    await Promise.all([waking, independent])
    expect(laneWasFree).toBe(true)
  })

  it('leaves the mutation lane free while a retry start hangs', async () => {
    const waiting: TransferRegistryStore = {
      version: 4,
      entries: {
        'media-1': {
          request: request(),
          createdAt: 1,
          phase: {
            tag: 'retry-wait',
            attempt: 1,
            retryAt: 1,
            priorDownloadId: 7,
          },
        },
      },
      profiles: {},
      legacy: {},
    }
    const s = setup(waiting)
    let finishStart!: () => void
    vi.mocked(s.deps.startRetry).mockReturnValue(
      new Promise((resolve) => {
        finishStart = () => resolve({ tag: 'failed' })
      }),
    )
    const registry = makeTransferRegistry(s.deps)
    await registry.ready()

    const waking = registry.onWake()
    await vi.waitFor(() => expect(s.deps.startRetry).toHaveBeenCalledOnce())
    expect((await registry.clearRecovery()).retryOwnedRequestIds.has('media-1')).toBe(true)
    let prepared = false
    const independent = registry
      .prepare([
        request({
          id: 'media-2',
          projectionId: 'projection-2',
          filename: 'b.mp4',
        }),
      ])
      .then(() => (prepared = true))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const laneWasFree = prepared

    finishStart()
    await Promise.all([waking, independent])
    expect(laneWasFree).toBe(true)
  })

  it('projects the prior browser handle after a definite retry failure without replaying', async () => {
    const s = setup()
    vi.mocked(s.deps.startRetry).mockResolvedValueOnce({ tag: 'failed' })
    const registry = makeTransferRegistry(s.deps)
    await registry.ready()
    const token = (await preparePermitted(registry, [request()])).launches[0]!
    await registry.armDirectCall('media-1', token)
    await registry.bindStarted('media-1', token, { kind: 'browser', id: 7 })
    await registry.onDownloadChanged({
      id: 7,
      state: { current: 'interrupted' },
      error: { current: 'NETWORK_FAILED' },
    })
    s.setNow(2010)
    await registry.onWake()

    expect(s.deps.projectTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'failed',
        evidence: { tag: 'browser', downloadId: 7, state: 'interrupted' },
      }),
    )
    expect(s.value().entries['media-1']).toBeUndefined()
    expect(s.deps.startRetry).toHaveBeenCalledOnce()
    const wakeCalls = vi.mocked(s.deps.wake.schedule).mock.calls
    expect(wakeCalls.at(-1)).toEqual([undefined])

    await registry.onWake()
    expect(s.deps.startRetry).toHaveBeenCalledOnce()
    expect(s.deps.projectTerminal).toHaveBeenCalledOnce()
  })

  it('projects the prior exact browser handle when retry starts are exhausted', async () => {
    const exhausted: TransferRegistryStore = {
      version: 4,
      entries: {
        'media-1': {
          request: request(),
          createdAt: 1,
          phase: {
            tag: 'retry-wait',
            attempt: 3,
            retryAt: 1,
            priorDownloadId: 7,
          },
        },
      },
      profiles: {},
      legacy: {},
    }
    const s = setup(exhausted)
    vi.mocked(s.deps.startRetry).mockRejectedValueOnce(new Error('offline'))
    const registry = makeTransferRegistry(s.deps)
    await registry.ready()
    await registry.onWake()
    expect(s.deps.projectTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'failed',
        evidence: { tag: 'browser', downloadId: 7, state: 'interrupted' },
      }),
    )
    expect(s.value().entries['media-1']).toBeUndefined()
  })

  it('caps probe deadlines at MAX_SAFE_INTEGER', async () => {
    const max = Number.MAX_SAFE_INTEGER
    const active: TransferRegistryStore = {
      version: 4,
      entries: {
        'media-1': {
          request: request(),
          createdAt: max,
          phase: {
            tag: 'active',
            downloadId: 7,
            attempt: 0,
            startedAt: max,
            nextProbeAt: max,
          },
        },
      },
      profiles: {},
      legacy: {},
    }
    const s = setup(active)
    s.setNow(max)
    const registry = makeTransferRegistry(s.deps)
    await expect(registry.ready()).resolves.toBeUndefined()
    expect(s.value().entries['media-1']?.phase).toMatchObject({
      nextProbeAt: max,
    })
  })

  it('re-arms a bounded wake after a durable probe mutation fails', async () => {
    const s = setup()
    vi.mocked(s.deps.downloads.search).mockResolvedValue([])
    const registry = makeTransferRegistry(s.deps)
    await registry.ready()
    const token = (await preparePermitted(registry, [request()])).launches[0]!
    await registry.armDirectCall('media-1', token)
    await registry.bindStarted('media-1', token, { kind: 'browser', id: 7 })
    s.failNextWrite(new Error('disk full'))
    await expect(
      registry.onDownloadChanged({ id: 7, state: { current: 'complete' } }),
    ).rejects.toThrow('disk full')
    expect(s.value().entries['media-1']?.phase.tag).toBe('active')
    expect(s.deps.wake.schedule).toHaveBeenLastCalledWith(6010)

    await registry.onWake()
    expect(s.value().entries['media-1']?.phase).toMatchObject({
      tag: 'browser-unresolved',
      nextProbeAt: 6010,
    })
  })

  it('terminalizes an exact interrupted browser-unresolved handle', async () => {
    const unresolved: TransferRegistryStore = {
      version: 4,
      entries: {
        'media-1': {
          request: request(),
          createdAt: 1,
          phase: {
            tag: 'browser-unresolved',
            attempt: 0,
            since: 1,
            reason: 'handle-bind-failed',
            downloadId: 7,
            nextProbeAt: 1,
          },
        },
      },
      profiles: {},
      legacy: {},
    }
    const s = setup(unresolved)
    vi.mocked(s.deps.downloads.search).mockResolvedValue([])
    const registry = makeTransferRegistry(s.deps)
    await registry.ready()
    await vi.waitFor(() => expect(s.deps.downloads.search).toHaveBeenCalledOnce())
    vi.mocked(s.deps.downloads.search).mockClear()
    await registry.onDownloadChanged({
      id: 7,
      state: { current: 'interrupted' },
    })
    expect(s.deps.projectTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'failed',
        evidence: {
          tag: 'browser',
          downloadId: 7,
          state: 'interrupted',
        },
      }),
    )
    expect(s.deps.downloads.search).toHaveBeenCalledOnce()
    expect(s.value().entries['media-1']).toBeUndefined()
  })

  it('migrates exact v2 before effects and writes v4 once', async () => {
    const old = {
      version: 2,
      entries: {
        'media-1': {
          request: {
            id: 'media-1',
            url: 'https://video.example/a.mp4',
            filename: 'a.mp4',
            mode: 'direct',
          },
          createdAt: 1,
          phase: {
            tag: 'active',
            downloadId: 7,
            attempt: 0,
            startedAt: 1,
            nextProbeAt: 1,
          },
        },
      },
      legacy: {},
    }
    const s = setup(old)
    const registry = makeTransferRegistry(s.deps)
    await registry.ready()
    expect(s.writes[0]?.version).toBe(4)
    expect(s.value().entries['media-1']?.request.historyPolicy).toBe('off')
  })

  it('fails closed on corrupt state without overwrite', async () => {
    const s = setup({
      version: 3,
      entries: {},
      profiles: {},
      legacy: { bad: 1 },
    })
    const registry = makeTransferRegistry(s.deps)
    await expect(registry.ready()).rejects.toBeInstanceOf(TransferRegistryCorruptionError)
    expect(s.writes).toEqual([])
  })

  it('arms aria2 durably, then binds only its reserved gid', async () => {
    const s = setup()
    const registry = makeTransferRegistry(s.deps)
    await registry.ready()
    const token = (await preparePermitted(registry, [request({ mode: 'aria2' })], reservation))
      .launches[0]!
    await registry.armAria2Call('media-1', token)
    await registry.bindStarted('media-1', token, {
      kind: 'aria2',
      gid: reservation['media-1'].gid,
    })
    expect(s.value().entries['media-1']?.phase).toMatchObject({
      tag: 'aria2-active',
      gid: reservation['media-1'].gid,
    })
  })

  it('reuses one exact credential profile circuit across reservations', async () => {
    const s = setup()
    const registry = makeTransferRegistry(s.deps)
    await registry.ready()
    await registry.prepare([request({ mode: 'aria2' })], reservation)
    const next = request({
      id: 'media-2',
      projectionId: 'projection-2',
      mode: 'aria2',
    })
    await registry.prepare([next], {
      'media-2': {
        profile: { ...profile, profileId: 'different-opaque-id' },
        gid: '0000000000000002',
        options,
      },
    })
    expect(Object.keys(s.value().profiles)).toEqual([profile.profileId])
    expect(s.value().entries['media-2']?.phase).toMatchObject({
      profileId: profile.profileId,
    })
  })

  it('keeps an armed aria2 call unresolved after RPC ambiguity', async () => {
    const s = setup()
    const registry = makeTransferRegistry(s.deps)
    await registry.ready()
    const token = (await preparePermitted(registry, [request({ mode: 'aria2' })], reservation))
      .launches[0]!
    await registry.armAria2Call('media-1', token)
    await registry.resolveUntrackedStart('media-1', token, {
      kind: 'aria2',
      gid: reservation['media-1'].gid,
    })
    expect(s.value().entries['media-1']?.phase).toMatchObject({
      tag: 'aria2-unresolved',
      reason: 'confirmed-unbound',
    })
  })

  it('terminalizes a definite pre-RPC aria2 failure after its durable permit', async () => {
    const s = setup()
    vi.mocked(s.deps.startAria2).mockResolvedValue({ tag: 'failed' })
    const first = makeTransferRegistry(s.deps)
    await first.ready()
    await preparePermitted(first, [request({ mode: 'aria2' })], reservation)

    const restarted = makeTransferRegistry(s.deps)
    await restarted.ready()
    await restarted.onWake()

    expect(s.deps.startAria2).toHaveBeenCalledOnce()
    expect(s.deps.projectTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'failed',
        evidence: { tag: 'start-failed' },
      }),
    )
    expect(s.value().entries['media-1']).toBeUndefined()
  })

  it('maps an armed start failure to ambiguity, never terminal retry', async () => {
    const s = setup()
    const registry = makeTransferRegistry(s.deps)
    await registry.ready()
    const token = (await preparePermitted(registry, [request({ mode: 'aria2' })], reservation))
      .launches[0]!
    await registry.armAria2Call('media-1', token)
    await registry.rejectStart('media-1', token)
    expect(s.value().entries['media-1']?.phase).toMatchObject({
      tag: 'aria2-unresolved',
      reason: 'call-ambiguous',
    })
    expect(s.deps.projectTerminal).not.toHaveBeenCalled()
  })

  it('returns from boot and leaves the mutation lane free while aria2 RPC hangs', async () => {
    const s = setup()
    const first = makeTransferRegistry(s.deps)
    await first.ready()
    const token = (await preparePermitted(first, [request({ mode: 'aria2' })], reservation))
      .launches[0]!
    await first.armAria2Call('media-1', token)
    await first.bindStarted('media-1', token, {
      kind: 'aria2',
      gid: reservation['media-1'].gid,
    })
    let finishProbe!: () => void
    vi.mocked(s.deps.aria2.tellStatus).mockReturnValue(
      new Promise((resolve) => {
        finishProbe = () =>
          resolve({
            gid: reservation['media-1'].gid,
            status: 'active',
            completedLength: '1',
            totalLength: '2',
          })
      }),
    )

    const restarted = makeTransferRegistry(s.deps)
    await expect(restarted.ready()).resolves.toBeUndefined()
    await vi.waitFor(() => expect(s.deps.aria2.tellStatus).toHaveBeenCalledOnce())
    await expect(
      restarted.prepare([
        request({
          id: 'media-2',
          projectionId: 'projection-2',
          filename: 'b.mp4',
        }),
      ]),
    ).resolves.toMatchObject({
      launches: [expect.objectContaining({ id: 'media-2' })],
    })

    finishProbe()
    await vi.waitFor(() =>
      expect(s.value().entries['media-1']?.phase).toMatchObject({
        tag: 'aria2-active',
        progress: { completedLength: '1', totalLength: '2' },
      }),
    )
  })

  it('probes active aria2 using immutable stored credentials and terminalizes exact status', async () => {
    const s = setup()
    vi.mocked(s.deps.aria2.tellStatus).mockResolvedValue({
      gid: reservation['media-1'].gid,
      status: 'complete',
      completedLength: '12',
      totalLength: '12',
    })
    const registry = makeTransferRegistry(s.deps)
    await registry.ready()
    const token = (await preparePermitted(registry, [request({ mode: 'aria2' })], reservation))
      .launches[0]!
    await registry.armAria2Call('media-1', token)
    await registry.bindStarted('media-1', token, {
      kind: 'aria2',
      gid: reservation['media-1'].gid,
    })
    s.setNow(20)
    await registry.probeStuck()
    expect(s.deps.aria2.tellStatus).toHaveBeenCalledWith(
      {
        rpcUrl: profile.rpcUrl,
        secret: profile.secret,
        profileId: profile.profileId,
        failureCount: 0,
        nextProbeAt: 6020,
      },
      reservation['media-1'].gid,
    )
    expect(s.deps.projectTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        evidence: expect.objectContaining({ tag: 'aria2', status: 'complete' }),
      }),
    )
  })
})
