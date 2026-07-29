import { describe, expect, it, vi } from 'vitest'
import {
  makeDownloadMonitor,
  type BrowserProgressPort,
  type MetricsSnapshotStore,
} from './download-monitor'
import type { TerminalProjection } from '../core/download/terminal-outcome'
import {
  decodeMetricsSnapshot,
  MAX_TRACE_DETAIL_LENGTH,
  MAX_TRACE_STAGE_LENGTH,
  type DownloadTraceEntry,
  type MetricsSnapshot,
} from '../core/schema'

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const terminalProjection = (): TerminalProjection => ({
  requestId: 'request-1',
  logicalRequestId: 'request-1',
  projectionId: 'projection-1',
  createdAt: 0,
  mode: 'direct',
  outcome: 'complete',
  historyPolicy: 'off',
  filename: 'file.jpg',
  observedAt: 10,
  evidence: { tag: 'browser', downloadId: 7, state: 'complete' },
})

const monitorWith = (input: {
  readonly progress: BrowserProgressPort
  readonly snapshots?: MetricsSnapshotStore
  readonly log?: (event: DownloadTraceEntry) => void
}) =>
  makeDownloadMonitor({
    progress: input.progress,
    now: () => 10,
    ...(input.snapshots === undefined ? {} : { snapshots: input.snapshots }),
    ...(input.log === undefined ? {} : { log: input.log }),
  })

describe('DownloadMonitor terminal ordering', () => {
  it('commits terminal truth before a deferred sample or session write', async () => {
    const search =
      deferred<ReadonlyArray<{ id: number; bytesReceived: number; totalBytes: number }>>()
    const write = deferred<void>()
    const set = vi.fn<MetricsSnapshotStore['set']>(async () => write.promise)
    const monitor = monitorWith({
      progress: { search: vi.fn<BrowserProgressPort['search']>(async () => search.promise) },
      snapshots: { get: async () => null, set },
    })
    const commit = vi.fn<() => Promise<void>>(async () =>
      monitor.traceTerminal(terminalProjection()),
    )
    monitor.beginBatch({ requestIds: ['request-1'], concurrencyCap: 1, at: 0 })
    monitor.bindBrowserTransfer(7, 'request-1')

    await expect(
      monitor.onBrowserDelta({ downloadId: 7, terminal: true, at: 10, commitDurable: commit }),
    ).resolves.toBeUndefined()

    expect(commit).toHaveBeenCalledOnce()
    expect(set).not.toHaveBeenCalled()

    search.resolve([{ id: 7, bytesReceived: 99, totalBytes: 99 }])
    await tick()
    expect(set).toHaveBeenCalledOnce()
    // The write is still blocked. Terminal commit was already complete.
    write.resolve()
  })

  it('does not let a rejected sample or broken logger delay terminal truth', async () => {
    const monitor = monitorWith({
      progress: {
        search: vi.fn<BrowserProgressPort['search']>(async () => Promise.reject('gone')),
      },
      snapshots: { get: async () => null, set: async () => {} },
      log: () => {
        throw new Error('console is unavailable')
      },
    })
    const commit = vi.fn<() => Promise<void>>(async () => {})
    monitor.beginBatch({ requestIds: ['request-1'], concurrencyCap: 1, at: 0 })
    monitor.bindBrowserTransfer(7, 'request-1')

    await expect(
      monitor.onBrowserDelta({ downloadId: 7, terminal: true, at: 10, commitDurable: commit }),
    ).resolves.toBeUndefined()
    expect(commit).toHaveBeenCalledOnce()
    await tick()
  })

  it('does not resurrect monitor state when reset wins a deferred terminal sample', async () => {
    const search =
      deferred<ReadonlyArray<{ id: number; bytesReceived: number; totalBytes: number }>>()
    const set = vi.fn<MetricsSnapshotStore['set']>(async () => {})
    const monitor = monitorWith({
      progress: { search: vi.fn<BrowserProgressPort['search']>(async () => search.promise) },
      snapshots: { get: async () => null, set },
    })
    monitor.beginBatch({ requestIds: ['request-1'], concurrencyCap: 1, at: 0 })
    monitor.bindBrowserTransfer(7, 'request-1')

    await monitor.onBrowserDelta({
      downloadId: 7,
      terminal: true,
      at: 10,
      commitDurable: () => monitor.recordTerminal('request-1', 'complete', 10),
    })
    await monitor.reset()
    search.resolve([{ id: 7, bytesReceived: 99, totalBytes: 99 }])
    await tick()

    expect(set).toHaveBeenCalledTimes(2)
    expect(set).toHaveBeenLastCalledWith(null)
  })

  it('keeps nonterminal progress ordered before the Registry update', async () => {
    const search =
      deferred<ReadonlyArray<{ id: number; bytesReceived: number; totalBytes: number }>>()
    const monitor = monitorWith({
      progress: { search: vi.fn<BrowserProgressPort['search']>(async () => search.promise) },
      snapshots: { get: async () => null, set: async () => {} },
    })
    const commit = vi.fn<() => Promise<void>>(async () => {})
    monitor.beginBatch({ requestIds: ['request-1'], concurrencyCap: 1, at: 0 })
    monitor.bindBrowserTransfer(7, 'request-1')

    const event = monitor.onBrowserDelta({
      downloadId: 7,
      terminal: false,
      at: 10,
      commitDurable: commit,
    })
    await tick()
    expect(commit).not.toHaveBeenCalled()

    search.resolve([{ id: 7, bytesReceived: 20, totalBytes: 100 }])
    await event
    expect(commit).toHaveBeenCalledOnce()
  })
})

