import { Schema } from 'effect'
import { hasWireKeys, isWireRecord } from '../wire/exact'
import { isJsonWithinByteBudget } from '../wire/json-budget'

export const MAX_HISTORY_REQUEST_BYTES = 4 * 1024

/** Durable local download history stays background-owned. */
export const HistoryRequest = Schema.TaggedStruct('HistoryRequest', {})
export type HistoryRequest = typeof HistoryRequest.Type
export const ClearHistoryRequest = Schema.TaggedStruct('ClearHistoryRequest', {})
export type ClearHistoryRequest = typeof ClearHistoryRequest.Type

const decodeNoPayload = <A extends { readonly _tag: string }>(
  value: unknown,
  tag: A['_tag'],
): A | undefined =>
  isJsonWithinByteBudget(value, MAX_HISTORY_REQUEST_BYTES) &&
  isWireRecord(value) &&
  value._tag === tag &&
  hasWireKeys(value, ['_tag'])
    ? ({ _tag: tag } as A)
    : undefined

export const decodeHistoryRequest = (value: unknown): HistoryRequest | undefined =>
  decodeNoPayload<HistoryRequest>(value, 'HistoryRequest')
export const decodeClearHistoryRequest = (value: unknown): ClearHistoryRequest | undefined =>
  decodeNoPayload<ClearHistoryRequest>(value, 'ClearHistoryRequest')
