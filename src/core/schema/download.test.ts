import { describe, expect, it } from 'vitest'
import {
  MAX_TRACE_EVENTS,
  decodeClearDownloadMonitorResponse,
  decodeDownloadRequest,
  decodeDownloadTraceEvent,
  decodeMetricsSnapshot,
  decodeQueueUpdate,
  decodeRefreshMediaUrlRequest,
  decodeRefreshMediaUrlResponse,
  decodeSweepEnqueueRequest,
  decodeSweepEnqueueResponse,
  decodeTransferOutcome,
} from './download'
import { decodeMediaItem, MAX_MEDIA_URL_LENGTH } from './media'
import { MAX_DOWNLOAD_ITEMS_PER_REQUEST } from '../wire/limits'

const item = (over: Record<string, unknown> = {}) => ({
  id: 'media-1',
  platform: 'x' as const,
  postId: '123',
  author: 'alice',
  type: 'photo' as const,
  url: 'https://pbs.twimg.com/media/a.jpg',
  ext: 'jpg',
  index: 0,
  ...over,
})

describe('media wire', () => {
  it('accepts only exact, bounded HTTPS media', () => {
    expect(decodeMediaItem(item())).toEqual(item())
    expect(decodeMediaItem({ ...item(), extra: true })).toBeUndefined()
    expect(decodeMediaItem(item({ url: 'http://pbs.twimg.com/media/a.jpg' }))).toBeUndefined()
    expect(
      decodeMediaItem(
        item({
          url: `https://cdn.example/${'a'.repeat(8_150)}`,
          previewUrl: `https://cdn.example/${'b'.repeat(8_150)}`,
        }),
      ),
    ).toBeUndefined()
  })
})

describe('DownloadRequest wire', () => {
  it('allows a partial grab to name the post’s full detected media set', () => {
    const request = {
      _tag: 'DownloadRequest',
      items: [item()],
      clearExpect: [
        {
          tweetId: '123',
          requestIds: ['media-1', 'not-sent-yet-1', 'not-sent-yet-2'],
        },
      ],
    }
    expect(decodeDownloadRequest(request)).toEqual(request)
  })

  it.each([
    ['duplicate item', { _tag: 'DownloadRequest', items: [item(), item()] }],
    [
      'non-X clear expectation',
      {
        _tag: 'DownloadRequest',
        items: [item({ platform: 'instagram', postId: '123' })],
        clearExpect: [{ tweetId: '123', requestIds: ['media-1'] }],
      },
    ],
    [
      'foreign expected post',
      {
        _tag: 'DownloadRequest',
        items: [item()],
        clearExpect: [{ tweetId: '999', requestIds: ['not-this-post'] }],
      },
    ],
    ['extra nested media key', { _tag: 'DownloadRequest', items: [{ ...item(), attacker: true }] }],
  ])('rejects %s', (_name, request) => expect(decodeDownloadRequest(request)).toBeUndefined())

  it('caps items before work starts', () => {
    const items = Array.from({ length: MAX_DOWNLOAD_ITEMS_PER_REQUEST + 1 }, (_, index) =>
      item({ id: `media-${index}` }),
    )
    expect(decodeDownloadRequest({ _tag: 'DownloadRequest', items })).toBeUndefined()
  })

  it('allows equal adapter-local keys when global identities differ', () => {
    const request = {
      _tag: 'DownloadRequest',
      items: [
        item({ id: 'shared', platform: 'x', postId: '1' }),
        item({ id: 'shared', platform: 'instagram', postId: '2' }),
      ],
    }

    expect(decodeDownloadRequest(request)).toEqual(request)
  })
})

