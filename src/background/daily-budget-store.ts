import { addCompletion, freshRecord, type BudgetRecord } from '../core/download/daily-budget'

export interface BudgetStorage {
  get(): Promise<BudgetRecord | null>
  set(record: BudgetRecord): Promise<void>
}

export interface DailyBudgetStore {
  /** Today's tally, resetting a stale stored record on read. */
  readonly readToday: () => Promise<{ bytes: number; count: number; day: string }>
  /** Add a completed download's bytes and one file to today's tally; persists. */
  readonly recordCompletion: (bytes: number, count: number) => Promise<void>
  /** Zero today's tally. */
  readonly resetToday: () => Promise<void>
}

export function makeDailyBudgetStore(deps: {
  storage: BudgetStorage
  now: () => number
}): DailyBudgetStore {
  const { storage, now } = deps
  return {
    async readToday() {
      const stored = await storage.get()
      const r = freshRecord(stored, now())
      if (r !== stored) await storage.set(r)
      return { bytes: r.bytes, count: r.count, day: r.day }
    },
    async recordCompletion(bytes, count) {
      const stored = await storage.get()
      await storage.set(addCompletion(stored, now(), bytes, count))
    },
    async resetToday() {
      await storage.set(freshRecord(null, now()))
    },
  }
}
