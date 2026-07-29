import { Result, Schema } from 'effect'
import { MAX_TRANSFER_REGISTRY_ID_LENGTH } from '../wire/limits'
import { hasWireKeys, isWireRecord } from '../wire/exact'

const nonNegativeSafeInteger = Schema.Number.check(
  Schema.isFinite(),
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
)

/** Options-only escape hatch for durable uncertain transfers. No retry action exists. */
export const TransferRecoveryKind = Schema.Literals([
  'prepared-launch',
  'unresolved-launch',
  'browser-unresolved',
  'aria2-unresolved',
  'legacy-unresolved',
  'forget-pending',
])
export const TransferRecoveryMode = Schema.Literals(['direct', 'fetched', 'aria2', 'legacy'])
const TransferRecoveryId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_TRANSFER_REGISTRY_ID_LENGTH)),
)
export const TransferRecoveryItem = Schema.Struct({
  id: TransferRecoveryId,
  kind: TransferRecoveryKind,
  mode: TransferRecoveryMode,
  createdAt: nonNegativeSafeInteger,
  downloadId: Schema.optional(nonNegativeSafeInteger),
})
export type TransferRecoveryItem = typeof TransferRecoveryItem.Type
export const TransferRecoveryRequest = Schema.Union([
  Schema.TaggedStruct('TransferRecoveryRequest', {
    action: Schema.Literal('inspect'),
  }),
  Schema.TaggedStruct('TransferRecoveryRequest', {
    action: Schema.Literal('forget'),
    id: TransferRecoveryId,
  }),
])
export type TransferRecoveryRequest = typeof TransferRecoveryRequest.Type
export const TransferRecoveryResponse = Schema.Union([
  Schema.TaggedStruct('TransferRecovery', {
    items: Schema.Array(TransferRecoveryItem).pipe(Schema.check(Schema.isMaxLength(5000))),
  }),
  Schema.TaggedStruct('TransferRecoveryUnavailable', {}),
])
export type TransferRecoveryResponse = typeof TransferRecoveryResponse.Type

const decodeTransferRecoveryItem = (value: unknown): TransferRecoveryItem | undefined => {
  if (!isWireRecord(value)) return undefined
  const hasDownloadId = Object.hasOwn(value, 'downloadId')
  if (
    !hasWireKeys(value, [
      'id',
      'kind',
      'mode',
      'createdAt',
      ...(hasDownloadId ? ['downloadId'] : []),
    ])
  )
    return undefined
  const parsed = Schema.decodeUnknownResult(TransferRecoveryItem)(value)
  if (Result.isFailure(parsed)) return undefined
  const item = parsed.success
  const needsId = item.kind === 'browser-unresolved' || item.kind === 'legacy-unresolved'
  if (needsId !== hasDownloadId) return undefined
  if (item.kind === 'prepared-launch' && item.mode === 'legacy') return undefined
  if (item.kind === 'aria2-unresolved' && item.mode !== 'aria2') return undefined
  if (item.kind === 'legacy-unresolved' && item.mode !== 'legacy') return undefined
  if (
    (item.kind === 'unresolved-launch' || item.kind === 'browser-unresolved') &&
    item.mode !== 'direct' &&
    item.mode !== 'fetched'
  )
    return undefined
  return item
}

/** Exact recovery request decoder. Never accept an extra key by stripping it. */
export const decodeTransferRecoveryRequest = (
  value: unknown,
): TransferRecoveryRequest | undefined => {
  if (!isWireRecord(value) || value._tag !== 'TransferRecoveryRequest') return undefined
  if (value.action === 'inspect' && hasWireKeys(value, ['_tag', 'action']))
    return { _tag: 'TransferRecoveryRequest', action: 'inspect' }
  if (value.action !== 'forget' || !hasWireKeys(value, ['_tag', 'action', 'id'])) return undefined
  const parsed = Schema.decodeUnknownResult(TransferRecoveryRequest)(value)
  return Result.isSuccess(parsed) ? parsed.success : undefined
}

/** Exact recovery reply decoder for Options. */
export const decodeTransferRecoveryResponse = (
  value: unknown,
): TransferRecoveryResponse | undefined => {
  if (!isWireRecord(value)) return undefined
  if (value._tag === 'TransferRecoveryUnavailable')
    return hasWireKeys(value, ['_tag']) ? { _tag: 'TransferRecoveryUnavailable' } : undefined
  if (
    value._tag !== 'TransferRecovery' ||
    !hasWireKeys(value, ['_tag', 'items']) ||
    !Array.isArray(value.items)
  )
    return undefined
  if (value.items.length > 5000) return undefined
  const items = value.items.map(decodeTransferRecoveryItem)
  if (items.some((item) => item === undefined)) return undefined
  const defined = items as TransferRecoveryItem[]
  if (new Set(defined.map((item) => item.id)).size !== defined.length) return undefined
  return { _tag: 'TransferRecovery', items: defined }
}
