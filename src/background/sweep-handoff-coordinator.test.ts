/* oxlint-disable vitest/require-mock-type-parameters */
import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { SETTINGS_DEFAULTS } from '../core/schema'
import { makeSweepReceiptStore, type SweepReceiptStoreState } from './sweep-receipt-store'
import { makeSweepHandoffCoordinator } from './sweep-handoff-coordinator'
import type { SweepReceiptRepair } from './sweep-receipt-repair'
import {
  makeTransferLaunchCoordinator,
  type TransferLaunchCoordinator,
} from './transfer-launch-coordinator'
import type { TransferRegistry } from './transfer-registry'
import type { ClearWorklistStore } from './clear-worklist-store'

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

const secondItem = {
  ...item,
  id: 'media-2',
  postId: '456',
  url: 'https://pbs.twimg.com/media/b.jpg',
}

const selectedPosts = [
  { tweetId: item.postId, items: [item] },
  { tweetId: secondItem.postId, items: [secondItem] },
]

const sweepReceiptIds = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
] as const

const storage = () => {
  let value: unknown = null
  return {
    get: async () => value,
    set: async (next: SweepReceiptStoreState) => {
      value = next
    },
  }
}

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const makeTerminalHandoffHarness = ({
  trackedByTweet,
  claimSeededSweepPosts,
}: {
  readonly trackedByTweet: ReadonlyMap<string, ReadonlySet<string>>
  readonly claimSeededSweepPosts: ClearWorklistStore['claimSeededSweepPosts']
}) => {
  const receipts = makeSweepReceiptStore({ storage: storage() })
  const discardAbandoned = vi.spyOn(receipts, 'discardAbandoned')
  const registry = {
    prepareGroups: vi.fn(async () => ({
      launches: [
        { id: item.id, attempt: 0, since: 1 },
        { id: secondItem.id, attempt: 0, since: 1 },
      ],
      duplicateMainIds: [],
    })),
    abandonPrepared: vi.fn(async () => {}),
    releasePreparedStarts: vi.fn(async () => {}),
    armDirectCall: vi.fn(async () => {}),
    bindStarted: vi.fn(async () => {}),
    abandonSweepReceipt: vi.fn<TransferRegistry['abandonSweepReceipt']>(async () => true),
    listSweepReceiptIntents: vi.fn<TransferRegistry['listSweepReceiptIntents']>(async () => []),
    confirmSweepOwnership: vi.fn<TransferRegistry['confirmSweepOwnership']>(
      async (seeds: ReadonlyMap<string, number>) => new Set(seeds.keys()),
    ),
  }
  const clear = {
    seed: vi.fn(async () => ({ trackedByTweet, worklistRevision: 7 })),
    bindStarted: vi.fn(async () => undefined),
    failUnbound: vi.fn(async () => undefined),
  }
  const download = vi.fn(async () => 1)
  const launch = makeTransferLaunchCoordinator({
    settings: async () => ({ ...SETTINGS_DEFAULTS, clearOnSave: true, sidecarMetadata: false }),
    admission: { admit: async () => ({ admitted: [item, secondItem], skipped: [] }) },
    registry: () => registry as never,
    clear: clear as never,
    cloud: {
      recordCloudUploads: vi.fn(async () => ({ tag: 'unavailable' as const, reason: '' })),
    },
    monitor: {
      beginBatch: vi.fn(),
      persistBestEffort: vi.fn(async () => undefined),
      bindBrowserTransfer: vi.fn(),
      elapsedSinceRequest: vi.fn(() => 0),
      recordStarted: vi.fn(),
    },
    trace: vi.fn(),
    validateMediaUrls: vi.fn(),
    newProjectionId: (() => {
      let projection = 0
      return () => `projection-${++projection}`
    })(),
    newAria2Gid: () => '0000000000000001',
    download,
    fetchImpl: fetch,
  }).launch
  const handoff = makeSweepHandoffCoordinator({
    receipts,
    worklist: {
      selectSweepPosts: async (_scope, posts) => ({ posts, skipped: 0 }),
      claimSeededSweepPosts,
      ensureSeededSweepPosts: async () => 'owned' as const,
    },
    clear: clear as never,
    registry: () => registry as never,
    settings: async () => SETTINGS_DEFAULTS,
    launch,
    armWatchdog: async () => {},
    now: () => 10,
  })
  return { discardAbandoned, download, handoff, receipts, registry }
}

