import { describe, expect, it, vi } from 'vitest'
import type { TweetRecord } from '../../core/capture/record'
import type { CaptureTweetsResult } from '../../core/schema'
import { makeCaptureBuffer } from './capture-buffer'
import { makeCaptureEpochRefresh } from './capture-epoch-refresh'

const EPOCH_0 = 'capture:0'
const EPOCH_1 = 'capture:1'

const record = (tweetId: string): TweetRecord => ({
  tweetId,
  conversationId: tweetId,
  author: { handle: 'alice' },
  text: 'text',
  rawText: 'text',
  links: [],
  media: [],
  mentions: [],
  hashtags: [],
  source: 'timeline',
  sourceRank: 1,
  capturedAt: 1,
})

const clock = () => {
  const tasks: Array<{ cancelled: boolean; task: () => void }> = []
  return {
    after: vi.fn<(ms: number, task: () => void) => () => void>((_ms, task) => {
      const scheduled = { cancelled: false, task }
      tasks.push(scheduled)
      return () => {
        scheduled.cancelled = true
      }
    }),
    run: () => {
      const scheduled = tasks.shift()
      if (scheduled !== undefined && !scheduled.cancelled) scheduled.task()
    },
  }
}

describe('CaptureEpochRefresh', () => {
  it('recovers a held post-Clear batch after one transient pull failure', async () => {
    const bufferClock = clock()
    const refreshClock = clock()
    const send = vi.fn<
      (
        records: ReadonlyArray<TweetRecord>,
        epoch: string,
      ) => Promise<CaptureTweetsResult | undefined>
    >(async (records, epoch) => ({
      _tag: 'CaptureStored',
      epoch,
      stored: records.length,
      mirror: 'not-requested',
    }))
    const buffer = makeCaptureBuffer({
      epoch: EPOCH_0,
      send,
      clock: bufferClock,
      maxBatch: 2,
      maxPending: 8,
      debounceMs: 1,
      retryBaseMs: 2,
      retryMaxMs: 8,
    })
    const read = vi.fn<() => Promise<string | undefined>>()
    read.mockResolvedValueOnce(undefined).mockResolvedValueOnce(EPOCH_1)
    const accept = vi.fn<(epoch: string) => void>(buffer.advanceEpoch)
    const refresh = makeCaptureEpochRefresh({
      read,
      beforeRefresh: buffer.invalidateEpoch,
      accept,
      clock: refreshClock,
      retryBaseMs: 10,
      retryMaxMs: 40,
    })

    await refresh.refresh()
    buffer.enqueue([record('1')])
    buffer.flush()
    expect(send).not.toHaveBeenCalled()

    refreshClock.run()
    await vi.waitFor(() => expect(accept).toHaveBeenCalledWith(EPOCH_1))
    buffer.flush()
    await vi.waitFor(() => expect(buffer.pending).toBe(0))
    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith([record('1')], EPOCH_1)
  })

  it('coalesces overlapping wakes and ignores the superseded reply', async () => {
    let resolveFirst!: (epoch: string) => void
    let active = 0
    let maxActive = 0
    const first = new Promise<string>((resolve) => {
      resolveFirst = resolve
    })
    const read = vi
      .fn<() => Promise<string | undefined>>()
      .mockImplementationOnce(async () => {
        active++
        maxActive = Math.max(maxActive, active)
        const epoch = await first
        active--
        return epoch
      })
      .mockImplementationOnce(async () => {
        active++
        maxActive = Math.max(maxActive, active)
        active--
        return EPOCH_1
      })
    const accept = vi.fn<(epoch: string) => void>()
    const refresh = makeCaptureEpochRefresh({
      read,
      beforeRefresh: vi.fn<() => void>(),
      accept,
      clock: clock(),
      retryBaseMs: 10,
      retryMaxMs: 40,
    })

    const firstWake = refresh.refresh()
    const secondWake = refresh.refresh()
    expect(read).toHaveBeenCalledOnce()
    resolveFirst(EPOCH_0)
    await Promise.all([firstWake, secondWake])

    expect(read).toHaveBeenCalledTimes(2)
    expect(maxActive).toBe(1)
    expect(accept).toHaveBeenCalledOnce()
    expect(accept).toHaveBeenCalledWith(EPOCH_1)
  })

  it('lets a later wake supersede its delayed retry', async () => {
    const retryClock = clock()
    const read = vi
      .fn<() => Promise<string | undefined>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(EPOCH_1)
    const accept = vi.fn<(epoch: string) => void>()
    const refresh = makeCaptureEpochRefresh({
      read,
      beforeRefresh: vi.fn<() => void>(),
      accept,
      clock: retryClock,
      retryBaseMs: 10,
      retryMaxMs: 40,
    })

    await refresh.refresh()
    await refresh.refresh()
    retryClock.run()

    expect(read).toHaveBeenCalledTimes(2)
    expect(accept).toHaveBeenCalledWith(EPOCH_1)
  })

  it('caps repeated retry delay', async () => {
    const retryClock = clock()
    const refresh = makeCaptureEpochRefresh({
      read: async () => undefined,
      beforeRefresh: vi.fn<() => void>(),
      accept: vi.fn<(epoch: string) => void>(),
      clock: retryClock,
      retryBaseMs: 10,
      retryMaxMs: 20,
    })

    await refresh.refresh()
    retryClock.run()
    await vi.waitFor(() => expect(retryClock.after).toHaveBeenCalledTimes(2))
    retryClock.run()
    await vi.waitFor(() => expect(retryClock.after).toHaveBeenCalledTimes(3))

    expect(retryClock.after.mock.calls.map(([delay]) => delay)).toEqual([10, 20, 20])
    refresh.stop()
  })

  it('cancels a delayed retry when its content context stops', async () => {
    const retryClock = clock()
    const read = vi.fn<() => Promise<string | undefined>>(async () => undefined)
    const accept = vi.fn<(epoch: string) => void>()
    const refresh = makeCaptureEpochRefresh({
      read,
      beforeRefresh: vi.fn<() => void>(),
      accept,
      clock: retryClock,
      retryBaseMs: 10,
      retryMaxMs: 40,
    })

    await refresh.refresh()
    refresh.stop()
    retryClock.run()

    expect(read).toHaveBeenCalledOnce()
    expect(accept).not.toHaveBeenCalled()
  })
})
