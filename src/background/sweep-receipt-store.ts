import { storage } from 'wxt/utils/storage'
import { makeSerialQueue } from '../core/serial-queue'
import {
  MAX_SWEEP_RECEIPT_ID_LENGTH,
  MAX_X_MEDIA_PER_SWEEP_POST,
  MAX_TRANSFER_REGISTRY_ID_LENGTH,
} from '../core/wire/limits'

export const SWEEP_RECEIPT_STORAGE_KEY = 'local:sweepReceipts'
export const SWEEP_RECEIPT_VERSION = 1 as const
export const MAX_SWEEP_RECEIPTS = 5_000
/** Bounds service-worker decode and local-storage commits. */
export const MAX_SWEEP_RECEIPT_STORE_BYTES = 8 * 1024 * 1024
const MAX_FAILURE_REASON_LENGTH = 256

type SweepScope = 'bookmark' | 'like'

interface SweepReceiptBase {
  readonly receiptId: string
  readonly tweetId: string
  readonly scope: SweepScope
  /** Canonical primary-media request IDs. Sidecars never appear here. */
  readonly itemIds: ReadonlyArray<string>
  readonly at: number
}

export interface QueuedSweepReceipt extends SweepReceiptBase {
  readonly state: 'queued'
}
export interface SeededSweepReceipt extends SweepReceiptBase {
  readonly state: 'seeded'
  /** Exact primary request IDs accepted by Clear. Equal to `itemIds`. */
  readonly requestIds: ReadonlyArray<string>
  /** Durable Clear state revision that accepted this exact seed. */
  readonly clearSeedId: number
}
export interface FailedSweepReceipt extends SweepReceiptBase {
  readonly state: 'failed'
  readonly reason: string
}
export type SweepReceipt = QueuedSweepReceipt | SeededSweepReceipt | FailedSweepReceipt

export interface SweepReceiptStoreState {
  readonly version: 1
  readonly receipts: Readonly<Record<string, SweepReceipt>>
}

export const emptySweepReceiptStore: SweepReceiptStoreState = {
  version: SWEEP_RECEIPT_VERSION,
  receipts: {},
}

export class SweepReceiptCorruptionError extends Error {
  override name = 'SweepReceiptCorruptionError'
}

export interface SweepReceiptStorage {
  readonly get: () => Promise<unknown>
  readonly set: (value: SweepReceiptStoreState) => Promise<void>
}

export interface SweepReceiptStore {
  readonly enqueue: (input: Omit<QueuedSweepReceipt, 'state'>) => Promise<QueuedSweepReceipt>
  /** One all-or-nothing durable receipt set for a Sweep request. */
  readonly enqueueMany: (
    input: ReadonlyArray<Omit<QueuedSweepReceipt, 'state'>>,
  ) => Promise<ReadonlyArray<QueuedSweepReceipt>>
  readonly markSeeded: (input: {
    readonly receiptId: string
    readonly requestIds: ReadonlyArray<string>
    readonly clearSeedId: number
    readonly at: number
  }) => Promise<SeededSweepReceipt>
  readonly markFailed: (input: {
    readonly receiptId: string
    readonly reason: string
    readonly at: number
  }) => Promise<FailedSweepReceipt>
  /** Deletes only an exact seeded receipt. Missing means a prior terminal ack won. */
  readonly ackOwned: (input: {
    readonly receiptId: string
    readonly clearSeedId: number
  }) => Promise<void>
  /** Removes a receipt only after Registry proves its exact intent is gone. */
  readonly discardAbandoned: (receiptId: string) => Promise<void>
  /** Only receipts that still fence cross-store recovery. */
  readonly listRecoverable: () => Promise<ReadonlyArray<QueuedSweepReceipt | SeededSweepReceipt>>
  readonly get: (receiptId: string) => Promise<SweepReceipt | undefined>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const exactKeys = (value: unknown, keys: ReadonlyArray<string>): value is Record<string, unknown> =>
  isRecord(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key))
const validReceiptId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.length <= MAX_SWEEP_RECEIPT_ID_LENGTH &&
  !Object.hasOwn(Object.prototype, value)
const validTweetId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9]{1,20}$/.test(value)
const validScope = (value: unknown): value is SweepScope => value === 'bookmark' || value === 'like'
const validTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const validItemIds = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.length <= MAX_X_MEDIA_PER_SWEEP_POST &&
  value.every(
    (id) =>
      typeof id === 'string' &&
      id.trim().length > 0 &&
      id.length <= MAX_TRANSFER_REGISTRY_ID_LENGTH &&
      !Object.hasOwn(Object.prototype, id) &&
      !id.startsWith('xmd:v1:sidecar:'),
  ) &&
  new Set(value).size === value.length
const sameIds = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index])
const isBoundedJson = (value: unknown): boolean => {
  try {
    const encoded = JSON.stringify(value)
    return (
      typeof encoded === 'string' &&
      new TextEncoder().encode(encoded).byteLength <= MAX_SWEEP_RECEIPT_STORE_BYTES
    )
  } catch {
    return false
  }
}

