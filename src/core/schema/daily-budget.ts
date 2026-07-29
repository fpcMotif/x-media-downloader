import { Result, Schema } from 'effect'
import { hasWireKeys, isWireRecord } from '../wire/exact'

const nonNegativeSafeInteger = Schema.Number.check(
  Schema.isFinite(),
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
)
const LocalDay = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/))

/** UI → background: read the background-owned daily budget tally. */
export const DailyBudgetReadRequest = Schema.TaggedStruct('DailyBudgetReadRequest', {})
export type DailyBudgetReadRequest = typeof DailyBudgetReadRequest.Type

/** UI → background: reset the background-owned daily budget tally. */
export const DailyBudgetResetRequest = Schema.TaggedStruct('DailyBudgetResetRequest', {})
export type DailyBudgetResetRequest = typeof DailyBudgetResetRequest.Type

/** The intentionally small budget view exposed outside the background. */
export const DailyBudgetUsage = Schema.Struct({
  day: LocalDay,
  bytes: nonNegativeSafeInteger,
  count: nonNegativeSafeInteger,
})
export type DailyBudgetUsage = typeof DailyBudgetUsage.Type

export const DailyBudgetReadSuccess = Schema.TaggedStruct('DailyBudgetReadSuccess', {
  usage: DailyBudgetUsage,
})
export type DailyBudgetReadSuccess = typeof DailyBudgetReadSuccess.Type

export const DailyBudgetResetSuccess = Schema.TaggedStruct('DailyBudgetResetSuccess', {
  usage: DailyBudgetUsage,
})
export type DailyBudgetResetSuccess = typeof DailyBudgetResetSuccess.Type

/** Storage or boot failed. This must never be rendered as zero usage. */
export const DailyBudgetUnavailable = Schema.TaggedStruct('DailyBudgetUnavailable', {})
export type DailyBudgetUnavailable = typeof DailyBudgetUnavailable.Type

export const DailyBudgetReadResponse = Schema.Union([
  DailyBudgetReadSuccess,
  DailyBudgetUnavailable,
])
export type DailyBudgetReadResponse = typeof DailyBudgetReadResponse.Type

export const DailyBudgetResetResponse = Schema.Union([
  DailyBudgetResetSuccess,
  DailyBudgetUnavailable,
])
export type DailyBudgetResetResponse = typeof DailyBudgetResetResponse.Type

/** Exact guards for the UI-only no-payload budget requests. */
export const decodeDailyBudgetReadRequest = (value: unknown): DailyBudgetReadRequest | undefined =>
  isWireRecord(value) && value._tag === 'DailyBudgetReadRequest' && hasWireKeys(value, ['_tag'])
    ? (value as DailyBudgetReadRequest)
    : undefined

export const decodeDailyBudgetResetRequest = (
  value: unknown,
): DailyBudgetResetRequest | undefined =>
  isWireRecord(value) && value._tag === 'DailyBudgetResetRequest' && hasWireKeys(value, ['_tag'])
    ? (value as DailyBudgetResetRequest)
    : undefined

const decodeDailyBudgetUsage = (value: unknown): DailyBudgetUsage | undefined => {
  if (!isWireRecord(value) || !hasWireKeys(value, ['day', 'bytes', 'count'])) return undefined
  const decoded = Schema.decodeUnknownResult(DailyBudgetUsage)(value)
  return Result.isSuccess(decoded) ? decoded.success : undefined
}

/** Decode the worker's small public usage reply exactly. */
export const decodeDailyBudgetReadResponse = (
  value: unknown,
): DailyBudgetReadResponse | undefined => {
  if (!isWireRecord(value)) return undefined
  if (value._tag === 'DailyBudgetUnavailable')
    return hasWireKeys(value, ['_tag']) ? (value as DailyBudgetUnavailable) : undefined
  if (value._tag !== 'DailyBudgetReadSuccess' || !hasWireKeys(value, ['_tag', 'usage']))
    return undefined
  const usage = decodeDailyBudgetUsage(value.usage)
  return usage === undefined ? undefined : { _tag: 'DailyBudgetReadSuccess', usage }
}

export const decodeDailyBudgetResetResponse = (
  value: unknown,
): DailyBudgetResetResponse | undefined => {
  if (!isWireRecord(value)) return undefined
  if (value._tag === 'DailyBudgetUnavailable')
    return hasWireKeys(value, ['_tag']) ? (value as DailyBudgetUnavailable) : undefined
  if (value._tag !== 'DailyBudgetResetSuccess' || !hasWireKeys(value, ['_tag', 'usage']))
    return undefined
  const usage = decodeDailyBudgetUsage(value.usage)
  return usage === undefined ? undefined : { _tag: 'DailyBudgetResetSuccess', usage }
}
