import { describe, expect, it, vi } from 'vitest'
import type { HistoryAction } from '../core/history/action'
import { applyOutcome, recordFromMediaItem } from '../core/history/record'
import { emptyStore, type DownloadStore } from '../core/history/store'
import { makeSavedIndex } from '../core/sync/saved-index'
import type { MediaItem } from '../core/schema'
import {
  makeDownloadHistory,
  type DownloadHistory,
  type DownloadHistoryStorage,
} from './download-history'
import { makeDownloadHistoryProjection } from './download-history-projection'

type RecordHistory = DownloadHistory['record']
type ListHistory = DownloadHistory['list']
type ListCompletedHistory = DownloadHistory['listCompleted']
type EraseHistory = DownloadHistory['erase']

const item: MediaItem = {
  id: 'media-1',
  platform: 'x',
  postId: 'post-1',
  author: 'alice',
  type: 'photo',
  url: 'https://pbs.twimg.com/media/media-1.jpg',
  ext: 'jpg',
  index: 0,
}

const completedActions = (
  media: MediaItem,
  queuedAt: number,
  finishedAt: number,
): ReadonlyArray<HistoryAction> => [
  {
    kind: 'queued',
    recordingEnabled: true,
    requestId: media.id,
    item: media,
    filename: `${media.author}.jpg`,
    at: queuedAt,
  },
  { kind: 'completed', requestId: media.id, at: finishedAt },
]

const historyWith = (overrides: Partial<DownloadHistory> = {}): DownloadHistory => {
  const defaults: DownloadHistory = {
    record: vi.fn<RecordHistory>(async () => 'applied'),
    list: vi.fn<ListHistory>(async () => []),
    listCompleted: vi.fn<ListCompletedHistory>(async () => []),
    erase: vi.fn<EraseHistory>(async () => {}),
  }
  return { ...defaults, ...overrides }
}

