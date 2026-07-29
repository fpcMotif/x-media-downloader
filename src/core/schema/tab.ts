import { Result, Schema } from 'effect'
import { ClearTweetRequest, LocateClearTweetRequest } from './clear'
import {
  RefreshMediaUrlRequest,
  TransferOutcome,
  decodeRefreshMediaUrlRequest,
  decodeTransferOutcome,
} from './download'
import { SavedStatusUpdate, decodeSavedStatusUpdate } from './saved-status'
import { SettingsChanged } from './settings'
import { CaptureEpochChanged } from './capture'
import { hasWireKeys, isWireRecord, readWireTag } from '../wire/exact'
import { isJsonWithinByteBudget } from '../wire/json-budget'

/** Every worker → tab message is below this cap; large capture replies never use tabs. */
export const MAX_TAB_MESSAGE_BYTES = 64 * 1024

/** Popup → content page actions have no caller-controlled target. */
export const DrainPageRequest = Schema.TaggedStruct('DrainPageRequest', {})
export type DrainPageRequest = typeof DrainPageRequest.Type
export const SweepPageRequest = Schema.TaggedStruct('SweepPageRequest', {})
export type SweepPageRequest = typeof SweepPageRequest.Type

export const TAB_REQUEST_MEMBERS = [
  RefreshMediaUrlRequest,
  LocateClearTweetRequest,
  ClearTweetRequest,
  DrainPageRequest,
  SweepPageRequest,
] as const
export const TabRequest = Schema.Union(TAB_REQUEST_MEMBERS)
export type TabRequest = typeof TabRequest.Type

/** Broadcasts are worker-owned. They never enter the worker router. */
export const TabBroadcast = Schema.Union([
  TransferOutcome,
  SavedStatusUpdate,
  SettingsChanged,
  CaptureEpochChanged,
])
export type TabBroadcast = typeof TabBroadcast.Type
export const OverlayInboundMessage = Schema.Union([
  ...TAB_REQUEST_MEMBERS,
  TransferOutcome,
  SavedStatusUpdate,
])
export type OverlayInboundMessage = typeof OverlayInboundMessage.Type

const decodeExact = <A>(schema: Schema.ConstraintDecoder<A>, value: unknown): A | undefined => {
  const decoded = Schema.decodeUnknownResult(schema, {
    onExcessProperty: 'error',
  })(value)
  return Result.isSuccess(decoded) ? decoded.success : undefined
}
const decodeNoPayload = <A extends { readonly _tag: string }>(
  value: unknown,
  tag: A['_tag'],
): A | undefined =>
  isJsonWithinByteBudget(value, MAX_TAB_MESSAGE_BYTES) &&
  isWireRecord(value) &&
  value._tag === tag &&
  hasWireKeys(value, ['_tag'])
    ? ({ _tag: tag } as A)
    : undefined
const decodeExactTagged = <A>(
  schema: Schema.ConstraintDecoder<A>,
  keys: readonly string[],
  value: unknown,
): A | undefined =>
  isJsonWithinByteBudget(value, MAX_TAB_MESSAGE_BYTES) &&
  isWireRecord(value) &&
  hasWireKeys(value, keys)
    ? decodeExact(schema, value)
    : undefined

const decodeClearRequest = <A>(
  schema: Schema.ConstraintDecoder<A>,
  value: unknown,
  keys: readonly string[],
) => decodeExactTagged(schema, keys, value)

/** Cheap dispatch only. The selected decoder proves shape and byte bounds. */
export const readOverlayInboundTag = readWireTag

export const decodeOverlayInboundMessage = (value: unknown): OverlayInboundMessage | undefined => {
  const tag = readOverlayInboundTag(value)
  if (tag === undefined || !isWireRecord(value)) return undefined
  switch (tag) {
    case 'RefreshMediaUrlRequest':
      return decodeRefreshMediaUrlRequest(value)
    case 'LocateClearTweetRequest':
      return decodeClearRequest(LocateClearTweetRequest, value, [
        '_tag',
        'tweetId',
        'scopes',
        'allLists',
      ])
    case 'ClearTweetRequest':
      return decodeClearRequest(ClearTweetRequest, value, ['_tag', 'tweetId', 'scopes', 'allLists'])
    case 'DrainPageRequest':
      return decodeNoPayload<DrainPageRequest>(value, 'DrainPageRequest')
    case 'SweepPageRequest':
      return decodeNoPayload<SweepPageRequest>(value, 'SweepPageRequest')
    case 'TransferOutcome':
      return decodeTransferOutcome(value)
    case 'SavedStatusUpdate':
      return decodeSavedStatusUpdate(value)
    default:
      return undefined
  }
}