const decodeReceipt = (value: unknown): SweepReceipt | undefined => {
  if (!isRecord(value) || typeof value.state !== 'string') return undefined
  const base =
    validReceiptId(value.receiptId) &&
    validTweetId(value.tweetId) &&
    validScope(value.scope) &&
    validItemIds(value.itemIds) &&
    validTime(value.at)
      ? {
          receiptId: value.receiptId,
          tweetId: value.tweetId,
          scope: value.scope,
          itemIds: [...value.itemIds],
          at: value.at,
        }
      : undefined
  if (base === undefined) return undefined
  if (value.state === 'queued')
    return exactKeys(value, ['state', 'receiptId', 'tweetId', 'scope', 'itemIds', 'at'])
      ? { state: 'queued', ...base }
      : undefined
  if (value.state === 'seeded')
    return exactKeys(value, [
      'state',
      'receiptId',
      'tweetId',
      'scope',
      'itemIds',
      'requestIds',
      'clearSeedId',
      'at',
    ]) &&
      validItemIds(value.requestIds) &&
      sameIds(base.itemIds, value.requestIds) &&
      typeof value.clearSeedId === 'number' &&
      Number.isSafeInteger(value.clearSeedId) &&
      value.clearSeedId >= 1
      ? {
          state: 'seeded',
          ...base,
          requestIds: [...value.requestIds],
          clearSeedId: value.clearSeedId,
        }
      : undefined
  if (value.state === 'failed')
    return exactKeys(value, [
      'state',
      'receiptId',
      'tweetId',
      'scope',
      'itemIds',
      'reason',
      'at',
    ]) &&
      typeof value.reason === 'string' &&
      value.reason.trim().length > 0 &&
      value.reason.length <= MAX_FAILURE_REASON_LENGTH
      ? { state: 'failed', ...base, reason: value.reason }
      : undefined
  return undefined
}

/** Exact decoder. Any malformed row blocks new sweep handoffs; it is never dropped. */
export const decodeSweepReceiptStore = (value: unknown): SweepReceiptStoreState | undefined => {
  if (value === null || value === undefined) return emptySweepReceiptStore
  if (!isBoundedJson(value)) return undefined
  if (
    !exactKeys(value, ['version', 'receipts']) ||
    value.version !== SWEEP_RECEIPT_VERSION ||
    !isRecord(value.receipts)
  )
    return undefined
  const entries = Object.entries(value.receipts)
  if (entries.length > MAX_SWEEP_RECEIPTS) return undefined
  const receipts: Record<string, SweepReceipt> = {}
  for (const [key, raw] of entries) {
    const receipt = decodeReceipt(raw)
    if (receipt === undefined || key !== receipt.receiptId) return undefined
    receipts[key] = receipt
  }
  return { version: SWEEP_RECEIPT_VERSION, receipts }
}

const capFailed = (
  receipts: Readonly<Record<string, SweepReceipt>>,
): Record<string, SweepReceipt> => {
  const active = Object.entries(receipts).filter(([, receipt]) => receipt.state !== 'failed')
  if (active.length > MAX_SWEEP_RECEIPTS) throw new RangeError('too many active sweep receipts')
  const room = MAX_SWEEP_RECEIPTS - active.length
  const failed = Object.entries(receipts)
    .filter(([, receipt]) => receipt.state === 'failed')
    .toSorted(([, left], [, right]) => right.at - left.at)
    .slice(0, room)
  return Object.fromEntries([...active, ...failed])
}

