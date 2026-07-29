import { Schema } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { makeTerminalProjector, type TerminalProjectorDeps } from './terminal-projector'
import type { TerminalProjection } from '../core/download/terminal-outcome'
import { MediaItem, Settings as SettingsSchema, type Settings } from '../core/schema'

const CREATED = 100
const OBSERVED = 200
const item = Schema.decodeUnknownSync(MediaItem)({
  id: 'media-1',
  platform: 'x',
  postId: 'tweet-1',
  author: 'alice',
  type: 'photo',
  url: 'https://pbs.twimg.com/media/a?format=jpg&name=orig',
  ext: 'jpg',
  index: 0,
})
const settings: Settings = Schema.decodeUnknownSync(SettingsSchema)({
  cloudSyncEnabled: true,
  convexUrl: 'https://x.convex.cloud',
  convexSyncSecret: 'secret',
  cloudDeviceId: 'device-1',
  dailyMaxCount: 100,
})
const budgetDisabledSettings: Settings = Schema.decodeUnknownSync(SettingsSchema)({
  cloudSyncEnabled: true,
  convexUrl: 'https://x.convex.cloud',
  convexSyncSecret: 'secret',
  cloudDeviceId: 'device-1',
})
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const projection = (over: Partial<TerminalProjection> = {}): TerminalProjection => ({
  projectionId: 'terminal-1',
  requestId: item.id,
  logicalRequestId: item.id,
  createdAt: CREATED,
  observedAt: OBSERVED,
  outcome: 'complete',
  mode: 'direct',
  historyPolicy: 'record',
  filename: 'alice.jpg',
  item,
  evidence: {
    tag: 'browser',
    downloadId: 7,
    state: 'complete',
    bytesReceived: 40,
    totalBytes: 50,
  },
  ...over,
})

const harness = (over: Partial<TerminalProjectorDeps> = {}) => {
  const calls: string[] = []
  const clear = {
    projectTerminal: vi.fn<TerminalProjectorDeps['clear']['projectTerminal']>(async () => {
      calls.push('clear')
    }),
    projectStartFailure: vi.fn<TerminalProjectorDeps['clear']['projectStartFailure']>(async () => {
      calls.push('clear-start-failed')
    }),
  }
  const releaseFetched = vi.fn<TerminalProjectorDeps['releaseFetched']>(async () => {
    calls.push('release')
  })
  const history = {
    projectTerminal: vi.fn<TerminalProjectorDeps['history']['projectTerminal']>(async () => {
      calls.push('history')
    }),
  }
  const sync = {
    recordSync: vi.fn<TerminalProjectorDeps['sync']['recordSync']>(async () => {
      calls.push('sync')
    }),
  }
  const snapshot = vi.fn<TerminalProjectorDeps['settings']['snapshot']>(async () => {
    calls.push('settings')
    return settings
  })
  const budget = {
    recordCompletion: vi.fn<TerminalProjectorDeps['budget']['recordCompletion']>(async () => {
      calls.push('budget')
    }),
  }
  const deps: TerminalProjectorDeps = {
    clear,
    releaseFetched,
    history,
    sync,
    settings: { snapshot },
    budget,
    ...over,
  }
  return {
    calls,
    clear,
    releaseFetched,
    history,
    sync,
    snapshot,
    budget,
    projector: makeTerminalProjector(deps),
  }
}

