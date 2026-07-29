/* oxlint-disable vitest/require-mock-type-parameters */
import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { SETTINGS_DEFAULTS } from '../core/schema/settings'
import { decodeQueueUpdate, type MediaItem } from '../core/schema'
import { sidecarRequestId } from '../core/download/request-identity'
import type { TransferRegistry } from './transfer-registry'
import {
  makeTransferLaunchCoordinator,
  type TransferLaunchCoordinatorDeps,
} from './transfer-launch-coordinator'

const item: MediaItem = {
  id: 'media-1',
  platform: 'x',
  postId: '123',
  author: 'author',
  type: 'photo',
  url: 'https://pbs.twimg.com/media/a.jpg',
  ext: 'jpg',
  index: 0,
}

const deps = (): TransferLaunchCoordinatorDeps => ({
  settings: vi.fn(async () => SETTINGS_DEFAULTS),
  admission: { admit: vi.fn(async () => ({ admitted: [], skipped: [] })) },
  registry: vi.fn(() => undefined),
  clear: {
    seed: vi.fn(async () => ({}) as never),
    bindStarted: vi.fn(async () => undefined),
    failUnbound: vi.fn(async () => undefined),
  },
  cloud: {
    recordCloudUploads: vi.fn(async () => ({
      tag: 'unavailable' as const,
      reason: '',
    })),
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
  newProjectionId: () => 'projection-1',
  newAria2Gid: () => '0000000000000001',
  download: vi.fn(async () => 1),
  fetchImpl: fetch,
})

describe('TransferLaunchCoordinator URL gate', () => {
  it('rejects unsafe media before admission dereferences it', async () => {
    const registry = vi.fn(() => ({}) as never)
    const validateMediaUrls = vi.fn(() => {
      throw new Error('untrusted host')
    })
    const d = { ...deps(), registry, validateMediaUrls }
    const result = await Effect.runPromise(
      makeTransferLaunchCoordinator(d).launch({ items: [item] }),
    )
    expect(d.validateMediaUrls).toHaveBeenCalledWith(item)
    expect(d.admission.admit).toHaveBeenCalledWith([])
    expect(registry).toHaveBeenCalledOnce()
    expect(result).toEqual({
      _tag: 'QueueUpdate',
      planned: [],
      started: [],
      deferred: [],
      duplicates: [],
      failures: [],
      skipped: [{ requestId: item.id, reason: 'unsafe-url' }],
    })
    expect(decodeQueueUpdate(result, [item])).toEqual(result)
    expect(decodeQueueUpdate(result, [item])).toEqual(result)
  })

  it('does not dereference any item until every URL passes validation', async () => {
    const order: string[] = []
    const d = {
      ...deps(),
      registry: vi.fn(() => ({}) as never),
      validateMediaUrls: vi.fn(() => order.push('validate')),
      admission: {
        admit: vi.fn(async () => {
          order.push('admit')
          return { admitted: [], skipped: [] }
        }),
      },
    }
    await Effect.runPromise(makeTransferLaunchCoordinator(d).launch({ items: [item] }))
    expect(order).toEqual(['validate', 'admit'])
  })

  it.each(['main', 'sidecar'] as const)(
    'does not launch either artifact when this media group has a duplicate',
    async (_duplicate) => {
      const sidecarId = sidecarRequestId(item)
      const registry = {
        prepareGroups: vi.fn(async () => ({
          launches: [],
          duplicateMainIds: [item.id],
        })),
        abandonPrepared: vi.fn(async () => {}),
        releasePreparedStarts: vi.fn(async () => {}),
      } as unknown as TransferRegistry
      const d = {
        ...deps(),
        settings: async () => ({ ...SETTINGS_DEFAULTS, sidecarMetadata: true }),
        admission: {
          admit: vi.fn(async () => ({ admitted: [item], skipped: [] })),
        },
        registry: () => registry,
      }

      const result = await Effect.runPromise(
        makeTransferLaunchCoordinator(d).launch({ items: [item] }),
      )
      expect(result).toEqual({
        _tag: 'QueueUpdate',
        planned: [],
        started: [],
        deferred: [],
        duplicates: [item.id],
        failures: [],
        skipped: [],
      })
      expect(decodeQueueUpdate(result, [item])).toEqual(result)
      expect(registry.prepareGroups).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            mainId: item.id,
            requests: expect.arrayContaining([
              expect.objectContaining({ id: item.id }),
              expect.objectContaining({ id: sidecarId }),
            ]),
          }),
        ],
        expect.anything(),
      )
      expect(registry.abandonPrepared).not.toHaveBeenCalled()
      expect(d.download).not.toHaveBeenCalled()
    },
  )
})

