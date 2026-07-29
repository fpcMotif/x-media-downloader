import { isJsonWithinByteBudget } from '../wire/json-budget'
import { isTransferProjectionId } from '../wire/identity'
import { MAX_TRANSFER_PROJECTION_ID_LENGTH } from '../wire/limits'

export interface BudgetRecord {
  readonly day: string // local 'YYYY-MM-DD'
  readonly bytes: number
  readonly count: number
  /** Terminal receipt IDs already credited for this local day. */
  readonly creditedReceiptIds: ReadonlyArray<string>
  /** Epoch ms of the latest user-requested reset. */
  readonly resetAt: number
}

export type LegacyBudgetRecord = Pick<BudgetRecord, 'day' | 'bytes' | 'count'>

export const DAILY_BUDGET_STORE_VERSION = 1 as const
export const MAX_RECEIPT_ID_LENGTH = MAX_TRANSFER_PROJECTION_ID_LENGTH
export const MAX_DAILY_BUDGET_RECEIPTS = 5_000
export const MAX_DAILY_BUDGET_STORE_BYTES = 2 * 1024 * 1024

export interface StoredBudgetRecord {
  readonly version: typeof DAILY_BUDGET_STORE_VERSION
  readonly record: BudgetRecord
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Local calendar day for an epoch-ms instant, 'YYYY-MM-DD'. */
export function localDay(nowMs: number): string {
  const d = new Date(nowMs)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export const emptyBudgetRecord = (day: string, resetAt = 0): BudgetRecord => ({
  day,
  bytes: 0,
  count: 0,
  creditedReceiptIds: [],
  resetAt,
})

const isValidAmount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const isValidDay = (value: unknown): value is string => {
  if (typeof value !== 'string') return false
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (match === null) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12) return false
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day >= 1 && day <= daysInMonth[month - 1]!
}

/** Add a non-negative safe integer without letting the durable tally overflow. */
export const saturatingAdd = (current: number, added: number): number =>
  Math.min(Number.MAX_SAFE_INTEGER, current + added)

export const isValidReceiptId = isTransferProjectionId

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const dataValue = (value: object, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor?.enumerable === true && 'value' in descriptor ? descriptor.value : undefined
}

const hasExactDataKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  if (Object.getOwnPropertySymbols(value).length !== 0) return false
  const actual = Object.keys(value).toSorted()
  const wanted = [...expected].toSorted()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
    return false
  return actual.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor?.enumerable === true && 'value' in descriptor
  })
}

const decodeRecord = (raw: unknown): BudgetRecord | undefined => {
  if (
    !isPlainRecord(raw) ||
    !hasExactDataKeys(raw, ['day', 'bytes', 'count', 'creditedReceiptIds', 'resetAt'])
  )
    return undefined
  const day = dataValue(raw, 'day')
  const bytes = dataValue(raw, 'bytes')
  const count = dataValue(raw, 'count')
  const creditedReceiptIds = dataValue(raw, 'creditedReceiptIds')
  const resetAt = dataValue(raw, 'resetAt')
  if (
    !isValidDay(day) ||
    !isValidAmount(bytes) ||
    !isValidAmount(count) ||
    !Array.isArray(creditedReceiptIds) ||
    creditedReceiptIds.length > MAX_DAILY_BUDGET_RECEIPTS ||
    !creditedReceiptIds.every(isValidReceiptId) ||
    new Set(creditedReceiptIds).size !== creditedReceiptIds.length ||
    !isValidAmount(resetAt)
  )
    return undefined
  return { day, bytes, count, creditedReceiptIds, resetAt }
}

const decodeOldestRecord = (raw: unknown): BudgetRecord | undefined => {
  if (!isPlainRecord(raw) || !hasExactDataKeys(raw, ['day', 'bytes', 'count'])) return undefined
  const day = dataValue(raw, 'day')
  const bytes = dataValue(raw, 'bytes')
  const count = dataValue(raw, 'count')
  if (!isValidDay(day) || !isValidAmount(bytes) || !isValidAmount(count)) return undefined
  return {
    day,
    bytes,
    count,
    creditedReceiptIds: [],
    resetAt: 0,
  }
}

export type StoredBudgetRecordDecode =
  | { readonly kind: 'absent'; readonly record: BudgetRecord }
  | { readonly kind: 'current'; readonly record: BudgetRecord }
  | { readonly kind: 'legacy'; readonly record: BudgetRecord }
  | { readonly kind: 'stale'; readonly record: BudgetRecord }
  | { readonly kind: 'corrupt' }