describe('download replies and monitor wire', () => {
  const requested = [item(), item({ id: 'media-2', index: 1 })]

  it('requires QueueUpdate to account for every requested media and planned artifact', () => {
    expect(
      decodeQueueUpdate(
        {
          _tag: 'QueueUpdate',
          planned: ['media-1'],
          started: ['media-1'],
          deferred: [],
          duplicates: [],
          failures: [],
          skipped: [{ requestId: 'media-2', reason: 'unsafe-url' }],
        },
        requested,
      ),
    ).toMatchObject({ started: ['media-1'] })
    expect(
      decodeQueueUpdate(
        {
          _tag: 'QueueUpdate',
          planned: ['media-1', 'media-2'],
          started: ['media-1'],
          deferred: [],
          duplicates: [],
          failures: [],
          skipped: [],
        },
        requested,
      ),
    ).toBeUndefined()
    expect(
      decodeQueueUpdate(
        {
          _tag: 'QueueUpdate',
          planned: ['media-1', 'media-2'],
          started: [],
          deferred: [],
          duplicates: [],
          failures: [
            { requestId: 'media-1', reason: 'a' },
            { requestId: 'media-1', reason: 'b' },
          ],
          skipped: [],
        },
        requested,
      ),
    ).toBeUndefined()
  })

  it('accepts durable deferred artifacts but keeps outcomes and media decisions disjoint', () => {
    expect(
      decodeQueueUpdate(
        {
          _tag: 'QueueUpdate',
          planned: ['media-1', 'media-2'],
          started: ['media-1'],
          deferred: ['media-2'],
          duplicates: [],
          failures: [],
          skipped: [],
        },
        requested,
      ),
    ).toMatchObject({ deferred: ['media-2'] })
    expect(
      decodeQueueUpdate(
        {
          _tag: 'QueueUpdate',
          planned: ['media-1', 'media-2'],
          started: ['media-1'],
          deferred: ['media-2'],
          duplicates: [],
          failures: [{ requestId: 'media-2', reason: 'refused' }],
          skipped: [],
        },
        requested,
      ),
    ).toBeUndefined()
  })

  it('rejects a foreign, orphan sidecar, or nonexclusive main decision', () => {
    const reply = {
      _tag: 'QueueUpdate' as const,
      planned: ['media-1'],
      started: ['media-1'],
      deferred: [],
      duplicates: ['media-2'],
      failures: [],
      skipped: [],
    }
    expect(decodeQueueUpdate({ ...reply, planned: ['not-requested'] }, requested)).toBeUndefined()
    expect(
      decodeQueueUpdate(
        {
          ...reply,
          planned: ['xmd:v1:sidecar:x:7:media-1'],
          started: ['xmd:v1:sidecar:x:7:media-1'],
        },
        requested,
      ),
    ).toBeUndefined()
    expect(
      decodeQueueUpdate(
        { ...reply, skipped: [{ requestId: 'media-2', reason: 'duplicate' }] },
        requested,
      ),
    ).toBeUndefined()
  })

  it('binds reply IDs to global, not adapter-local, media identity', () => {
    const crossPlatform = [
      item({ id: 'same', platform: 'x' }),
      item({ id: 'same', platform: 'instagram', index: 1 }),
    ]
    expect(
      decodeQueueUpdate(
        {
          _tag: 'QueueUpdate',
          planned: ['same', 'xmd:v1:media:instagram:4:same'],
          started: ['same', 'xmd:v1:media:instagram:4:same'],
          deferred: [],
          duplicates: [],
          failures: [],
          skipped: [],
        },
        crossPlatform,
      ),
    ).toBeDefined()
    expect(
      decodeQueueUpdate(
        {
          _tag: 'QueueUpdate',
          planned: ['same'],
          started: ['same'],
          deferred: [],
          duplicates: ['same'],
          failures: [],
          skipped: [],
        },
        crossPlatform,
      ),
    ).toBeUndefined()
  })

  it('caps and coheres metrics snapshots', () => {
    const snapshot = {
      total: 3,
      completed: 1,
      failed: 1,
      active: 1,
      retries: 0,
      concurrencyCap: 3,
      bytesReceived: 1,
      bytesTotal: 2,
      throughputBps: 1,
      elapsedMs: 1,
      events: Array.from({ length: MAX_TRACE_EVENTS }, (_, index) => ({
        source: 'background',
        stage: `s${index}`,
        t: index,
      })),
    }
    expect(decodeMetricsSnapshot(snapshot)).toEqual(snapshot)
    expect(decodeMetricsSnapshot({ ...snapshot, active: 2 })).toBeUndefined()
    expect(
      decodeMetricsSnapshot({
        ...snapshot,
        events: [...snapshot.events, { source: 'background', stage: 'extra', t: 13 }],
      }),
    ).toBeUndefined()
  })

  it('rejects trace accessors and oversized details before schema decode', () => {
    const accessor = {
      _tag: 'DownloadTraceEvent',
      source: 'badge',
      stage: 'tap',
      t: 1,
    }
    Object.defineProperty(accessor, 'detail', {
      enumerable: true,
      get: () => 'never',
    })
    expect(decodeDownloadTraceEvent(accessor)).toBeUndefined()
    expect(
      decodeDownloadTraceEvent({
        _tag: 'DownloadTraceEvent',
        source: 'badge',
        stage: 'tap',
        t: 1,
        detail: 'x'.repeat(1_025),
      }),
    ).toBeUndefined()
  })

  it('accepts bounded monitor reset replies only', () => {
    expect(
      decodeClearDownloadMonitorResponse({
        _tag: 'ClearDownloadMonitorResponse',
        ok: true,
        active: 0,
        clearedMetrics: true,
        clearedLocks: 0,
      }),
    ).toMatchObject({ ok: true })
    expect(
      decodeClearDownloadMonitorResponse({
        _tag: 'ClearDownloadMonitorResponse',
        ok: true,
        active: -1,
        clearedMetrics: true,
        clearedLocks: 0,
      }),
    ).toBeUndefined()
  })
})

