import { describe, expect, it, vi } from 'vitest'
import {
  MAX_SWEEP_RECEIPT_STORE_BYTES,
  decodeSweepReceiptStore,
  makeSweepReceiptStore,
  type SweepReceiptStoreState,
} from './sweep-receipt-store'

const queued = {
  receiptId: 'sweep-1',
  tweetId: '123',
  scope: 'bookmark' as const,
  itemIds: ['media-1', 'media-2'],
  at: 10,
}

function fakeStorage(initial: unknown = null) {
  const box = {
    value: initial,
    async get() {
      return box.value
    },
    async set(value: SweepReceiptStoreState) {
      box.value = value
    },
  }
  return box
}

describe('SweepReceiptStore', () => {
  it('persists queued ownership before resolving', async () => {
    const storage = fakeStorage()
    const write = Promise.withResolvers<void>()
    storage.set = vi.fn<(value: SweepReceiptStoreState) => Promise<void>>(() => write.promise)
    const store = makeSweepReceiptStore({ storage })
    let settled = false
    const pending = store.enqueue(queued).then(() => (settled = true))

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    write.resolve()
    await pending
    expect(storage.set).toHaveBeenCalledOnce()
  })

  it('does not leave partial receipts when a batch write fails', async () => {
    const storage = fakeStorage()
    storage.set = vi.fn<(value: SweepReceiptStoreState) => Promise<void>>(async () => {
      throw new Error('quota')
    })
    const store = makeSweepReceiptStore({ storage })

    await expect(
      store.enqueueMany([
        queued,
        { ...queued, receiptId: 'sweep-2', tweetId: '124', itemIds: ['media-3'] },
      ]),
    ).rejects.toThrow('quota')
    await expect(store.listRecoverable()).resolves.toEqual([])
    expect(storage.set).toHaveBeenCalledOnce()
  })

  it('requires the exact queued primary IDs before it records a Clear seed', async () => {
    const storage = fakeStorage()
    const store = makeSweepReceiptStore({ storage })
    await store.enqueue(queued)

    await expect(
      store.markSeeded({
        receiptId: queued.receiptId,
        requestIds: ['media-2', 'media-1'],
        clearSeedId: 1,
        at: 11,
      }),
    ).rejects.toThrow('exactly match')
    await expect(
      store.markSeeded({
        receiptId: queued.receiptId,
        requestIds: ['xmd:v1:sidecar:x:7:media-1'],
        clearSeedId: 1,
        at: 11,
      }),
    ).rejects.toThrow('exactly match')
    await expect(
      store.markSeeded({
        receiptId: queued.receiptId,
        requestIds: queued.itemIds,
        clearSeedId: 1,
        at: 11,
      }),
    ).resolves.toMatchObject({ state: 'seeded', clearSeedId: 1 })
  })

  it('never accepts a sidecar as a swept media identity', async () => {
    await expect(
      makeSweepReceiptStore({ storage: fakeStorage() }).enqueue({
        ...queued,
        itemIds: ['xmd:v1:sidecar:x:7:media-1'],
      }),
    ).rejects.toThrow('invalid queued sweep receipt')
  })

  it('makes seeded writes idempotent but rejects a conflicting Clear receipt', async () => {
    const store = makeSweepReceiptStore({ storage: fakeStorage() })
    await store.enqueue(queued)
    const input = {
      receiptId: queued.receiptId,
      requestIds: queued.itemIds,
      clearSeedId: 7,
      at: 11,
    }
    await store.markSeeded(input)
    await expect(store.markSeeded(input)).resolves.toMatchObject({ state: 'seeded' })
    await expect(store.markSeeded({ ...input, clearSeedId: 8 })).rejects.toThrow('conflicting')
  })

  it('keeps a seeded handoff recoverable after a later failure', async () => {
    const store = makeSweepReceiptStore({ storage: fakeStorage() })
    await store.enqueue(queued)
    await store.markSeeded({
      receiptId: queued.receiptId,
      requestIds: queued.itemIds,
      clearSeedId: 7,
      at: 11,
    })

    await expect(
      store.markFailed({ receiptId: queued.receiptId, reason: 'worklist write failed', at: 12 }),
    ).rejects.toThrow('seeded sweep receipt')
    await expect(store.listRecoverable()).resolves.toHaveLength(1)
  })

  it('keeps only queued and seeded receipts recoverable', async () => {
    const store = makeSweepReceiptStore({ storage: fakeStorage() })
    await store.enqueue(queued)
    await store.enqueue({ ...queued, receiptId: 'sweep-2', tweetId: '124', itemIds: ['media-3'] })
    await store.markFailed({ receiptId: queued.receiptId, reason: 'registry rejected', at: 12 })

    await expect(store.listRecoverable()).resolves.toEqual([
      {
        state: 'queued',
        receiptId: 'sweep-2',
        tweetId: '124',
        scope: 'bookmark',
        itemIds: ['media-3'],
        at: 10,
      },
    ])
  })

  it('retires only an exact seeded handoff and treats absence as terminal success', async () => {
    const store = makeSweepReceiptStore({ storage: fakeStorage() })
    await store.enqueue(queued)
    await store.markSeeded({
      receiptId: queued.receiptId,
      requestIds: queued.itemIds,
      clearSeedId: 7,
      at: 11,
    })

    await expect(store.ackOwned({ receiptId: queued.receiptId, clearSeedId: 8 })).rejects.toThrow(
      'cannot acknowledge',
    )
    await store.ackOwned({ receiptId: queued.receiptId, clearSeedId: 7 })
    await store.ackOwned({ receiptId: queued.receiptId, clearSeedId: 7 })
    await expect(store.get(queued.receiptId)).resolves.toBeUndefined()
  })

  it('fails closed on malformed durable state', async () => {
    const malformed = {
      version: 1,
      receipts: {
        'sweep-1': { state: 'queued', ...queued, extra: true },
      },
    }
    expect(decodeSweepReceiptStore(malformed)).toBeUndefined()
    await expect(
      makeSweepReceiptStore({ storage: fakeStorage(malformed) }).listRecoverable(),
    ).rejects.toThrow('invalid sweep receipt store')
  })

  it('rejects a state that exceeds its total JSON budget', () => {
    expect(
      decodeSweepReceiptStore({ padding: 'x'.repeat(MAX_SWEEP_RECEIPT_STORE_BYTES + 1) }),
    ).toBeUndefined()
  })
})