describe('TransferLaunchCoordinator monitor timing', () => {
  it('returns after durable Fetched enqueue without opening its source', async () => {
    const order: string[] = []
    const registry = {
      prepareGroups: vi.fn(async () => ({
        launches: [{ id: item.id, attempt: 0, since: 1 }],
        duplicateMainIds: [],
      })),
      abandonPrepared: vi.fn(async () => {}),
      releasePreparedStarts: vi.fn(async () => {
        order.push('release')
      }),
      armFetchedCall: vi.fn(async () => {
        order.push('arm')
      }),
      bindStarted: vi.fn(async () => {
        order.push('bind')
      }),
      armDirectCall: vi.fn(async () => {}),
      armAria2Call: vi.fn(async () => {}),
      deferLaunch: vi.fn(async () => {}),
      rejectStart: vi.fn(async () => {}),
      resolveUntrackedStart: vi.fn(async () => {}),
    } as unknown as TransferRegistry
    const gateway = {
      reserve: vi.fn(async () => {
        order.push('reserve')
        return { kind: 'reserved' as const, leaseId: 'lease-1' }
      }),
      awaitCaptureReservation: vi.fn(async () => ({
        kind: 'reserved' as const,
        leaseId: 'lease-1',
      })),
      startReserved: vi.fn(async () => {
        order.push('start')
        return { kind: 'started' as const, downloadId: 7 }
      }),
      start: vi.fn(async () => ({ kind: 'unavailable' as const })),
      releaseTerminal: vi.fn(async () => {}),
      releaseCaptureTerminal: vi.fn(async () => {}),
      discardRecoveredStaging: vi.fn(async () => {}),
      inspectOnBoot: vi.fn(async () => ({
        tag: 'available' as const,
        observations: [],
      })),
    }
    const d = {
      ...deps(),
      settings: async () => ({
        ...SETTINGS_DEFAULTS,
        downloadStrategy: 'fetched' as const,
        sidecarMetadata: false,
      }),
      admission: {
        admit: vi.fn(async () => ({ admitted: [item], skipped: [] })),
      },
      registry: () => registry,
      gateway,
      fetch: {
        fetch: vi.fn(async () => ({
          ok: true,
          status: 200,
          contentType: 'image/jpeg',
          contentLength: 1,
          body: {
            read: vi.fn(async () => ({ done: true as const })),
            cancel: vi.fn(async () => {}),
          },
        })),
      },
      monitor: {
        ...deps().monitor,
        persistBestEffort: vi.fn(async () => {
          throw new Error('session storage unavailable')
        }),
      },
    }

    await expect(
      Effect.runPromise(makeTransferLaunchCoordinator(d).launch({ items: [item] })),
    ).resolves.toMatchObject({ started: [], deferred: [item.id] })
    expect(order).toEqual(['release'])
    expect(gateway.reserve).not.toHaveBeenCalled()
    expect(gateway.startReserved).not.toHaveBeenCalled()
    expect(gateway.start).not.toHaveBeenCalled()
  })

  it('never retries a Direct start after its Registry arm', async () => {
    const registry = {
      prepareGroups: vi.fn(async () => ({
        launches: [{ id: item.id, attempt: 0, since: 1 }],
        duplicateMainIds: [],
      })),
      abandonPrepared: vi.fn(async () => {}),
      releasePreparedStarts: vi.fn(async () => {}),
      armDirectCall: vi.fn(async () => {}),
      armAria2Call: vi.fn(async () => {}),
      bindStarted: vi.fn(async () => {}),
      rejectStart: vi.fn(async () => {}),
      resolveUntrackedStart: vi.fn(async () => {}),
    } as unknown as TransferRegistry
    const download = vi.fn(async () => {
      throw new Error('offline')
    })
    const d = {
      ...deps(),
      settings: async () => ({ ...SETTINGS_DEFAULTS, sidecarMetadata: false }),
      admission: {
        admit: vi.fn(async () => ({ admitted: [item], skipped: [] })),
      },
      registry: () => registry,
      download,
    }

    await Effect.runPromise(makeTransferLaunchCoordinator(d).launch({ items: [item] }))

    expect(registry.armDirectCall).toHaveBeenCalledOnce()
    expect(download).toHaveBeenCalledOnce()
  })

  it('does not call the Direct strategy when its exact Registry arm is stale', async () => {
    const token = { id: item.id, attempt: 0, since: 1 }
    const registry = {
      prepareGroups: vi.fn(async () => ({
        launches: [token],
        duplicateMainIds: [],
      })),
      abandonPrepared: vi.fn(async () => {}),
      releasePreparedStarts: vi.fn(async () => {}),
      armDirectCall: vi.fn(async () => {
        throw new Error('stale launch')
      }),
      armAria2Call: vi.fn(async () => {}),
      bindStarted: vi.fn(async () => {}),
      rejectStart: vi.fn(async () => {}),
      resolveUntrackedStart: vi.fn(async () => {}),
    } as unknown as TransferRegistry
    const download = vi.fn(async () => 7)
    const d = {
      ...deps(),
      settings: async () => ({ ...SETTINGS_DEFAULTS, sidecarMetadata: false }),
      admission: {
        admit: vi.fn(async () => ({ admitted: [item], skipped: [] })),
      },
      registry: () => registry,
      download,
    }

    const result = await Effect.runPromise(
      makeTransferLaunchCoordinator(d).launch({ items: [item] }),
    )

    expect(registry.armDirectCall).toHaveBeenCalledWith(item.id, token)
    expect(download).not.toHaveBeenCalled()
    expect(registry.bindStarted).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      started: [],
      failures: [{ requestId: item.id, reason: 'Error: stale launch' }],
    })
  })

  it('routes a stale browser bind through untracked handle cleanup', async () => {
    const token = { id: item.id, attempt: 0, since: 1 }
    const registry = {
      prepareGroups: vi.fn(async () => ({
        launches: [token],
        duplicateMainIds: [],
      })),
      abandonPrepared: vi.fn(async () => {}),
      releasePreparedStarts: vi.fn(async () => {}),
      armDirectCall: vi.fn(async () => {}),
      armAria2Call: vi.fn(async () => {}),
      bindStarted: vi.fn(async () => {
        throw new Error('stale handle bind')
      }),
      rejectStart: vi.fn(async () => {}),
      resolveUntrackedStart: vi.fn(async () => {}),
    } as unknown as TransferRegistry
    const d = {
      ...deps(),
      settings: async () => ({ ...SETTINGS_DEFAULTS, sidecarMetadata: false }),
      admission: {
        admit: vi.fn(async () => ({ admitted: [item], skipped: [] })),
      },
      registry: () => registry,
      download: vi.fn(async () => 7),
    }

    const result = await Effect.runPromise(
      makeTransferLaunchCoordinator(d).launch({ items: [item] }),
    )

    expect(registry.resolveUntrackedStart).toHaveBeenCalledWith(item.id, token, {
      kind: 'browser',
      id: 7,
    })
    expect(d.monitor.recordStarted).not.toHaveBeenCalled()
    expect(d.clear.bindStarted).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      started: [],
      failures: [{ requestId: item.id, reason: 'stale handle bind' }],
    })
  })

  it('records a bound browser start before a later queued start settles', async () => {
    let releaseSecond!: (id: number) => void
    const second = new Promise<number>((resolve) => {
      releaseSecond = resolve
    })
    const secondItem = {
      ...item,
      id: 'media-2',
      url: 'https://pbs.twimg.com/media/b.jpg',
    }
    const registry = {
      prepareGroups: vi.fn(
        async (
          groups: ReadonlyArray<{
            readonly requests: ReadonlyArray<{ readonly id: string }>
          }>,
        ) => ({
          launches: groups
            .flatMap(({ requests }) => requests)
            .map((request) => ({ id: request.id, attempt: 0, since: 0 })),
          duplicateMainIds: [],
        }),
      ),
      bindStarted: vi.fn(async () => {}),
      abandonPrepared: vi.fn(async () => {}),
      releasePreparedStarts: vi.fn(async () => {}),
      armDirectCall: vi.fn(async () => {}),
      armAria2Call: vi.fn(async () => {}),
      rejectStart: vi.fn(async () => {}),
      resolveUntrackedStart: vi.fn(async () => {}),
    } as unknown as TransferRegistry
    const download = vi
      .fn<(options: { readonly url: string }) => Promise<number>>()
      .mockResolvedValueOnce(1)
      .mockImplementationOnce(() => second)
    const d = {
      ...deps(),
      settings: async () => ({
        ...SETTINGS_DEFAULTS,
        downloadConcurrency: 1,
        sidecarMetadata: false,
      }),
      admission: {
        admit: vi.fn(async () => ({
          admitted: [item, secondItem],
          skipped: [],
        })),
      },
      registry: () => registry,
      download,
    }

    const running = Effect.runPromise(
      makeTransferLaunchCoordinator(d).launch({ items: [item, secondItem] }),
    )
    await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(2))

    expect(d.monitor.recordStarted).toHaveBeenCalledWith('media-1', expect.any(Number))

    releaseSecond(2)
    await running
  })
})