describe('sweep and tab download wire', () => {
  it('accepts bounded, one-to-one X sweep posts', () => {
    const request = {
      _tag: 'SweepEnqueueRequest',
      scope: 'bookmark',
      posts: [{ tweetId: '123', items: [item()] }],
    }
    expect(decodeSweepEnqueueRequest(request)).toEqual(request)
    expect(
      decodeSweepEnqueueResponse({ _tag: 'SweepEnqueueResponse', queued: 1, skipped: 0 }, 1),
    ).toEqual({
      _tag: 'SweepEnqueueResponse',
      queued: 1,
      skipped: 0,
    })
  })

  it.each([
    [
      'item post mismatch',
      {
        _tag: 'SweepEnqueueRequest',
        scope: 'bookmark',
        posts: [{ tweetId: '123', items: [item({ postId: '124' })] }],
      },
    ],
    [
      'non-X item',
      {
        _tag: 'SweepEnqueueRequest',
        scope: 'bookmark',
        posts: [{ tweetId: '123', items: [item({ platform: 'threads' })] }],
      },
    ],
    [
      'duplicate post',
      {
        _tag: 'SweepEnqueueRequest',
        scope: 'bookmark',
        posts: [
          { tweetId: '123', items: [item()] },
          { tweetId: '123', items: [item({ id: 'media-2' })] },
        ],
      },
    ],
  ])('rejects sweep %s', (_name, request) =>
    expect(decodeSweepEnqueueRequest(request)).toBeUndefined(),
  )

  it('rejects reply counts beyond its sent post batch', () => {
    expect(
      decodeSweepEnqueueResponse({ _tag: 'SweepEnqueueResponse', queued: 1, skipped: 1 }, 1),
    ).toBeUndefined()
  })

  it('uses exact bounded refresh and outcome messages', () => {
    expect(
      decodeRefreshMediaUrlRequest({
        _tag: 'RefreshMediaUrlRequest',
        itemId: 'media-1',
        tweetId: '123',
        index: 0,
        type: 'photo',
      }),
    ).toMatchObject({ tweetId: '123' })
    expect(
      decodeRefreshMediaUrlResponse({
        _tag: 'RefreshMediaUrlResponse',
        url: 'http://unsafe.example/a.jpg',
      }),
    ).toBeUndefined()
    expect(
      decodeTransferOutcome({
        _tag: 'TransferOutcome',
        requestId: 'media-1',
        outcome: 'complete',
        at: 1,
      }),
    ).toMatchObject({ outcome: 'complete' })
  })

  it('accepts the longest valid refreshed Media URL', () => {
    const prefix = 'https://pbs.twimg.com/media/'
    const url = `${prefix}${'x'.repeat(MAX_MEDIA_URL_LENGTH - prefix.length)}`

    expect(
      decodeRefreshMediaUrlResponse({
        _tag: 'RefreshMediaUrlResponse',
        url,
      }),
    ).toEqual({ _tag: 'RefreshMediaUrlResponse', url })
    expect(
      decodeRefreshMediaUrlResponse({
        _tag: 'RefreshMediaUrlResponse',
        url: `${url}x`,
      }),
    ).toBeUndefined()
  })
})
