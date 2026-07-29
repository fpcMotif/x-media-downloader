import { describe, expect, it, vi } from 'vitest'
import type { TweetRecord } from '../core/capture/record'
import type { SettingsRecord } from '../core/settings/storage'
import { makeSettingsWriter } from './settings-writer'
import { makeCaptureArchive } from './capture-archive'
import type { CaptureMirrorAdmission } from './capture-outbox'

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

const settingsRecord = (initial: object): SettingsRecord => {
  let value: unknown = initial
  return {
    get: async () => value,
    set: async (next) => {
      value = next
    },
  }
}

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const enabled = {
  captureEnabled: true,
  captureMirrorEnabled: true,
  convexUrl: 'https://x.convex.cloud',
  convexSyncSecret: 'secret',
  cloudDeviceId: 'device',
}
const EPOCH = 'capture:0'

describe('CaptureArchive', () => {
  it('discards an opt-out without touching either durable sink', async () => {
    const putRecords = vi.fn<() => Promise<void>>(async () => {})
    const enqueueAccepted = vi.fn<() => Promise<'accepted'>>(async () => 'accepted')
    const archive = makeCaptureArchive({
      settings: makeSettingsWriter(settingsRecord({ captureEnabled: false })),
      store: { putRecords, clearAndCount: async () => 0 },
      mirror: {
        currentEpoch: async () => EPOCH,
        enqueueAccepted,
        purge: async () => 'capture:1',
      },
    })

    await expect(archive.accept(EPOCH, [record('1')])).resolves.toEqual({
      _tag: 'CaptureDiscarded',
      epoch: EPOCH,
      discarded: 1,
    })
    expect(putRecords).not.toHaveBeenCalled()
    expect(enqueueAccepted).not.toHaveBeenCalled()
  })

  it('does not retroactively mirror an admission made while mirror consent was off', async () => {
    const writer = makeSettingsWriter(settingsRecord({ ...enabled, captureMirrorEnabled: false }))
    const storing = deferred()
    const releaseStore = deferred()
    const enqueueAccepted = vi.fn<() => Promise<'accepted'>>(async () => 'accepted')
    const archive = makeCaptureArchive({
      settings: writer,
      store: {
        putRecords: async () => {
          storing.resolve()
          await releaseStore.promise
        },
        clearAndCount: async () => 0,
      },
      mirror: {
        currentEpoch: async () => EPOCH,
        enqueueAccepted,
        purge: async () => 'capture:1',
      },
      now: () => 7,
    })

    const accepting = archive.accept(EPOCH, [record('1')])
    await storing.promise
    await writer.update({ captureMirrorEnabled: true })
    releaseStore.resolve()

    await expect(accepting).resolves.toEqual({
      _tag: 'CaptureStored',
      epoch: EPOCH,
      stored: 1,
      mirror: 'not-requested',
    })
    expect(enqueueAccepted).not.toHaveBeenCalled()
  })

  it('keeps mirror admission immutable when consent changes after acceptance', async () => {
    const writer = makeSettingsWriter(settingsRecord(enabled))
    const storing = deferred()
    const releaseStore = deferred()
    const admissions: CaptureMirrorAdmission[] = []
    const archive = makeCaptureArchive({
      settings: writer,
      store: {
        putRecords: async () => {
          storing.resolve()
          await releaseStore.promise
        },
        clearAndCount: async () => 0,
      },
      mirror: {
        currentEpoch: async () => EPOCH,
        enqueueAccepted: async (_records, admission) => {
          admissions.push(admission)
          return 'accepted'
        },
        purge: async () => 'capture:1',
      },
      now: () => 7,
    })

    const accepting = archive.accept(EPOCH, [record('1')])
    await storing.promise
    await writer.update({ captureMirrorEnabled: false })
    releaseStore.resolve()

    await expect(accepting).resolves.toEqual({
      _tag: 'CaptureStored',
      epoch: EPOCH,
      stored: 1,
      mirror: 'accepted',
    })
    expect(admissions).toEqual([
      {
        _tag: 'CaptureMirrorAdmission',
        destination: 'https://x.convex.cloud',
        deviceId: 'device',
        acceptedAt: 7,
      },
    ])
  })

  it('reports local success without claiming a full mirror outbox accepted the batch', async () => {
    const archive = makeCaptureArchive({
      settings: makeSettingsWriter(settingsRecord(enabled)),
      store: { putRecords: async () => {}, clearAndCount: async () => 0 },
      mirror: {
        currentEpoch: async () => EPOCH,
        enqueueAccepted: async () => 'unavailable',
        purge: async () => 'capture:1',
      },
    })

    await expect(archive.accept(EPOCH, [record('1')])).resolves.toEqual({
      _tag: 'CaptureStored',
      epoch: EPOCH,
      stored: 1,
      mirror: 'unavailable',
    })
  })

  it('orders accepted storage and durable mirror admission before erase', async () => {
    const order: string[] = []
    const storeStarted = deferred()
    const releaseStore = deferred()
    const archive = makeCaptureArchive({
      settings: makeSettingsWriter(settingsRecord(enabled)),
      store: {
        putRecords: async () => {
          order.push('store')
          storeStarted.resolve()
          await releaseStore.promise
        },
        clearAndCount: async () => {
          order.push('clear')
          return 1
        },
      },
      mirror: {
        currentEpoch: async () => EPOCH,
        enqueueAccepted: async () => {
          order.push('enqueue')
          return 'accepted'
        },
        purge: async () => {
          order.push('purge')
          return 'capture:1'
        },
      },
      now: () => 7,
    })

    const accepting = archive.accept(EPOCH, [record('1')])
    await storeStarted.promise
    const erasing = archive.erase()
    releaseStore.resolve()

    await expect(accepting).resolves.toEqual({
      _tag: 'CaptureStored',
      epoch: EPOCH,
      stored: 1,
      mirror: 'accepted',
    })
    await expect(erasing).resolves.toEqual({ cleared: 1, epoch: 'capture:1' })
    expect(order).toEqual(['store', 'enqueue', 'purge', 'clear'])
  })

  it('does not erase the archive if the mirror generation purge fails', async () => {
    const clearAndCount = vi.fn<() => Promise<number>>(async () => 1)
    const archive = makeCaptureArchive({
      settings: makeSettingsWriter(settingsRecord(enabled)),
      store: { putRecords: async () => {}, clearAndCount },
      mirror: {
        currentEpoch: async () => EPOCH,
        enqueueAccepted: async () => 'accepted',
        purge: async () => {
          throw new Error('ledger unavailable')
        },
      },
    })

    await expect(archive.erase()).rejects.toThrow('ledger unavailable')
    expect(clearAndCount).not.toHaveBeenCalled()
  })

  it('rejects a delayed pre-erase batch before either durable sink', async () => {
    let epoch = EPOCH
    const putRecords = vi.fn<(records: ReadonlyArray<TweetRecord>) => Promise<void>>(async () => {})
    const enqueueAccepted = vi.fn<
      (
        records: ReadonlyArray<TweetRecord>,
        admission: CaptureMirrorAdmission,
      ) => Promise<'accepted'>
    >(async () => 'accepted')
    const archive = makeCaptureArchive({
      settings: makeSettingsWriter(settingsRecord(enabled)),
      store: { putRecords, clearAndCount: async () => 0 },
      mirror: {
        currentEpoch: async () => epoch,
        enqueueAccepted,
        purge: async () => {
          epoch = 'capture:1'
          return epoch
        },
      },
    })

    await archive.erase()
    await expect(archive.accept(EPOCH, [record('1')])).resolves.toEqual({
      _tag: 'CaptureDiscarded',
      epoch: 'capture:1',
      discarded: 1,
    })
    expect(putRecords).not.toHaveBeenCalled()
    expect(enqueueAccepted).not.toHaveBeenCalled()
  })

  it('keeps an unacked pre-erase retry dead across the full Archive composition', async () => {
    let epoch = EPOCH
    const rows = new Map<string, TweetRecord>()
    let pendingMirror: TweetRecord[] = []
    const archive = makeCaptureArchive({
      settings: makeSettingsWriter(settingsRecord(enabled)),
      store: {
        putRecords: async (records) => {
          for (const item of records) rows.set(item.tweetId, item)
        },
        clearAndCount: async () => {
          const count = rows.size
          rows.clear()
          return count
        },
      },
      mirror: {
        currentEpoch: async () => epoch,
        enqueueAccepted: async (records) => {
          pendingMirror = [...records]
          return 'accepted'
        },
        purge: async () => {
          epoch = 'capture:1'
          pendingMirror = []
          return epoch
        },
      },
    })

    await archive.accept(EPOCH, [record('1')]) // reply lost
    await archive.erase()
    await archive.accept(EPOCH, [record('1')]) // delayed retry
    expect([...rows.values()]).toEqual([])
    expect(pendingMirror).toEqual([])

    await archive.accept('capture:1', [record('2')])
    expect([...rows.keys()]).toEqual(['2'])
    expect(pendingMirror.map((item) => item.tweetId)).toEqual(['2'])
  })
})