describe('TerminalProjector', () => {
  it('persists browser terminal truth in order, once, with durable timestamps', async () => {
    const h = harness()
    await h.projector.project(projection({ mode: 'fetched' }))

    expect(h.calls).toEqual(['clear', 'history', 'settings', 'sync', 'budget', 'release'])
    expect(h.clear.projectTerminal).toHaveBeenCalledWith({
      tweetId: 'tweet-1',
      requestId: 'media-1',
      downloadId: 7,
      outcome: 'complete',
      observedAt: OBSERVED,
    })
    expect(h.history.projectTerminal).toHaveBeenCalledWith({
      projectionId: 'terminal-1',
      actions: [
        {
          kind: 'queued',
          recordingEnabled: true,
          requestId: 'media-1',
          item,
          filename: 'alice.jpg',
          at: CREATED,
        },
        {
          kind: 'completed',
          requestId: 'media-1',
          at: OBSERVED,
          bytes: { received: 40, total: 50 },
        },
      ],
      completedItem: item,
    })
    expect(h.snapshot).toHaveBeenCalledTimes(1)
    expect(h.sync.recordSync).toHaveBeenCalledWith([
      expect.objectContaining({ kind: 'queued', requestId: 'media-1', at: CREATED }),
      expect.objectContaining({ kind: 'completed', requestId: 'media-1', at: OBSERVED }),
    ])
    expect(h.budget.recordCompletion).toHaveBeenCalledWith('terminal-1', OBSERVED, 40, 1)
  })

  it('retains a fetched lease through a durable failure, then replays before release', async () => {
    const h = harness()
    h.sync.recordSync.mockRejectedValueOnce(new Error('outbox full'))
    await expect(h.projector.project(projection({ mode: 'fetched' }))).rejects.toThrow(
      'outbox full',
    )
    expect(h.budget.recordCompletion).not.toHaveBeenCalled()
    expect(h.releaseFetched).not.toHaveBeenCalled()

    await h.projector.project(projection({ mode: 'fetched' }))
    expect(h.history.projectTerminal).toHaveBeenCalledTimes(2)
    expect(h.sync.recordSync).toHaveBeenCalledTimes(2)
    expect(h.budget.recordCompletion).toHaveBeenCalledTimes(1)
    expect(h.releaseFetched).toHaveBeenCalledOnce()
  })

  it('replays durable fetched sinks when release fails', async () => {
    const h = harness()
    h.releaseFetched.mockRejectedValueOnce(new Error('lease store unavailable'))

    await expect(h.projector.project(projection({ mode: 'fetched' }))).rejects.toThrow(
      'lease store unavailable',
    )
    expect(h.history.projectTerminal).toHaveBeenCalledOnce()
    expect(h.sync.recordSync).toHaveBeenCalledOnce()
    expect(h.budget.recordCompletion).toHaveBeenCalledOnce()

    await h.projector.project(projection({ mode: 'fetched' }))
    expect(h.history.projectTerminal).toHaveBeenCalledTimes(2)
    expect(h.sync.recordSync).toHaveBeenCalledTimes(2)
    expect(h.budget.recordCompletion).toHaveBeenCalledTimes(2)
    expect(h.releaseFetched).toHaveBeenCalledTimes(2)
  })

  it('does not track completions while both daily limits are disabled', async () => {
    const snapshot = vi.fn<TerminalProjectorDeps['settings']['snapshot']>(
      async () => budgetDisabledSettings,
    )
    const h = harness({ settings: { snapshot } })

    await h.projector.project(projection())

    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(h.budget.recordCompletion).not.toHaveBeenCalled()
  })

  it('keeps sidecars out of durable user projections', async () => {
    const h = harness()
    await h.projector.project(projection({ item: undefined }))

    expect(h.clear.projectTerminal).not.toHaveBeenCalled()
    expect(h.history.projectTerminal).not.toHaveBeenCalled()
    expect(h.snapshot).not.toHaveBeenCalled()
    expect(h.sync.recordSync).not.toHaveBeenCalled()
    expect(h.budget.recordCompletion).not.toHaveBeenCalled()
  })

  it('projects a migrated row as terminal-only', async () => {
    const h = harness()
    await h.projector.project(projection({ historyPolicy: 'transition-only' }))

    expect(h.history.projectTerminal).toHaveBeenCalledWith({
      projectionId: 'terminal-1',
      actions: [
        {
          kind: 'completed',
          requestId: 'media-1',
          at: OBSERVED,
          bytes: { received: 40, total: 50 },
        },
      ],
      completedItem: item,
    })
    expect(h.sync.recordSync.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ kind: 'completed', requestId: 'media-1', at: OBSERVED }),
    ])
  })

  it('honours an off history policy without suppressing Sync', async () => {
    const h = harness()
    await h.projector.project(projection({ historyPolicy: 'off' }))

    expect(h.history.projectTerminal).toHaveBeenCalledWith({
      projectionId: 'terminal-1',
      actions: [],
      completedItem: item,
    })
    expect(h.sync.recordSync).toHaveBeenCalledTimes(1)
  })

  it('never rounds unsafe aria2 decimals or clears aria2', async () => {
    const h = harness()
    await h.projector.project(
      projection({
        mode: 'aria2',
        evidence: {
          tag: 'aria2',
          gid: '0000000000000001',
          profileId: 'profile-1',
          status: 'complete',
          completedLength: '9007199254740992',
          totalLength: '9007199254740993',
        },
      }),
    )

    expect(h.clear.projectTerminal).not.toHaveBeenCalled()
    expect(h.releaseFetched).not.toHaveBeenCalled()
    expect(h.history.projectTerminal.mock.calls[0]?.[0]?.actions[1]).toEqual({
      kind: 'completed',
      requestId: 'media-1',
      at: OBSERVED,
    })
    expect(h.budget.recordCompletion).toHaveBeenCalledWith('terminal-1', OBSERVED, 0, 1)
  })

  it('never budgets a failed or local start failure', async () => {
    const failed = harness()
    await failed.projector.project(projection({ outcome: 'failed' }))
    expect(failed.clear.projectTerminal).toHaveBeenCalledTimes(1)
    expect(failed.budget.recordCompletion).not.toHaveBeenCalled()

    const broadcast = vi.fn<NonNullable<TerminalProjectorDeps['broadcast']>>(async () => {})
    const startFailed = harness({ broadcast })
    await startFailed.projector.project(
      projection({ evidence: { tag: 'start-failed' }, outcome: 'failed' }),
    )
    expect(startFailed.clear.projectTerminal).not.toHaveBeenCalled()
    expect(startFailed.clear.projectStartFailure).toHaveBeenCalledWith({
      tweetId: 'tweet-1',
      requestId: 'media-1',
      observedAt: OBSERVED,
    })
    expect(startFailed.budget.recordCompletion).not.toHaveBeenCalled()
    await tick()
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('contains every noncritical failure and delegates each metrics transition', async () => {
    const recordMetrics = vi.fn<NonNullable<TerminalProjectorDeps['metrics']>['record']>(
      async () => {
        throw new Error('metrics quota')
      },
    )
    const broadcast = vi.fn<NonNullable<TerminalProjectorDeps['broadcast']>>(async () => {
      throw new Error('tab closed')
    })
    const trace = vi.fn<NonNullable<TerminalProjectorDeps['trace']>>(async () => {
      throw new Error('trace down')
    })
    const h = harness({
      metrics: { record: recordMetrics },
      broadcast,
      trace,
    })
    await expect(h.projector.project(projection())).resolves.toBeUndefined()
    await tick()
    expect(recordMetrics).toHaveBeenCalledWith('media-1', 'complete', OBSERVED)
    expect(broadcast).toHaveBeenCalledWith({
      _tag: 'TransferOutcome',
      requestId: 'media-1',
      outcome: 'complete',
      at: OBSERVED,
    })
    expect(trace).toHaveBeenCalledWith(
      'terminal-projected',
      expect.objectContaining({ observedAt: OBSERVED }),
    )

    const withMetrics = harness({ metrics: { record: recordMetrics } })
    await withMetrics.projector.project(projection())
    await withMetrics.projector.project(
      projection({ requestId: 'media-2', projectionId: 'v2:media-2:100' }),
    )
    await tick()
    expect(recordMetrics).toHaveBeenLastCalledWith('media-2', 'complete', OBSERVED)
  })
})