export function makeSweepReceiptStore(
  deps: {
    readonly storage?: SweepReceiptStorage
    readonly onError?: (error: unknown) => void
  } = {},
): SweepReceiptStore {
  const receiptStorage = deps.storage ?? defaultStorage()
  const lane = makeSerialQueue(deps.onError)
  const read = async (): Promise<SweepReceiptStoreState> => {
    const decoded = decodeSweepReceiptStore(await receiptStorage.get())
    if (decoded === undefined) throw new SweepReceiptCorruptionError('invalid sweep receipt store')
    return decoded
  }
  const write = async (receipts: Readonly<Record<string, SweepReceipt>>): Promise<void> => {
    const next = { version: SWEEP_RECEIPT_VERSION, receipts: capFailed(receipts) }
    if (!isBoundedJson(next)) throw new RangeError('sweep receipt store size')
    await receiptStorage.set(next)
  }

  return {
    enqueue: (input) =>
      lane.run(async () => {
        const queued = decodeReceipt({ state: 'queued', ...input })
        if (queued?.state !== 'queued') throw new TypeError('invalid queued sweep receipt')
        const current = await read()
        if (current.receipts[queued.receiptId] !== undefined)
          throw new Error(`duplicate sweep receipt: ${queued.receiptId}`)
        await write({ ...current.receipts, [queued.receiptId]: queued })
        return queued
      }),
    enqueueMany: (input) =>
      lane.run(async () => {
        const queued: QueuedSweepReceipt[] = []
        for (const inputReceipt of input) {
          const receipt = decodeReceipt({ state: 'queued', ...inputReceipt })
          if (receipt?.state !== 'queued') throw new TypeError('invalid queued sweep receipt')
          queued.push(receipt)
        }
        const ids = queued.map((value) => value.receiptId)
        if (new Set(ids).size !== ids.length) throw new Error('duplicate sweep receipt')
        const current = await read()
        if (ids.some((receiptId) => current.receipts[receiptId] !== undefined))
          throw new Error('duplicate sweep receipt')
        await write({
          ...current.receipts,
          ...Object.fromEntries(queued.map((receipt) => [receipt.receiptId, receipt])),
        })
        return queued
      }),
    markSeeded: (input) =>
      lane.run(async () => {
        const current = await read()
        const receipt = current.receipts[input.receiptId]
        if (receipt === undefined) throw new Error(`missing sweep receipt: ${input.receiptId}`)
        if (!validItemIds(input.requestIds) || !sameIds(receipt.itemIds, input.requestIds))
          throw new TypeError('seed request IDs must exactly match the queued media IDs')
        if (
          !Number.isSafeInteger(input.clearSeedId) ||
          input.clearSeedId < 1 ||
          !validTime(input.at)
        )
          throw new TypeError('invalid Clear seed receipt')
        const seeded: SeededSweepReceipt = {
          state: 'seeded',
          receiptId: receipt.receiptId,
          tweetId: receipt.tweetId,
          scope: receipt.scope,
          itemIds: receipt.itemIds,
          requestIds: [...input.requestIds],
          clearSeedId: input.clearSeedId,
          at: input.at,
        }
        if (receipt.state === 'seeded') {
          if (
            sameIds(receipt.requestIds, seeded.requestIds) &&
            receipt.clearSeedId === seeded.clearSeedId
          )
            return receipt
          throw new Error(`conflicting Clear seed: ${receipt.receiptId}`)
        }
        if (receipt.state === 'failed')
          throw new Error(`failed sweep receipt: ${receipt.receiptId}`)
        await write({ ...current.receipts, [seeded.receiptId]: seeded })
        return seeded
      }),
    markFailed: (input) =>
      lane.run(async () => {
        const current = await read()
        const receipt = current.receipts[input.receiptId]
        if (receipt === undefined) throw new Error(`missing sweep receipt: ${input.receiptId}`)
        if (
          typeof input.reason !== 'string' ||
          input.reason.trim().length === 0 ||
          input.reason.length > MAX_FAILURE_REASON_LENGTH ||
          !validTime(input.at)
        )
          throw new TypeError('invalid sweep failure')
        const failed: FailedSweepReceipt = {
          state: 'failed',
          receiptId: receipt.receiptId,
          tweetId: receipt.tweetId,
          scope: receipt.scope,
          itemIds: receipt.itemIds,
          reason: input.reason,
          at: input.at,
        }
        if (receipt.state === 'failed') {
          if (receipt.reason === failed.reason) return receipt
          throw new Error(`conflicting sweep failure: ${receipt.receiptId}`)
        }
        if (receipt.state !== 'queued')
          throw new Error(`seeded sweep receipt: ${receipt.receiptId}`)
        await write({ ...current.receipts, [failed.receiptId]: failed })
        return failed
      }),
    ackOwned: (input) =>
      lane.run(async () => {
        if (!validReceiptId(input.receiptId) || !Number.isSafeInteger(input.clearSeedId))
          throw new TypeError('invalid sweep receipt acknowledgement')
        const current = await read()
        const receipt = current.receipts[input.receiptId]
        if (receipt === undefined) return
        if (receipt.state !== 'seeded' || receipt.clearSeedId !== input.clearSeedId)
          throw new Error(`cannot acknowledge sweep receipt: ${input.receiptId}`)
        const { [input.receiptId]: _acknowledged, ...receipts } = current.receipts
        await write(receipts)
      }),
    discardAbandoned: (receiptId) =>
      lane.run(async () => {
        if (!validReceiptId(receiptId)) throw new TypeError('invalid abandoned sweep receipt')
        const current = await read()
        if (current.receipts[receiptId] === undefined) return
        const { [receiptId]: _discarded, ...receipts } = current.receipts
        await write(receipts)
      }),
    listRecoverable: () =>
      lane.run(async () =>
        Object.values((await read()).receipts).filter(
          (receipt): receipt is QueuedSweepReceipt | SeededSweepReceipt =>
            receipt.state !== 'failed',
        ),
      ),
    get: (receiptId) => lane.run(async () => (await read()).receipts[receiptId]),
  }
}

function defaultStorage(): SweepReceiptStorage {
  const item = storage.defineItem<unknown>(SWEEP_RECEIPT_STORAGE_KEY, { fallback: null })
  return { get: () => item.getValue(), set: (value) => item.setValue(value) }
}