describe('DownloadMonitor wire normalization', () => {
  it('bounds owned trace text and elapsed time before persistence', async () => {
    const snapshotStore: { value: MetricsSnapshot | null } = { value: null }
    const monitor = monitorWith({
      progress: { search: async () => [] },
      snapshots: {
        get: async () => snapshotStore.value,
        set: async (value) => {
          snapshotStore.value = value
        },
      },
    })
    monitor.traceBackground('s'.repeat(MAX_TRACE_STAGE_LENGTH + 1), {
      detail: 'd'.repeat(MAX_TRACE_DETAIL_LENGTH + 1),
      elapsedMs: -1,
    })

    await monitor.persist(10)

    const stored = snapshotStore.value
    const event = stored?.events?.[0]
    expect(event?.stage).toHaveLength(MAX_TRACE_STAGE_LENGTH)
    expect(event?.detail).toHaveLength(MAX_TRACE_DETAIL_LENGTH)
    expect(event?.elapsedMs).toBe(0)
    expect(decodeMetricsSnapshot(stored)).toEqual(stored)
    await expect(monitor.read(10)).resolves.toEqual(stored)
  })
})

describe('DownloadMonitor reset', () => {
  it('clears only advisory state and cannot sample a former correlation', async () => {
    const set = vi.fn<MetricsSnapshotStore['set']>(async () => {})
    const search = vi.fn<BrowserProgressPort['search']>(async () => [])
    const monitor = monitorWith({ progress: { search }, snapshots: { get: async () => null, set } })
    monitor.beginBatch({ requestIds: ['request-1'], concurrencyCap: 1, at: 0 })
    monitor.bindBrowserTransfer(7, 'request-1')
    await monitor.recordTerminal('request-1', 'complete', 0)

    await expect(monitor.reset()).resolves.toEqual({ active: 0, pending: false, cleared: true })
    const commit = vi.fn<() => Promise<void>>(async () => {})
    await monitor.onBrowserDelta({ downloadId: 7, terminal: true, at: 10, commitDurable: commit })
    await tick()

    expect(commit).toHaveBeenCalledOnce()
    expect(search).not.toHaveBeenCalled()
    expect(set).toHaveBeenLastCalledWith(null)
  })

  it('ignores corrupt session storage and exposes current live work', async () => {
    const set = vi.fn<MetricsSnapshotStore['set']>(async () => {})
    const monitor = monitorWith({
      progress: { search: async () => [] },
      snapshots: {
        get: async () => ({
          total: 1,
          completed: 0,
          failed: 0,
          active: Number.NaN,
          retries: 0,
          concurrencyCap: 1,
          bytesReceived: 0,
          bytesTotal: 0,
          throughputBps: 0,
          elapsedMs: 0,
        }),
        set,
      },
    })
    monitor.beginBatch({ requestIds: ['request-1'], concurrencyCap: 1, at: 0 })
    monitor.recordStarted('request-1', 0)

    await expect(monitor.read(10)).resolves.toMatchObject({ total: 1, active: 1 })
    await expect(monitor.reset()).resolves.toEqual({ active: 1, pending: true, cleared: false })
    expect(set).not.toHaveBeenCalled()
  })

  it('retains a queued batch before its first browser handle exists', async () => {
    const set = vi.fn<MetricsSnapshotStore['set']>(async () => {})
    const monitor = monitorWith({
      progress: { search: async () => [] },
      snapshots: { get: async () => null, set },
    })
    monitor.beginBatch({ requestIds: ['request-1'], concurrencyCap: 1, at: 0 })

    await expect(monitor.reset()).resolves.toEqual({ active: 0, pending: true, cleared: false })

    monitor.recordStarted('request-1', 1)
    await expect(monitor.read(1)).resolves.toMatchObject({ total: 1, active: 1 })
    expect(set).not.toHaveBeenCalled()
  })
})

describe('DownloadMonitor batch continuity', () => {
  it('extends a batch after one fast terminal while a sibling is still queued', async () => {
    const monitor = monitorWith({
      progress: { search: async () => [] },
      snapshots: { get: async () => null, set: async () => {} },
    })
    monitor.beginBatch({ requestIds: ['first', 'second'], concurrencyCap: 1, at: 0 })
    monitor.recordStarted('first', 0)
    await monitor.recordTerminal('first', 'complete', 1)

    monitor.beginBatch({ requestIds: ['third'], concurrencyCap: 1, at: 2 })

    await expect(monitor.read(2)).resolves.toMatchObject({
      total: 3,
      completed: 1,
    })
  })
})