describe('makeDownloadHistoryProjection', () => {
  it('replaces both indexes from durable completed history', async () => {
    const savedPosts = makeSavedIndex()
    const savedRequests = makeSavedIndex()
    savedPosts.seed(['stale-post'])
    savedRequests.seed(['stale-request'])
    const completed = {
      ...applyOutcome(recordFromMediaItem(item, 'alice.jpg', 1), 'completed', 2),
      status: 'completed' as const,
    }
    const history = historyWith({
      listCompleted: vi.fn<ListCompletedHistory>(async () => [completed]),
    })
    const owner = makeDownloadHistoryProjection({
      history,
      savedPosts,
      savedRequests,
      requestIdFor: () => 'request-1',
      pendingTerminalProjectionIds: async () => [],
    })

    await owner.seed()

    expect(savedPosts.known(['stale-post', 'post-1'])).toEqual(['post-1'])
    expect(savedRequests.known(['stale-request', completed.requestId])).toEqual([
      completed.requestId,
    ])
  })

  it('orders terminal completion before a later erase', async () => {
    const order: string[] = []
    let releaseRecord!: () => void
    const history = historyWith({
      record: vi.fn<RecordHistory>(
        () =>
          new Promise<'applied'>((resolve) => {
            releaseRecord = () => {
              order.push('record')
              resolve('applied')
            }
          }),
      ),
      erase: vi.fn<EraseHistory>(async () => {
        order.push('erase')
      }),
    })
    const savedPosts = makeSavedIndex()
    const savedRequests = makeSavedIndex()
    const owner = makeDownloadHistoryProjection({
      history,
      savedPosts,
      savedRequests,
      requestIdFor: () => 'request-1',
      pendingTerminalProjectionIds: async () => ['projection-1'],
    })

    const completion = owner.projectTerminal({
      projectionId: 'projection-1',
      actions: [],
      completedItem: item,
    })
    const erase = owner.erase()
    await vi.waitFor(() => expect(history.record).toHaveBeenCalledOnce())
    releaseRecord()
    await Promise.all([completion, erase])

    expect(order).toEqual(['record', 'erase'])
    expect(history.erase).toHaveBeenCalledWith(['projection-1'])
    expect(savedPosts.known(['post-1'])).toEqual([])
    expect(savedRequests.known(['request-1'])).toEqual([])
  })

  it('keeps a terminal completion that begins after erase', async () => {
    const savedPosts = makeSavedIndex()
    const savedRequests = makeSavedIndex()
    savedPosts.seed(['old'])
    const owner = makeDownloadHistoryProjection({
      history: historyWith(),
      savedPosts,
      savedRequests,
      requestIdFor: () => 'request-1',
      pendingTerminalProjectionIds: async () => [],
    })

    await Promise.all([
      owner.erase(),
      owner.projectTerminal({
        projectionId: 'projection-1',
        actions: [],
        completedItem: item,
      }),
    ])

    expect(savedPosts.known(['old', 'post-1'])).toEqual(['post-1'])
    expect(savedRequests.known(['request-1'])).toEqual(['request-1'])
  })

  it('persists the Registry identity fence across restart without trusting wall time', async () => {
    let durable: DownloadStore = emptyStore
    const storage: DownloadHistoryStorage = {
      get: async () => durable,
      set: async (next) => {
        durable = next
      },
    }
    const firstSavedPosts = makeSavedIndex()
    const firstSavedRequests = makeSavedIndex()
    const first = makeDownloadHistoryProjection({
      history: makeDownloadHistory({ storage }),
      savedPosts: firstSavedPosts,
      savedRequests: firstSavedRequests,
      requestIdFor: () => item.id,
      pendingTerminalProjectionIds: async () => ['projection-before-reset'],
    })

    await first.projectTerminal({
      projectionId: 'projection-before-reset',
      actions: completedActions(item, 5_000, 6_000),
      completedItem: item,
    })
    await first.erase()
    expect(firstSavedPosts.known([item.postId])).toEqual([])
    expect(firstSavedRequests.known([item.id])).toEqual([])

    const restartedSavedPosts = makeSavedIndex()
    const restartedSavedRequests = makeSavedIndex()
    const restarted = makeDownloadHistoryProjection({
      history: makeDownloadHistory({ storage }),
      savedPosts: restartedSavedPosts,
      savedRequests: restartedSavedRequests,
      requestIdFor: () => item.id,
      pendingTerminalProjectionIds: async () => [],
    })
    await restarted.projectTerminal({
      projectionId: 'projection-before-reset',
      actions: completedActions(item, 1, 2),
      completedItem: item,
    })

    expect(await restarted.list()).toEqual([])
    expect(restartedSavedPosts.known([item.postId])).toEqual([])
    expect(restartedSavedRequests.known([item.id])).toEqual([])

    await restarted.projectTerminal({
      projectionId: 'projection-after-reset',
      actions: completedActions(item, 0, 1),
      completedItem: item,
    })
    expect(await restarted.list()).toMatchObject([{ requestId: item.id, status: 'completed' }])
    expect(restartedSavedPosts.known([item.postId])).toEqual([item.postId])
    expect(restartedSavedRequests.known([item.id])).toEqual([item.id])
  })

  it('fences a late pre-clear replay but admits a terminal created after the snapshot', async () => {
    let durable: DownloadStore = emptyStore
    const storage: DownloadHistoryStorage = {
      get: async () => durable,
      set: async (next) => {
        durable = next
      },
    }
    let markSnapshotTaken!: () => void
    let releaseSnapshot!: () => void
    const snapshotTaken = new Promise<void>((resolve) => {
      markSnapshotTaken = resolve
    })
    const snapshotReleased = new Promise<void>((resolve) => {
      releaseSnapshot = resolve
    })
    const savedPosts = makeSavedIndex()
    const savedRequests = makeSavedIndex()
    const owner = makeDownloadHistoryProjection({
      history: makeDownloadHistory({ storage }),
      savedPosts,
      savedRequests,
      requestIdFor: (media) => media.id,
      pendingTerminalProjectionIds: async () => {
        markSnapshotTaken()
        await snapshotReleased
        return ['projection-before-reset']
      },
    })
    const postSnapshotItem: MediaItem = {
      ...item,
      id: 'media-after',
      postId: 'post-after',
    }

    const clear = owner.erase()
    await snapshotTaken
    const latePreClearReplay = owner.projectTerminal({
      projectionId: 'projection-before-reset',
      actions: completedActions(item, 100, 110),
      completedItem: item,
    })
    const postSnapshotTerminal = owner.projectTerminal({
      projectionId: 'projection-after-reset',
      actions: completedActions(postSnapshotItem, 1, 2),
      completedItem: postSnapshotItem,
    })
    releaseSnapshot()
    await Promise.all([clear, latePreClearReplay, postSnapshotTerminal])

    expect(await owner.list()).toMatchObject([
      { requestId: postSnapshotItem.id, status: 'completed' },
    ])
    expect(savedPosts.known([item.postId, postSnapshotItem.postId])).toEqual([
      postSnapshotItem.postId,
    ])
    expect(savedRequests.known([item.id, postSnapshotItem.id])).toEqual([postSnapshotItem.id])
  })
})