/**
 * Classify one persisted value. Corrupt input carries no replacement record, so
 * ordinary reads cannot accidentally overwrite it.
 */
export function decodeStoredBudgetRecord(raw: unknown, day: string): StoredBudgetRecordDecode {
  if (raw === null || raw === undefined) return { kind: 'absent', record: emptyBudgetRecord(day) }
  try {
    if (!isPlainRecord(raw) || !isJsonWithinByteBudget(raw, MAX_DAILY_BUDGET_STORE_BYTES))
      return { kind: 'corrupt' }

    if (Object.hasOwn(raw, 'version')) {
      if (!hasExactDataKeys(raw, ['version', 'record'])) return { kind: 'corrupt' }
      if (dataValue(raw, 'version') !== DAILY_BUDGET_STORE_VERSION) return { kind: 'corrupt' }
      const record = decodeRecord(dataValue(raw, 'record'))
      if (record === undefined) return { kind: 'corrupt' }
      return record.day === day
        ? { kind: 'current', record }
        : { kind: 'stale', record: emptyBudgetRecord(day) }
    }

    const record = decodeOldestRecord(raw) ?? decodeRecord(raw)
    if (record === undefined) return { kind: 'corrupt' }
    if (record.day !== day) return { kind: 'stale', record: emptyBudgetRecord(day) }
    const migrated = { version: DAILY_BUDGET_STORE_VERSION, record } satisfies StoredBudgetRecord
    return isJsonWithinByteBudget(migrated, MAX_DAILY_BUDGET_STORE_BYTES)
      ? { kind: 'legacy', record }
      : { kind: 'corrupt' }
  } catch {
    return { kind: 'corrupt' }
  }
}

export const isBudgetRecordWithinBounds = (record: BudgetRecord): boolean => {
  const encoded = { version: DAILY_BUDGET_STORE_VERSION, record } satisfies StoredBudgetRecord
  return (
    decodeRecord(record) !== undefined &&
    isJsonWithinByteBudget(encoded, MAX_DAILY_BUDGET_STORE_BYTES)
  )
}

const MAXIMALLY_ESCAPED_CONTROL_CODES = [
  0, 1, 2, 3, 4, 5, 6, 7, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
] as const

const maximallyEscapedReceiptId = (ordinal: number): string => {
  const units = Array<number>(MAX_RECEIPT_ID_LENGTH).fill(0)
  let remaining = ordinal
  for (let index = units.length - 1; remaining > 0; index -= 1) {
    units[index] =
      MAXIMALLY_ESCAPED_CONTROL_CODES[remaining % MAXIMALLY_ESCAPED_CONTROL_CODES.length]!
    remaining = Math.floor(remaining / MAXIMALLY_ESCAPED_CONTROL_CODES.length)
  }
  return String.fromCharCode(...units)
}

const worstCaseUnusedReceiptId = (record: BudgetRecord): string => {
  const used = new Set(record.creditedReceiptIds)
  for (let index = 0; index <= MAX_DAILY_BUDGET_RECEIPTS; index += 1) {
    const candidate = maximallyEscapedReceiptId(index)
    if (!used.has(candidate)) return candidate
  }
  throw new Error('Daily Budget receipt identity space is exhausted')
}

/** True when one more valid terminal can always fit in the durable envelope. */
export const hasBudgetReceiptHeadroom = (record: BudgetRecord): boolean =>
  record.creditedReceiptIds.length < MAX_DAILY_BUDGET_RECEIPTS &&
  isBudgetRecordWithinBounds({
    ...record,
    bytes: Number.MAX_SAFE_INTEGER,
    count: Number.MAX_SAFE_INTEGER,
    creditedReceiptIds: [...record.creditedReceiptIds, worstCaseUnusedReceiptId(record)],
  })

/** Encode only the strict bounded v1 storage shape. */
export const encodeBudgetRecord = (record: BudgetRecord): StoredBudgetRecord => {
  const encoded = { version: DAILY_BUDGET_STORE_VERSION, record } satisfies StoredBudgetRecord
  if (!isBudgetRecordWithinBounds(record))
    throw new TypeError('Daily Budget record cannot be persisted')
  return encoded
}
