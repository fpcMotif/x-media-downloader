import { describe, expect, it, vi } from 'vitest'
import type { MediaItem } from '../core/schema'
import type { HistoryAction } from '../core/history/action'
import { applyOutcome, recordFromMediaItem } from '../core/history/record'
import { queuedEvent } from '../core/sync/events'
import { DOWNLOAD_STORE_VERSION, emptyStore, type DownloadStore } from '../core/history/store'
import {
  makeDownloadHistory,
  type DownloadHistory,
  type DownloadHistoryStorage,
} from './download-history'

const item: MediaItem = {
  id: 'media-a',
  platform: 'x',
  postId: 'post-a',
  author: 'alice',
  type: 'photo',
  url: 'https://pbs.twimg.com/media/media-a?format=jpg&name=orig',
  ext: 'jpg',
  index: 0,
}

const queued = (id = item.id): Extract<HistoryAction, { readonly kind: 'queued' }> => ({
  kind: 'queued',
  recordingEnabled: true,
  requestId: id,
  item: { ...item, id },
  filename: `${id}.jpg`,
  at: 100,
})

const terminal = (requestId: string, at: number): HistoryAction => ({
  kind: 'completed',
  requestId,
  at,
})

const terminalActions = (
  id: string,
  queuedAt: number,
  finishedAt: number,
): ReadonlyArray<HistoryAction> => [{ ...queued(id), at: queuedAt }, terminal(id, finishedAt)]

const recordProjection = (
  history: DownloadHistory,
  actions: ReadonlyArray<HistoryAction>,
  projectionId = 'history-test-projection',
) => history.record({ projectionId, actions })

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function memoryStorage(initial: unknown = emptyStore): DownloadHistoryStorage & {
  readonly reads: () => number
  readonly writes: () => number
} {
  let value = initial
  let readCount = 0
  let writeCount = 0
  return {
    get: async () => {
      readCount += 1
      return value
    },
    set: async (next) => {
      writeCount += 1
      value = next
    },
    reads: () => readCount,
    writes: () => writeCount,
  }
}