describe('TransferLaunchCoordinator Sweep ownership', () => {
  it('abandons a partial post before any transfer can start', async () => {
    const secondItem = {
      ...item,
      id: 'media-2',
      index: 1,
      url: 'https://pbs.twimg.com/media/b.jpg',
    }
    const registry = {
      prepareGroups: vi.fn(
        async (
          groups: ReadonlyArray<{
            readonly requests: ReadonlyArray<{ readonly id: string }>
          }>,
        ) => ({
          launches: groups
            .flatMap(({ requests }) => requests)
            .map((request) => ({ id: request.id, attempt: 0, since: 0 })),
          duplicateMainIds: [],
        }),
      ),
      abandonPrepared: vi.fn(async () => {}),
      releasePreparedStarts: vi.fn(async () => {}),
    } as unknown as TransferRegistry
    const d = {
      ...deps(),
      admission: {
        admit: vi.fn(async () => ({ admitted: [item], skipped: [] })),
      },
      registry: () => registry,
    }

    await expect(
      Effect.runPromise(
        makeTransferLaunchCoordinator(d).launch({
          items: [item, secondItem],
          sweep: { scope: 'bookmark' },
          sweepReceipts: [
            {
              receiptId: 'sweep-1',
              tweetId: item.postId,
              scope: 'bookmark',
              itemIds: [item.id],
            },
            {
              receiptId: 'sweep-2',
              tweetId: secondItem.postId,
              scope: 'bookmark',
              itemIds: [secondItem.id],
            },
          ],
          clearExpect: [{ tweetId: item.postId, requestIds: [item.id, secondItem.id] }],
        }),
      ),
    ).rejects.toThrow('Sweep could not own every detected media request')

    expect(registry.abandonPrepared).toHaveBeenCalledOnce()
    expect(d.clear.seed).not.toHaveBeenCalled()
    expect(d.download).not.toHaveBeenCalled()
  })

  it('persists Worklist ownership after Clear seed and before transfer start', async () => {
    const order: string[] = []
    const registry = {
      prepareGroups: vi.fn(async () => ({
        launches: [{ id: item.id, attempt: 0, since: 0 }],
        duplicateMainIds: [],
      })),
      abandonPrepared: vi.fn(async () => {}),
      releasePreparedStarts: vi.fn(async () => {
        order.push('permit')
      }),
      bindStarted: vi.fn(async () => {}),
      armDirectCall: vi.fn(async () => {
        order.push('arm')
      }),
      armAria2Call: vi.fn(async () => {}),
      rejectStart: vi.fn(async () => {}),
      resolveUntrackedStart: vi.fn(async () => {}),
    } as unknown as TransferRegistry
    const d = {
      ...deps(),
      settings: async () => ({
        ...SETTINGS_DEFAULTS,
        clearOnSave: true,
        sidecarMetadata: false,
      }),
      admission: {
        admit: vi.fn(async () => ({ admitted: [item], skipped: [] })),
      },
      registry: () => registry,
      cloud: {
        recordCloudUploads: vi.fn(async () => {
          order.push('cloud')
          return { tag: 'not-requested' as const }
        }),
      },
      clear: {
        seed: vi.fn(async () => {
          order.push('seed')
          return {
            trackedByTweet: new Map([[item.postId, new Set([item.id])]]),
            worklistRevision: 1,
          }
        }),
        bindStarted: vi.fn(async () => undefined),
        failUnbound: vi.fn(async () => undefined),
      },
      download: vi.fn(async () => {
        order.push('start')
        return 1
      }),
    }

    await Effect.runPromise(
      makeTransferLaunchCoordinator(d).launch({
        items: [item],
        sweep: { scope: 'bookmark' },
        sweepReceipts: [
          {
            receiptId: 'sweep-1',
            tweetId: item.postId,
            scope: 'bookmark',
            itemIds: [item.id],
          },
        ],
        clearExpect: [{ tweetId: item.postId, requestIds: [item.id] }],
        onClearSeeded: async () => {
          order.push('claim')
        },
      }),
    )

    expect(order).toEqual(['seed', 'claim', 'cloud', 'permit', 'arm', 'start'])
    expect(d.clear.bindStarted).toHaveBeenCalledWith({
      tweetId: item.postId,
      requestId: item.id,
      downloadId: 1,
    })
  })

  it('terminates a Sweep when the seeded handoff loses ownership', async () => {
    const secondItem = {
      ...item,
      id: 'media-2',
      postId: '456',
      url: 'https://pbs.twimg.com/media/b.jpg',
    }
    const launchTokens = [
      { id: item.id, attempt: 0, since: 1 },
      { id: secondItem.id, attempt: 0, since: 1 },
    ]
    const registry = {
      prepareGroups: vi.fn(async () => ({
        launches: launchTokens,
        duplicateMainIds: [],
      })),
      abandonPrepared: vi.fn(async () => {}),
      releasePreparedStarts: vi.fn(async () => {}),
    } as unknown as TransferRegistry
    const d = {
      ...deps(),
      settings: async () => ({
        ...SETTINGS_DEFAULTS,
        clearOnSave: true,
        sidecarMetadata: false,
      }),
      admission: {
        admit: vi.fn(async () => ({ admitted: [item, secondItem], skipped: [] })),
      },
      registry: () => registry,
      clear: {
        seed: vi.fn(async () => ({
          trackedByTweet: new Map([
            [item.postId, new Set([item.id])],
            [secondItem.postId, new Set([secondItem.id])],
          ]),
          worklistRevision: 1,
        })),
        bindStarted: vi.fn(async () => undefined),
        failUnbound: vi.fn(async () => undefined),
      },
    }

    const result = await Effect.runPromise(
      makeTransferLaunchCoordinator(d).launch({
        items: [item, secondItem],
        sweep: { scope: 'bookmark' },
        sweepReceipts: [
          {
            receiptId: 'sweep-1',
            tweetId: item.postId,
            scope: 'bookmark',
            itemIds: [item.id],
          },
          {
            receiptId: 'sweep-2',
            tweetId: secondItem.postId,
            scope: 'bookmark',
            itemIds: [secondItem.id],
          },
        ],
        clearExpect: [
          { tweetId: item.postId, requestIds: [item.id] },
          { tweetId: secondItem.postId, requestIds: [secondItem.id] },
        ],
        onClearSeeded: async () => ({
          tag: 'terminal-skip',
          reason: 'authoritative-worklist-terminal',
        }),
      }),
    )

    expect(d.clear.failUnbound).toHaveBeenCalledTimes(2)
    expect(d.clear.failUnbound).toHaveBeenCalledWith({
      tweetId: item.postId,
      requestId: item.id,
    })
    expect(d.clear.failUnbound).toHaveBeenCalledWith({
      tweetId: secondItem.postId,
      requestId: secondItem.id,
    })
    expect(registry.abandonPrepared).toHaveBeenCalledWith(launchTokens)
    expect(registry.releasePreparedStarts).not.toHaveBeenCalled()
    expect(d.cloud.recordCloudUploads).not.toHaveBeenCalled()
    expect(d.monitor.beginBatch).not.toHaveBeenCalled()
    expect(d.monitor.recordStarted).not.toHaveBeenCalled()
    expect(d.monitor.bindBrowserTransfer).not.toHaveBeenCalled()
    expect(d.download).not.toHaveBeenCalled()
    expect(result).toEqual({
      _tag: 'QueueUpdate',
      planned: [item.id, secondItem.id],
      started: [],
      deferred: [],
      duplicates: [],
      failures: [
        { requestId: item.id, reason: 'clear-terminal-authoritative-worklist-terminal' },
        { requestId: secondItem.id, reason: 'clear-terminal-authoritative-worklist-terminal' },
      ],
      skipped: [],
    })
  })

  it('never starts a manual Sweep when Clear is disabled', async () => {
    const registry = {
      prepareGroups: vi.fn(async () => ({
        launches: [{ id: item.id, attempt: 0, since: 0 }],
        duplicateMainIds: [],
      })),
      abandonPrepared: vi.fn(async () => {}),
      releasePreparedStarts: vi.fn(async () => {}),
    } as unknown as TransferRegistry
    const d = {
      ...deps(),
      settings: async () => ({
        ...SETTINGS_DEFAULTS,
        clearOnSave: false,
        sidecarMetadata: false,
      }),
      admission: {
        admit: vi.fn(async () => ({ admitted: [item], skipped: [] })),
      },
      registry: () => registry,
    }

    const result = await Effect.runPromise(
      makeTransferLaunchCoordinator(d).launch({
        items: [item],
        sweep: { scope: 'bookmark' },
        sweepReceipts: [
          {
            receiptId: 'sweep-1',
            tweetId: item.postId,
            scope: 'bookmark',
            itemIds: [item.id],
          },
        ],
        clearExpect: [{ tweetId: item.postId, requestIds: [item.id] }],
      }),
    )

    expect(result).toMatchObject({
      planned: [item.id],
      started: [],
      failures: [{ requestId: item.id, reason: 'clear-clear-off' }],
    })
    expect(decodeQueueUpdate(result, [item])).toEqual(result)
    expect(registry.abandonPrepared).toHaveBeenCalledOnce()
    expect(d.download).not.toHaveBeenCalled()
  })

  it('preserves seeded Clear and Registry ownership when Worklist persistence fails', async () => {
    const registry = {
      prepareGroups: vi.fn(async () => ({
        launches: [{ id: item.id, attempt: 0, since: 0 }],
        duplicateMainIds: [],
      })),
      abandonPrepared: vi.fn(async () => {}),
      releasePreparedStarts: vi.fn(async () => {}),
    } as unknown as TransferRegistry
    const d = {
      ...deps(),
      settings: async () => ({
        ...SETTINGS_DEFAULTS,
        clearOnSave: true,
        sidecarMetadata: false,
      }),
      admission: {
        admit: vi.fn(async () => ({ admitted: [item], skipped: [] })),
      },
      registry: () => registry,
      clear: {
        seed: vi.fn(async () => ({
          trackedByTweet: new Map([[item.postId, new Set([item.id])]]),
          worklistRevision: 1,
        })),
        bindStarted: vi.fn(async () => undefined),
        failUnbound: vi.fn(async () => undefined),
      },
    }

    await expect(
      Effect.runPromise(
        makeTransferLaunchCoordinator(d).launch({
          items: [item],
          sweep: { scope: 'bookmark' },
          sweepReceipts: [
            {
              receiptId: 'sweep-1',
              tweetId: item.postId,
              scope: 'bookmark',
              itemIds: [item.id],
            },
          ],
          clearExpect: [{ tweetId: item.postId, requestIds: [item.id] }],
          onClearSeeded: async () => {
            throw new Error('worklist write failed')
          },
        }),
      ),
    ).rejects.toThrow('worklist write failed')
    expect(d.clear.failUnbound).not.toHaveBeenCalled()
    expect(registry.abandonPrepared).not.toHaveBeenCalled()
    expect(d.download).not.toHaveBeenCalled()
  })
})
