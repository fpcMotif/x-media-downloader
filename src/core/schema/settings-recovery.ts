import { Result, Schema } from 'effect'
import { hasWireKeys, isWireRecord } from '../wire/exact'
import { isJsonWithinByteBudget } from '../wire/json-budget'

export const MAX_SETTINGS_RECOVERY_KEYS = 64
export const MAX_SETTINGS_RECOVERY_KEY_LENGTH = 256
export const MAX_SETTINGS_FINGERPRINT_LENGTH = 128
export const MAX_SETTINGS_RECOVERY_REQUEST_BYTES = 1_024
export const MAX_SETTINGS_RECOVERY_RESPONSE_BYTES = 48 * 1024

const boundedKey = Schema.String.check(Schema.isMaxLength(MAX_SETTINGS_RECOVERY_KEY_LENGTH))
const boundedFingerprint = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_SETTINGS_FINGERPRINT_LENGTH),
)
const boundedKeys = Schema.Array(boundedKey).pipe(
  Schema.check(Schema.isMaxLength(MAX_SETTINGS_RECOVERY_KEYS), Schema.isUnique()),
)
const nonNegativeSafeInteger = Schema.Number.check(
  Schema.isFinite(),
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
)

/** Options-only command. Repair and Reset require the inspected fingerprint. */
export const SettingsRecoveryRequest = Schema.Union([
  Schema.TaggedStruct('SettingsRecoveryRequest', {
    action: Schema.Literal('inspect'),
  }),
  Schema.TaggedStruct('SettingsRecoveryRequest', {
    action: Schema.Literals(['repair', 'reset']),
    fingerprint: boundedFingerprint,
  }),
])
export type SettingsRecoveryRequest = typeof SettingsRecoveryRequest.Type

export const SettingsRecoveryStatus = Schema.TaggedStruct('SettingsRecoveryStatus', {
  kind: Schema.Literals(['healthy', 'recoverable', 'blocked']),
  revision: nonNegativeSafeInteger,
  fingerprint: boundedFingerprint,
  invalidKeys: boundedKeys,
  unknownKeys: boundedKeys,
  truncated: Schema.Boolean,
})
export type SettingsRecoveryStatus = typeof SettingsRecoveryStatus.Type

export const SettingsRecoveryFailure = Schema.TaggedStruct('SettingsRecoveryFailure', {
  reason: Schema.Literals(['stale-snapshot', 'not-recoverable', 'unavailable']),
})
export type SettingsRecoveryFailure = typeof SettingsRecoveryFailure.Type

export const SettingsRecoveryResponse = Schema.Union([
  SettingsRecoveryStatus,
  SettingsRecoveryFailure,
])
export type SettingsRecoveryResponse = typeof SettingsRecoveryResponse.Type

export const decodeSettingsRecoveryRequest = (
  value: unknown,
): SettingsRecoveryRequest | undefined => {
  if (
    !isJsonWithinByteBudget(value, MAX_SETTINGS_RECOVERY_REQUEST_BYTES) ||
    !isWireRecord(value) ||
    value._tag !== 'SettingsRecoveryRequest'
  )
    return undefined
  if (value.action === 'inspect')
    return hasWireKeys(value, ['_tag', 'action'])
      ? { _tag: 'SettingsRecoveryRequest', action: 'inspect' }
      : undefined
  if (
    (value.action !== 'repair' && value.action !== 'reset') ||
    !hasWireKeys(value, ['_tag', 'action', 'fingerprint'])
  )
    return undefined
  const decoded = Schema.decodeUnknownResult(SettingsRecoveryRequest)(value)
  return Result.isSuccess(decoded) ? decoded.success : undefined
}

export const decodeSettingsRecoveryResponse = (
  value: unknown,
): SettingsRecoveryResponse | undefined => {
  if (!isJsonWithinByteBudget(value, MAX_SETTINGS_RECOVERY_RESPONSE_BYTES) || !isWireRecord(value))
    return undefined
  if (value._tag === 'SettingsRecoveryFailure') {
    if (!hasWireKeys(value, ['_tag', 'reason'])) return undefined
  } else if (value._tag === 'SettingsRecoveryStatus') {
    if (
      !hasWireKeys(value, [
        '_tag',
        'kind',
        'revision',
        'fingerprint',
        'invalidKeys',
        'unknownKeys',
        'truncated',
      ])
    )
      return undefined
  } else return undefined
  const decoded = Schema.decodeUnknownResult(SettingsRecoveryResponse)(value)
  return Result.isSuccess(decoded) ? decoded.success : undefined
}