describe('DownloadHistory', () => {
  it('orders erase after an admitted record so the record cannot resurrect', async () => {
    let value: unknown = emptyStore
    let reads = 0
    const readStarted = deferred()
    const releaseRead = deferred()
    const storage: DownloadHistoryStorage = {
      get: async () => {
        const snapshot = value
        reads += 1
        if (reads === 1) {
          readStarted.resolve()
          await releaseRead.promise
        }
        return snapshot
      },
      set: async (next) => {
        value = next
      },
    }
    const history = makeDownloadHistory({ storage })

    const recorded = recordProjection(history, [queued()])
    await readStarted.promise
    const erased = history.erase([])
    releaseRead.resolve()

    await Promise.all([recorded, erased])
    expect(await history.list()).toEqual([])
  })

  it('makes reads wait for earlier fire-and-forget records', async () => {
    let value: DownloadStore = emptyStore
    const releaseWrite = deferred()
    const writeStarted = deferred()
    const storage: DownloadHistoryStorage = {
      get: async () => value,
      set: async (next) => {
        writeStarted.resolve()
        await releaseWrite.promise
        value = next
      },
    }
    const history = makeDownloadHistory({ storage })

    const recorded = recordProjection(history, [queued()])
    await writeStarted.promise
    const records = history.list()
    releaseWrite.resolve()

    await expect(records).resolves.toMatchObject([{ requestId: item.id }])
    await recorded
  })

  it('blocks only new queued admissions after opt-out', async () => {
    const history = makeDownloadHistory({ storage: memoryStorage() })

    await recordProjection(history, [queued()])
    await recordProjection(history, [
      { ...queued('blocked'), recordingEnabled: false },
      {
        kind: 'completed',
        requestId: item.id,
        at: 3,
        bytes: { received: 5, total: 5 },
      },
    ])

    expect(await history.list()).toMatchObject([
      { requestId: item.id, status: 'completed', bytesReceived: 5, bytesTotal: 5 },
    ])
  })

  it('projects completed records only for backfill callers', async () => {
    const history = makeDownloadHistory({ storage: memoryStorage() })
    await recordProjection(history, [queued('done'), queued('queued'), queued('failed')])
    await recordProjection(history, [
      { kind: 'completed', requestId: 'done', at: 2 },
      { kind: 'failed', requestId: 'failed', at: 2 },
    ])

    expect((await history.listCompleted()).map((record) => record.requestId)).toEqual(['done'])
  })

  it('persists legacy migration before exposing completed rows', async () => {
    const instagramItem = { ...item, id: 'shared', platform: 'instagram' as const }
    const current = applyOutcome(
      recordFromMediaItem(instagramItem, 'shared.jpg', 100),
      'completed',
      200,
    )
    const { mediaKey: _mediaKey, ...legacy } = current
    let value: unknown = { records: [{ ...legacy, requestId: 'shared' }] }
    const writeStarted = deferred()
    const releaseWrite = deferred()
    const storage: DownloadHistoryStorage = {
      get: async () => value,
      set: async (next) => {
        expect(next).toMatchObject({
          version: DOWNLOAD_STORE_VERSION,
          records: [
            {
              mediaKey: 'shared',
              requestId: 'xmd:v1:media:instagram:6:shared',
            },
          ],
        })
        writeStarted.resolve()
        await releaseWrite.promise
        value = next
      },
    }
    const history = makeDownloadHistory({ storage })

    let resolved = false
    const listed = history.listCompleted().then((records) => {
      resolved = true
      return records
    })
    await writeStarted.promise
    await Promise.resolve()
    expect(resolved).toBe(false)
    releaseWrite.resolve()

    await expect(listed).resolves.toMatchObject([
      {
        mediaKey: 'shared',
        requestId: 'xmd:v1:media:instagram:6:shared',
        status: 'completed',
      },
    ])
  })

  it('does not expose legacy rows when migration persistence fails', async () => {
    const instagramItem = { ...item, id: 'shared', platform: 'instagram' as const }
    const current = applyOutcome(
      recordFromMediaItem(instagramItem, 'shared.jpg', 100),
      'completed',
      200,
    )
    const { mediaKey: _mediaKey, ...legacy } = current
    const onError = vi.fn<(error: unknown) => void>()
    const history = makeDownloadHistory({
      storage: {
        get: async () => ({ records: [{ ...legacy, requestId: 'shared' }] }),
        set: async () => {
          throw new Error('quota')
        },
      },
      onError,
    })

    await expect(history.listCompleted()).rejects.toThrow('quota')
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'quota' }))
  })

  it('derives the same queued provenance as Cloud Sync', async () => {
    const history = makeDownloadHistory({ storage: memoryStorage() })
    await recordProjection(history, [queued()])

    const [record] = await history.list()
    const event = queuedEvent(item, 'device-a', 100)
    expect(record?.requestId).toBe(event.requestId)
    expect(record?.media).toEqual(event.media)
  })

  it('deduplicates ids and preserves the first terminal outcome', async () => {
    const history = makeDownloadHistory({ storage: memoryStorage() })
    await recordProjection(history, [queued(), queued()])
    await recordProjection(history, [
      { kind: 'completed', requestId: item.id, at: 200 },
      { kind: 'failed', requestId: item.id, at: 300 },
      queued(),
    ])

    expect(await history.list()).toMatchObject([
      { requestId: item.id, status: 'completed', finishedAt: 200 },
    ])
  })

  it('ignores terminal outcomes for requests that were never admitted', async () => {
    const history = makeDownloadHistory({ storage: memoryStorage() })
    await recordProjection(history, [{ kind: 'completed', requestId: 'unknown', at: 2 }])

    expect(await history.list()).toEqual([])
  })

  it('checks the reset fence without writing empty or disabled admissions', async () => {
    const storage = memoryStorage()
    const history = makeDownloadHistory({ storage })

    await recordProjection(history, [])
    await recordProjection(history, [{ ...queued('disabled'), recordingEnabled: false }])

    expect(storage.reads()).toBe(2)
    expect(storage.writes()).toBe(0)
  })

  it('does not mistake a real media key ending in .json for a sidecar', async () => {
    const history = makeDownloadHistory({ storage: memoryStorage() })

    await recordProjection(history, [queued('real-media.json')])

    expect(await history.list()).toMatchObject([{ requestId: 'real-media.json' }])
  })

  it('preserves corrupt storage until explicit erase recovers History', async () => {
    const raw = { version: DOWNLOAD_STORE_VERSION, records: 'corrupt' }
    let value: unknown = raw
    let writes = 0
    const storage: DownloadHistoryStorage = {
      get: async () => value,
      set: async (next) => {
        writes += 1
        value = next
      },
    }
    const history = makeDownloadHistory({ storage })

    await expect(history.list()).rejects.toThrow('Download History is corrupt')
    await expect(history.listCompleted()).rejects.toThrow('Download History is corrupt')
    await expect(recordProjection(history, [queued()])).rejects.toThrow(
      'Download History is corrupt',
    )
    expect(value).toBe(raw)
    expect(writes).toBe(0)

    await history.erase([])
    expect(value).toEqual(emptyStore)
    expect(writes).toBe(1)
    await expect(history.list()).resolves.toEqual([])

    await recordProjection(history, [queued()])
    await expect(history.list()).resolves.toMatchObject([{ requestId: item.id }])
  })

  it('starts from absent storage and applies the configured cap', async () => {
    const history = makeDownloadHistory({ storage: memoryStorage(null), cap: 2 })
    await recordProjection(history, [queued('a'), queued('b'), queued('c')])

    expect((await history.list()).map((record) => record.requestId)).toEqual(['c', 'b'])
  })

  it('rejects a failed record without poisoning later operations', async () => {
    let value: DownloadStore = emptyStore
    let fail = true
    const onError = vi.fn<(error: unknown) => void>()
    const storage: DownloadHistoryStorage = {
      get: async () => value,
      set: async (next) => {
        if (fail) {
          fail = false
          throw new Error('quota')
        }
        value = next
      },
    }
    const history = makeDownloadHistory({ storage, onError })

    await expect(recordProjection(history, [queued('lost')])).rejects.toThrow('quota')
    expect(await history.list()).toEqual([])
    await recordProjection(history, [queued('kept')])

    expect(await history.list()).toMatchObject([{ requestId: 'kept' }])
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'quota' }))
  })

  it('reconstructs a missing record from an unordered queued and terminal batch', async () => {
    const history = makeDownloadHistory({ storage: memoryStorage() })

    await recordProjection(history, [
      { kind: 'completed', requestId: item.id, at: 2, bytes: { received: 5, total: 5 } },
      queued(),
    ])
    await recordProjection(history, [
      queued(),
      { kind: 'completed', requestId: item.id, at: 2, bytes: { received: 5, total: 5 } },
    ])

    expect(await history.list()).toMatchObject([
      { requestId: item.id, status: 'completed', bytesReceived: 5, bytesTotal: 5 },
    ])
  })

  it('keeps immutable queue order through terminal replay and cap eviction', async () => {
    const history = makeDownloadHistory({ storage: memoryStorage(), cap: 2 })

    await recordProjection(history, terminalActions('a', 100, 110), 'projection-a')
    await recordProjection(history, terminalActions('b', 200, 210), 'projection-b')
    await recordProjection(history, terminalActions('a', 100, 110), 'projection-a')
    expect((await history.list()).map(({ requestId }) => requestId)).toEqual(['b', 'a'])

    await recordProjection(history, terminalActions('c', 300, 310), 'projection-c')
    expect((await history.list()).map(({ requestId }) => requestId)).toEqual(['c', 'b'])
  })

  it('fences a pre-reset terminal replay across restart and clock rollback', async () => {
    const storage = memoryStorage()
    const first = makeDownloadHistory({ storage })
    await recordProjection(
      first,
      [
        { ...queued(), at: 5_000 },
        { kind: 'completed', requestId: item.id, at: 6_000 },
      ],
      'projection-before-reset',
    )
    await first.erase(['projection-before-reset'])

    const restarted = makeDownloadHistory({ storage })
    await expect(
      recordProjection(
        restarted,
        [
          { ...queued(), at: 1 },
          { kind: 'completed', requestId: item.id, at: 2 },
        ],
        'projection-before-reset',
      ),
    ).resolves.toBe('reset-fenced')
    await expect(restarted.list()).resolves.toEqual([])

    await expect(
      recordProjection(
        restarted,
        [
          { ...queued('later'), at: 0 },
          { kind: 'completed', requestId: 'later', at: 1 },
        ],
        'projection-after-reset',
      ),
    ).resolves.toBe('applied')
    await expect(restarted.list()).resolves.toMatchObject([
      { requestId: 'later', status: 'completed' },
    ])
  })
})
