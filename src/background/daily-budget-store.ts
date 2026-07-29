import {
  decodeStoredBudgetRecord,
  emptyBudgetRecord,
  encodeBudgetRecord,
  hasBudgetReceiptHeadroom,
  isBudgetRecordWithinBounds,
  isValidReceiptId,
  localDay,
  saturatingAdd,
  type BudgetRecord,
  type StoredBudgetRecord,
} from '../core/download/daily-budget'
import { makeSerialQueue } from '../core/serial-queue'

const isValidAmount = (value: number): boolean => Number.isSafeInteger(value) && value >= 0

export class DailyBudgetCorruptStateError extends Error {
  override readonly name = 'DailyBudgetCorruptStateError'

  constructor() {
    super('daily budget state is corrupt')
  }
}

export class DailyBudgetCapacityError extends Error {
  override readonly name = 'DailyBudgetCapacityError'

  constructor() {
    super('daily budget state capacity reached')
  }
}

export interface BudgetStorage {
  get(): Promise<unknown>
  set(record: StoredBudgetRecord): Promise<void>
}

export interface DailyBudgetStore {
  /** Today's tally, resetting a stale stored record on read. */
  readonly readToday: () => Promise<{ bytes: number; count: number; day: string }>
  /** Today's tally for launch admission. Full receipt state fails closed. */
  readonly readTodayForAdmission: () => Promise<{ bytes: number; count: number; day: string }>
  /** Credit one terminal receipt exactly once; resolves only after persistence. */
  readonly recordCompletion: (
    receiptId: string,
    terminalAt: number,
    bytes: number,
    count: number,
  ) => Promise<void>
  /** Zero today's tally and return its public display view. */
  readonly resetToday: () => Promise<{ bytes: number; count: number; day: string }>
}

const publicView = (record: BudgetRecord) => ({
  bytes: record.bytes,
  count: record.count,
  day: record.day,
})

export function makeDailyBudgetStore(deps: {
  storage: BudgetStorage
  now: () => number
}): DailyBudgetStore {
  const { storage, now } = deps
  const queue = makeSerialQueue()

  const read = async (nowMs = now()) => {
    const stored = await storage.get()
    const day = localDay(nowMs)
    const decoded = decodeStoredBudgetRecord(stored, day)
    if (decoded.kind === 'corrupt') throw new DailyBudgetCorruptStateError()
    return decoded
  }

  const persist = (record: BudgetRecord): Promise<void> => storage.set(encodeBudgetRecord(record))

  const materializeToday = async (): Promise<BudgetRecord> => {
    const decoded = await read()
    if (decoded.kind !== 'current') await persist(decoded.record)
    return decoded.record
  }

  return {
    readToday: () =>
      queue.run(async () => {
        const current = await materializeToday()
        return publicView(current)
      }),
    readTodayForAdmission: () =>
      queue.run(async () => {
        const current = await materializeToday()
        if (!hasBudgetReceiptHeadroom(current)) throw new DailyBudgetCapacityError()
        return publicView(current)
      }),
    recordCompletion: (receiptId, terminalAt, bytes, count) =>
      queue.run(async () => {
        if (!isValidReceiptId(receiptId))
          throw new RangeError('receiptId must be a stable non-empty ID')
        if (!isValidAmount(terminalAt) || !isValidAmount(bytes) || !isValidAmount(count))
          throw new RangeError(
            'completion time, bytes, and count must be non-negative safe integers',
          )

        const current = (await read()).record
        if (localDay(terminalAt) !== current.day) return
        if (terminalAt <= current.resetAt) return
        if (current.creditedReceiptIds.includes(receiptId)) return
        const creditedReceiptIds = [...current.creditedReceiptIds, receiptId]
        const next = {
          day: current.day,
          bytes: saturatingAdd(current.bytes, bytes),
          count: saturatingAdd(current.count, count),
          creditedReceiptIds,
          resetAt: current.resetAt,
        }
        if (!isBudgetRecordWithinBounds(next)) throw new DailyBudgetCapacityError()
        await persist(next)
      }),
    resetToday: () =>
      queue.run(async () => {
        const resetAt = now()
        const day = localDay(resetAt)
        const stored = await storage.get()
        const decoded = decodeStoredBudgetRecord(stored, day)
        const current = decoded.kind === 'corrupt' ? emptyBudgetRecord(day) : decoded.record
        const reset = {
          ...current,
          bytes: 0,
          count: 0,
          creditedReceiptIds: [],
          resetAt: decoded.kind === 'corrupt' ? resetAt : Math.max(current.resetAt, resetAt),
        }
        await persist(reset)
        return { bytes: reset.bytes, count: reset.count, day: reset.day }
      }),
  }
}
