import { describe, expect, it, vi } from 'vitest'
import { SETTINGS_DEFAULTS } from '../core/schema'
import type { TransferRequest } from '../core/download/transfer-registry'
import { makeSweepReceiptStore, type SweepReceiptStoreState } from './sweep-receipt-store'
import { repairSweepReceipts } from './sweep-receipt-repair'

const receipt = {
  receiptId: 'sweep-1',
  tweetId: '123',
  scope: 'bookmark' as const,
  itemIds: ['media-1'],
  at: 10,
}

const storage = () => {
  let value: unknown = null
  return {
    get: async () => value,
    set: async (next: SweepReceiptStoreState) => {
      value = next
    },
  }
}

describe('repairSweepReceipts', () => {
  it('repairs the crash after Clear seed and before Worklist projection without a launch', async () => {
    const receipts = makeSweepReceiptStore({ storage: storage() })
    await receipts.enqueue(receipt)
    await receipts.markSeeded({
      receiptId: receipt.receiptId,
      requestIds: receipt.itemIds,
      clearSeedId: 7,
      at: 11,
    })
    const ensureSeededSweepPosts = vi.fn<(...args: unknown[]) => Promise<'owned'>>(
      async () => 'owned',
    )
    const clear = { seed: vi.fn<() => never>() }
    const registry = {
      listSweepReceiptIntents: vi.fn<() => Promise<readonly []>>(async () => []),
      abandonSweepReceipt: vi.fn<(receiptId: string) => Promise<boolean>>(async () => false),
    }

    await expect(
      repairSweepReceipts({
        receipts,
        registry,
        clear,
        worklist: { ensureSeededSweepPosts },
        settings: SETTINGS_DEFAULTS,
        now: () => 12,
      }),
    ).resolves.toEqual({
      protectedRequestIds: new Set(['media-1']),
      clearSeedIdByReceipt: new Map([['sweep-1', 7]]),
    })
    expect(ensureSeededSweepPosts).toHaveBeenCalledWith('bookmark', ['123'], 7)
    expect(clear.seed).not.toHaveBeenCalled()
  })

  it('repairs a queued exact intent before releasing it', async () => {
    const receipts = makeSweepReceiptStore({ storage: storage() })
    await receipts.enqueue(receipt)
    const intent: TransferRequest = {
      id: 'media-1',
      projectionId: 'projection-1',
      url: 'https://pbs.twimg.com/media/a.jpg',
      filename: 'a.jpg',
      mode: 'direct',
      historyPolicy: 'record',
      item: {
        id: 'media-1',
        platform: 'x',
        postId: '123',
        author: 'alice',
        type: 'photo',
        url: 'https://pbs.twimg.com/media/a.jpg',
        ext: 'jpg',
        index: 0,
      },
      sweepReceipt: { receiptId: 'sweep-1', tweetId: '123', scope: 'bookmark' },
    }
    let seedCalls = 0
    const clear = {
      seed: async () => {
        seedCalls += 1
        return {
          trackedByTweet: new Map([['123', new Set(['media-1'])]]),
          worklistRevision: 7,
        }
      },
    }
    const ensureSeededSweepPosts = vi.fn<(...args: unknown[]) => Promise<'owned'>>(
      async () => 'owned',
    )

    await expect(
      repairSweepReceipts({
        receipts,
        registry: {
          listSweepReceiptIntents: async () => [intent],
          abandonSweepReceipt: async () => false,
        },
        clear,
        worklist: { ensureSeededSweepPosts },
        settings: { ...SETTINGS_DEFAULTS, clearOnSave: true },
        now: () => 11,
      }),
    ).resolves.toEqual({
      protectedRequestIds: new Set(['media-1']),
      clearSeedIdByReceipt: new Map([['sweep-1', 7]]),
    })
    expect(seedCalls).toBe(1)
    expect(ensureSeededSweepPosts).toHaveBeenCalledWith('bookmark', ['123'], 7)
    await expect(receipts.get('sweep-1')).resolves.toMatchObject({
      state: 'seeded',
      requestIds: ['media-1'],
      clearSeedId: 7,
    })
  })

  it('fails closed when receipt and media provenance name different Tweets', async () => {
    const receipts = makeSweepReceiptStore({ storage: storage() })
    await receipts.enqueue(receipt)
    const intent: TransferRequest = {
      id: 'media-1',
      projectionId: 'projection-1',
      url: 'https://pbs.twimg.com/media/a.jpg',
      filename: 'a.jpg',
      mode: 'direct',
      historyPolicy: 'record',
      item: {
        id: 'media-1',
        platform: 'x',
        postId: '456',
        author: 'alice',
        type: 'photo',
        url: 'https://pbs.twimg.com/media/a.jpg',
        ext: 'jpg',
        index: 0,
      },
      sweepReceipt: { receiptId: 'sweep-1', tweetId: '123', scope: 'bookmark' },
    }
    let clearCalls = 0

    await expect(
      repairSweepReceipts({
        receipts,
        registry: {
          listSweepReceiptIntents: async () => [intent],
          abandonSweepReceipt: async () => true,
        },
        clear: {
          seed: async () => {
            clearCalls += 1
            throw new Error('must not seed a mismatched post')
          },
        },
        worklist: { ensureSeededSweepPosts: async () => 'owned' },
        settings: { ...SETTINGS_DEFAULTS, clearOnSave: true },
        now: () => 11,
      }),
    ).resolves.toEqual({ protectedRequestIds: new Set(), clearSeedIdByReceipt: new Map() })
    expect(clearCalls).toBe(0)
    await expect(receipts.get('sweep-1')).resolves.toMatchObject({
      state: 'failed',
      reason: 'missing or partial Registry Sweep intent',
    })
  })

  it('abandons a partial queued intent before marking the receipt failed', async () => {
    const receipts = makeSweepReceiptStore({ storage: storage() })
    await receipts.enqueue(receipt)
    const calls: string[] = []
    const registry = {
      listSweepReceiptIntents: async () => [],
      abandonSweepReceipt: async () => {
        calls.push('abandon')
        return true
      },
    }

    await repairSweepReceipts({
      receipts,
      registry,
      clear: { seed: async () => ({}) as never },
      worklist: { ensureSeededSweepPosts: async () => 'owned' },
      settings: SETTINGS_DEFAULTS,
      now: () => 11,
    })

    calls.push((await receipts.get('sweep-1'))!.state)
    expect(calls).toEqual(['abandon', 'failed'])
  })

  it('keeps a queued receipt when its Registry intent cannot be abandoned', async () => {
    const receipts = makeSweepReceiptStore({ storage: storage() })
    await receipts.enqueue(receipt)
    const intent = {
      sweepReceipt: { receiptId: 'sweep-1', tweetId: '123', scope: 'bookmark' as const },
    }

    await expect(
      repairSweepReceipts({
        receipts,
        registry: {
          listSweepReceiptIntents: async () => [intent] as never,
          abandonSweepReceipt: async () => false,
        },
        clear: { seed: async () => ({}) as never },
        worklist: { ensureSeededSweepPosts: async () => 'owned' },
        settings: SETTINGS_DEFAULTS,
        now: () => 11,
      }),
    ).rejects.toThrow('cannot be abandoned')
    await expect(receipts.get('sweep-1')).resolves.toMatchObject({ state: 'queued' })
  })

  it('abandons a seeded receipt when authoritative Worklist state is terminal', async () => {
    const receipts = makeSweepReceiptStore({ storage: storage() })
    await receipts.enqueue(receipt)
    await receipts.markSeeded({
      receiptId: receipt.receiptId,
      requestIds: receipt.itemIds,
      clearSeedId: 7,
      at: 11,
    })
    const abandonSweepReceipt = vi.fn<(receiptId: string) => Promise<boolean>>(async () => true)

    await expect(
      repairSweepReceipts({
        receipts,
        registry: {
          listSweepReceiptIntents: async () => [],
          abandonSweepReceipt,
        },
        clear: { seed: async () => ({}) as never },
        worklist: { ensureSeededSweepPosts: async () => 'terminal' },
        settings: SETTINGS_DEFAULTS,
        now: () => 12,
      }),
    ).resolves.toEqual({ protectedRequestIds: new Set(), clearSeedIdByReceipt: new Map() })
    expect(abandonSweepReceipt).toHaveBeenCalledWith('sweep-1')
    await expect(receipts.get('sweep-1')).resolves.toBeUndefined()
  })
})