describe('SweepHandoffCoordinator', () => {
  it('retires every selected receipt when Clear ownership no longer exactly matches', async () => {
    const claimSeededSweepPosts = vi.fn<ClearWorklistStore['claimSeededSweepPosts']>()
    const randomUUID = vi
      .spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce(sweepReceiptIds[0])
      .mockReturnValueOnce(sweepReceiptIds[1])
    const { discardAbandoned, download, handoff, receipts, registry } = makeTerminalHandoffHarness({
      trackedByTweet: new Map([
        [item.postId, new Set([item.id])],
        [secondItem.postId, new Set(['wrong-media'])],
      ]),
      claimSeededSweepPosts,
    })

    try {
      await expect(handoff.enqueue('bookmark', selectedPosts)).resolves.toEqual({
        _tag: 'SweepEnqueueResponse',
        queued: 0,
        skipped: 2,
      })
    } finally {
      randomUUID.mockRestore()
    }

    expect(claimSeededSweepPosts).not.toHaveBeenCalled()
    expect(registry.confirmSweepOwnership).not.toHaveBeenCalled()
    expect(registry.releasePreparedStarts).not.toHaveBeenCalled()
    expect(download).not.toHaveBeenCalled()
    expect(registry.abandonSweepReceipt).toHaveBeenNthCalledWith(1, sweepReceiptIds[0])
    expect(registry.abandonSweepReceipt).toHaveBeenNthCalledWith(2, sweepReceiptIds[1])
    expect(discardAbandoned).toHaveBeenNthCalledWith(1, sweepReceiptIds[0])
    expect(discardAbandoned).toHaveBeenNthCalledWith(2, sweepReceiptIds[1])
    await expect(receipts.listRecoverable()).resolves.toEqual([])
  })

  it('retires every selected receipt when Worklist reports a terminal post', async () => {
    const claimSeededSweepPosts = vi.fn<ClearWorklistStore['claimSeededSweepPosts']>(async () => ({
      claimed: 1,
      skipped: 1,
      terminalTweetIds: [secondItem.postId],
    }))
    const randomUUID = vi
      .spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce(sweepReceiptIds[0])
      .mockReturnValueOnce(sweepReceiptIds[1])
    const { discardAbandoned, download, handoff, receipts, registry } = makeTerminalHandoffHarness({
      trackedByTweet: new Map([
        [item.postId, new Set([item.id])],
        [secondItem.postId, new Set([secondItem.id])],
      ]),
      claimSeededSweepPosts,
    })

    try {
      await expect(handoff.enqueue('bookmark', selectedPosts)).resolves.toEqual({
        _tag: 'SweepEnqueueResponse',
        queued: 0,
        skipped: 2,
      })
    } finally {
      randomUUID.mockRestore()
    }

    expect(claimSeededSweepPosts).toHaveBeenCalledWith('bookmark', ['123', '456'], 7)
    expect(registry.confirmSweepOwnership).not.toHaveBeenCalled()
    expect(registry.releasePreparedStarts).not.toHaveBeenCalled()
    expect(download).not.toHaveBeenCalled()
    expect(registry.abandonSweepReceipt).toHaveBeenNthCalledWith(1, sweepReceiptIds[0])
    expect(registry.abandonSweepReceipt).toHaveBeenNthCalledWith(2, sweepReceiptIds[1])
    expect(discardAbandoned).toHaveBeenNthCalledWith(1, sweepReceiptIds[0])
    expect(discardAbandoned).toHaveBeenNthCalledWith(2, sweepReceiptIds[1])
    await expect(receipts.listRecoverable()).resolves.toEqual([])
  })

  it('requests durable same-life repair after a post-seed handoff failure', async () => {
    const receipts = makeSweepReceiptStore({ storage: storage() })
    const requestSameLifeRepair = vi.fn<() => void>()
    const launch = vi.fn<TransferLaunchCoordinator['launch']>(
      (input: {
        readonly onClearSeeded?: (
          tracked: Map<string, Set<string>>,
          revision: number,
        ) => Promise<unknown>
      }) =>
        Effect.promise(async () => {
          await input.onClearSeeded?.(new Map([['123', new Set(['media-1'])]]), 7)
          throw new Error('worklist write failed')
        }),
    )
    const handoff = makeSweepHandoffCoordinator({
      receipts,
      worklist: {
        selectSweepPosts: async (_scope, posts) => ({ posts, skipped: 0 }),
        claimSeededSweepPosts: async () => {
          throw new Error('worklist write failed')
        },
        ensureSeededSweepPosts: async () => 'owned' as const,
      },
      clear: { seed: async () => ({}) as never },
      registry: () => undefined,
      settings: async () => SETTINGS_DEFAULTS,
      launch: launch as never,
      armWatchdog: async () => {},
      now: () => 10,
      requestSameLifeRepair,
    })

    await expect(handoff.enqueue('bookmark', [{ tweetId: '123', items: [item] }])).resolves.toEqual(
      {
        _tag: 'SweepEnqueueResponse',
        queued: 0,
        skipped: 1,
      },
    )
    expect(requestSameLifeRepair).toHaveBeenCalledOnce()
    await expect(receipts.listRecoverable()).resolves.toHaveLength(1)
  })

  it('reports queued after Registry confirmation when receipt acknowledgement dies', async () => {
    let value: unknown = null
    let writes = 0
    const receipts = makeSweepReceiptStore({
      storage: {
        get: async () => value,
        set: async (next) => {
          writes += 1
          if (writes === 3) throw new Error('receipt acknowledgement lost')
          value = next
        },
      },
    })
    const requestSameLifeRepair = vi.fn<() => void>()
    const registry = {
      confirmSweepOwnership: vi.fn<TransferRegistry['confirmSweepOwnership']>(
        async () => new Set(['sweep-1']),
      ),
    }
    const launch = vi.fn<TransferLaunchCoordinator['launch']>(
      (input: {
        readonly onClearSeeded?: (
          tracked: Map<string, Set<string>>,
          revision: number,
        ) => Promise<unknown>
      }) =>
        Effect.promise(async () => {
          await input.onClearSeeded?.(new Map([['123', new Set(['media-1'])]]), 7)
          return {
            _tag: 'QueueUpdate' as const,
            planned: ['media-1'],
            started: [],
            deferred: [],
            duplicates: [],
            failures: [],
            skipped: [],
          }
        }),
    )
    const handoff = makeSweepHandoffCoordinator({
      receipts,
      worklist: {
        selectSweepPosts: async (_scope, posts) => ({ posts, skipped: 0 }),
        claimSeededSweepPosts: async () => ({ claimed: 1, skipped: 0, terminalTweetIds: [] }),
        ensureSeededSweepPosts: async () => 'owned' as const,
      },
      clear: { seed: async () => ({}) as never },
      registry: () => registry as never,
      settings: async () => SETTINGS_DEFAULTS,
      launch: launch as never,
      armWatchdog: async () => {},
      now: () => 10,
      requestSameLifeRepair,
    })

    await expect(handoff.enqueue('bookmark', [{ tweetId: '123', items: [item] }])).resolves.toEqual(
      {
        _tag: 'SweepEnqueueResponse',
        queued: 1,
        skipped: 0,
      },
    )
    expect(registry.confirmSweepOwnership).toHaveBeenCalledOnce()
    expect(requestSameLifeRepair).toHaveBeenCalledOnce()
    await expect(receipts.listRecoverable()).resolves.toHaveLength(1)
  })

  it('requests repair and later releases Registry work when launch fails after receipt ack', async () => {
    const receipts = makeSweepReceiptStore({ storage: storage() })
    const requestSameLifeRepair = vi.fn<() => void>()
    const registry = {
      confirmSweepOwnership: vi.fn<TransferRegistry['confirmSweepOwnership']>(
        async (seeds: ReadonlyMap<string, number>) => new Set(seeds.keys()),
      ),
      listSweepReceiptIntents: vi.fn<TransferRegistry['listSweepReceiptIntents']>(async () => []),
      abandonSweepReceipt: vi.fn<TransferRegistry['abandonSweepReceipt']>(async () => false),
    }
    const launch = vi.fn<TransferLaunchCoordinator['launch']>(
      (input: {
        readonly onClearSeeded?: (
          tracked: Map<string, Set<string>>,
          revision: number,
        ) => Promise<unknown>
      }) =>
        Effect.promise(async () => {
          await input.onClearSeeded?.(new Map([['123', new Set(['media-1'])]]), 7)
          throw new Error('cloud admission failed')
        }),
    )
    const handoff = makeSweepHandoffCoordinator({
      receipts,
      worklist: {
        selectSweepPosts: async (_scope, posts) => ({ posts, skipped: 0 }),
        claimSeededSweepPosts: async () => ({ claimed: 1, skipped: 0, terminalTweetIds: [] }),
        ensureSeededSweepPosts: async () => 'owned' as const,
      },
      clear: { seed: async () => ({}) as never },
      registry: () => registry as never,
      settings: async () => SETTINGS_DEFAULTS,
      launch: launch as never,
      armWatchdog: async () => {},
      now: () => 10,
      requestSameLifeRepair,
    })

    await expect(handoff.enqueue('bookmark', [{ tweetId: '123', items: [item] }])).resolves.toEqual(
      {
        _tag: 'SweepEnqueueResponse',
        queued: 1,
        skipped: 0,
      },
    )
    await expect(receipts.listRecoverable()).resolves.toEqual([])
    expect(requestSameLifeRepair).toHaveBeenCalledOnce()

    const release = vi.fn<(repair: SweepReceiptRepair) => Promise<void>>(async () => {})
    await handoff.recoverThroughRelease(release)
    expect(release).toHaveBeenCalledOnce()
  })

  it('arms the watchdog before the first durable receipt write', async () => {
    const events: string[] = []
    let receiptState: unknown = null
    const receipts = makeSweepReceiptStore({
      storage: {
        get: async () => receiptState,
        set: async (next) => {
          events.push('receipt-write')
          receiptState = next
        },
      },
    })
    const handoff = makeSweepHandoffCoordinator({
      receipts,
      worklist: {
        selectSweepPosts: async (_scope, posts) => ({ posts, skipped: 0 }),
        claimSeededSweepPosts: vi.fn<ClearWorklistStore['claimSeededSweepPosts']>(),
        ensureSeededSweepPosts: async () => 'owned' as const,
      },
      clear: { seed: async () => ({}) as never },
      registry: () => ({ abandonSweepReceipt: async () => true }) as never,
      settings: async () => SETTINGS_DEFAULTS,
      launch: (() =>
        Effect.succeed({
          _tag: 'QueueUpdate',
          planned: [],
          started: [],
          deferred: [],
          duplicates: [],
          failures: [],
          skipped: [],
        })) as never,
      armWatchdog: async () => {
        events.push('watchdog')
      },
      now: () => 10,
    })

    await handoff.enqueue('bookmark', [{ tweetId: '123', items: [item] }])

    expect(events.slice(0, 2)).toEqual(['watchdog', 'receipt-write'])
  })

  it('keeps crash-window receipt state owned by its armed alarm', async () => {
    const events: string[] = []
    const started = deferred<void>()
    const release = deferred<void>()
    const receipts = makeSweepReceiptStore({ storage: storage() })
    const handoff = makeSweepHandoffCoordinator({
      receipts,
      worklist: {
        selectSweepPosts: async (_scope, posts) => ({ posts, skipped: 0 }),
        claimSeededSweepPosts: vi.fn<ClearWorklistStore['claimSeededSweepPosts']>(),
        ensureSeededSweepPosts: async () => 'owned' as const,
      },
      clear: { seed: async () => ({}) as never },
      registry: () =>
        ({
          listSweepReceiptIntents: async () => [],
          abandonSweepReceipt: async () => false,
          confirmSweepOwnership: async () => new Set(),
        }) as never,
      settings: async () => SETTINGS_DEFAULTS,
      launch: (() =>
        Effect.promise(async () => {
          started.resolve()
          await release.promise
          return {
            _tag: 'QueueUpdate' as const,
            planned: [],
            started: [],
            deferred: [],
            duplicates: [],
            failures: [],
            skipped: [],
          }
        })) as never,
      armWatchdog: async () => {
        events.push('watchdog')
      },
      now: () => 10,
    })

    const enqueue = handoff.enqueue('bookmark', [{ tweetId: '123', items: [item] }])
    await started.promise
    // The one-shot alarm fired during enqueue. Its repair queues behind this
    // lane, but its replacement must exist before the queued repair can run.
    const recover = handoff.recoverThroughRelease(async () => {})

    await expect(receipts.listRecoverable()).resolves.toHaveLength(1)
    await vi.waitFor(() => expect(events).toEqual(['watchdog', 'watchdog']))

    release.resolve()
    await enqueue
    await recover
  })

  it('fails closed when watchdog arming fails before receipt durability', async () => {
    const receiptWrite = vi.fn<(state: SweepReceiptStoreState) => Promise<void>>(async () => {})
    const launch = vi.fn<TransferLaunchCoordinator['launch']>()
    const handoff = makeSweepHandoffCoordinator({
      receipts: makeSweepReceiptStore({ storage: { get: async () => null, set: receiptWrite } }),
      worklist: {
        selectSweepPosts: async (_scope, posts) => ({ posts, skipped: 0 }),
        claimSeededSweepPosts: vi.fn<ClearWorklistStore['claimSeededSweepPosts']>(),
        ensureSeededSweepPosts: async () => 'owned' as const,
      },
      clear: { seed: async () => ({}) as never },
      registry: () => undefined,
      settings: async () => SETTINGS_DEFAULTS,
      launch: launch as never,
      armWatchdog: async () => {
        throw new Error('alarm unavailable')
      },
      now: () => 10,
    })

    await expect(handoff.enqueue('bookmark', [{ tweetId: '123', items: [item] }])).rejects.toThrow(
      'alarm unavailable',
    )
    expect(receiptWrite).not.toHaveBeenCalled()
    expect(launch).not.toHaveBeenCalled()
  })

  it('re-arms the consumed alarm before repairing durable Sweep state', async () => {
    const events: string[] = []
    const receipts = makeSweepReceiptStore({ storage: storage() })
    await receipts.enqueue({
      receiptId: 'sweep-1',
      tweetId: '123',
      scope: 'bookmark',
      itemIds: ['media-1'],
      at: 10,
    })
    await receipts.markSeeded({
      receiptId: 'sweep-1',
      requestIds: ['media-1'],
      clearSeedId: 7,
      at: 11,
    })
    const handoff = makeSweepHandoffCoordinator({
      receipts,
      worklist: {
        selectSweepPosts: async (_scope, posts) => ({ posts, skipped: 0 }),
        claimSeededSweepPosts: vi.fn<ClearWorklistStore['claimSeededSweepPosts']>(),
        ensureSeededSweepPosts: async () => {
          events.push('repair')
          return 'owned' as const
        },
      },
      clear: { seed: async () => ({}) as never },
      registry: () =>
        ({
          listSweepReceiptIntents: async () => [],
          abandonSweepReceipt: async () => false,
          confirmSweepOwnership: async (seeds: ReadonlyMap<string, number>) =>
            new Set(seeds.keys()),
        }) as never,
      settings: async () => SETTINGS_DEFAULTS,
      launch: vi.fn<TransferLaunchCoordinator['launch']>() as never,
      armWatchdog: async () => {
        events.push('watchdog')
      },
      now: () => 12,
    })

    await handoff.recoverThroughRelease(async () => {})

    expect(events).toEqual(['watchdog', 'repair'])
  })

  it('repairs, confirms, acknowledges, then runs the required release policy', async () => {
    const events: string[] = []
    const receipts = makeSweepReceiptStore({ storage: storage() })
    await receipts.enqueue({
      receiptId: 'sweep-1',
      tweetId: '123',
      scope: 'bookmark',
      itemIds: ['media-1'],
      at: 10,
    })
    await receipts.markSeeded({
      receiptId: 'sweep-1',
      requestIds: ['media-1'],
      clearSeedId: 7,
      at: 11,
    })
    const acknowledge = receipts.ackOwned.bind(receipts)
    vi.spyOn(receipts, 'ackOwned').mockImplementation(async (input) => {
      events.push('ack')
      await acknowledge(input)
    })
    const handoff = makeSweepHandoffCoordinator({
      receipts,
      worklist: {
        selectSweepPosts: async (_scope, posts) => ({ posts, skipped: 0 }),
        claimSeededSweepPosts: vi.fn<ClearWorklistStore['claimSeededSweepPosts']>(),
        ensureSeededSweepPosts: async () => {
          events.push('repair')
          return 'owned' as const
        },
      },
      clear: { seed: async () => ({}) as never },
      registry: () =>
        ({
          listSweepReceiptIntents: async () => [],
          abandonSweepReceipt: async () => false,
          confirmSweepOwnership: async () => {
            events.push('confirm')
            return new Set(['sweep-1'])
          },
        }) as never,
      settings: async () => SETTINGS_DEFAULTS,
      launch: vi.fn<TransferLaunchCoordinator['launch']>() as never,
      armWatchdog: async () => {
        events.push('watchdog')
      },
      now: () => 12,
    })

    await handoff.recoverThroughRelease(async () => {
      events.push('release')
    })

    expect(events).toEqual(['watchdog', 'repair', 'confirm', 'ack', 'release'])
  })

  it('keeps prepared Registry work retryable when the release policy fails', async () => {
    const events: string[] = []
    const receipts = makeSweepReceiptStore({ storage: storage() })
    await receipts.enqueue({
      receiptId: 'sweep-1',
      tweetId: '123',
      scope: 'bookmark',
      itemIds: ['media-1'],
      at: 10,
    })
    await receipts.markSeeded({
      receiptId: 'sweep-1',
      requestIds: ['media-1'],
      clearSeedId: 7,
      at: 11,
    })
    let prepared = true
    let releaseAttempts = 0
    const releasePrepared = async (): Promise<void> => {
      releaseAttempts += 1
      events.push('release')
      if (releaseAttempts === 1) throw new Error('cloud admission unavailable')
      prepared = false
    }
    const handoff = makeSweepHandoffCoordinator({
      receipts,
      worklist: {
        selectSweepPosts: async (_scope, posts) => ({ posts, skipped: 0 }),
        claimSeededSweepPosts: vi.fn<ClearWorklistStore['claimSeededSweepPosts']>(),
        ensureSeededSweepPosts: async () => 'owned' as const,
      },
      clear: { seed: async () => ({}) as never },
      registry: () =>
        ({
          listSweepReceiptIntents: async () => [],
          abandonSweepReceipt: async () => false,
          confirmSweepOwnership: async (seeds: ReadonlyMap<string, number>) =>
            new Set(seeds.keys()),
        }) as never,
      settings: async () => SETTINGS_DEFAULTS,
      launch: vi.fn<TransferLaunchCoordinator['launch']>() as never,
      armWatchdog: async () => {
        events.push('watchdog')
      },
      now: () => 12,
    })

    await expect(handoff.recoverThroughRelease(releasePrepared)).rejects.toThrow(
      'cloud admission unavailable',
    )

    expect(prepared).toBe(true)
    await handoff.recoverThroughRelease(releasePrepared)

    expect(prepared).toBe(false)
    expect(events).toEqual(['watchdog', 'release', 'watchdog', 'release'])
  })
})
