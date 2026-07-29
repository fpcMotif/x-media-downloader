import { Result, Schema } from 'effect'
import { expectReply, safeSend } from '../messaging'
import type { CloudUploadStatus } from './status'
import {
  decodeCloudBackfillResponse,
  decodeCloudConnectResponse,
  type CloudBackfillRequest,
  type CloudBackfillResponse,
  type CloudConnectRequest,
  type CloudConnectResponse,
  type CloudStatusRequest,
} from '../schema'
import { hasWireKeys } from '../wire/exact'
import { MAX_DIAGNOSTIC_TEXT_LENGTH } from '../diagnostic-text'

export type CloudConnectSender = (request: CloudConnectRequest) => Promise<unknown>
export type CloudBackfillSender = (request: CloudBackfillRequest) => Promise<unknown>
export type CloudStatusSender = (request: CloudStatusRequest) => Promise<unknown>

const UploadSummaryReply = Schema.Struct({
  pending: Schema.Number,
  uploading: Schema.Number,
  succeeded: Schema.Number,
  failed: Schema.Number,
  dead: Schema.Number,
  skipped: Schema.Number,
})
const CloudStatusReply = Schema.Struct({
  summary: UploadSummaryReply,
  lastError: Schema.Union([
    Schema.Null,
    Schema.String.check(Schema.isMaxLength(MAX_DIAGNOSTIC_TEXT_LENGTH)),
  ]),
})
const isCount = (value: number): boolean => Number.isSafeInteger(value) && value >= 0
export const decodeCloudStatus = (value: unknown): CloudUploadStatus | undefined => {
  if (
    !hasWireKeys(value, ['summary', 'lastError']) ||
    !hasWireKeys(value.summary, ['pending', 'uploading', 'succeeded', 'failed', 'dead', 'skipped'])
  )
    return undefined
  const decoded = Schema.decodeUnknownResult(CloudStatusReply)(value)
  if (Result.isFailure(decoded) || !Object.values(decoded.success.summary).every(isCount))
    return undefined
  return decoded.success
}

/** Send OAuth intent and expose only an exact, claimed reply to the UI. */
export const requestCloudConnect = async (
  request: CloudConnectRequest,
  send: CloudConnectSender,
): Promise<CloudConnectResponse | undefined> => {
  const reply = expectReply(await safeSend(() => send(request)))
  return reply.status === 'ok' ? decodeCloudConnectResponse(reply.reply) : undefined
}

/** Send history-backfill intent and expose only an exact, claimed reply to the UI. */
export const requestCloudBackfill = async (
  send: CloudBackfillSender,
): Promise<CloudBackfillResponse | undefined> => {
  const reply = expectReply(await safeSend(() => send({ _tag: 'CloudBackfillRequest' })))
  return reply.status === 'ok' ? decodeCloudBackfillResponse(reply.reply) : undefined
}

/** Read the upload ledger through an exact runtime decoder. */
export const requestCloudStatus = async (
  send: CloudStatusSender,
): Promise<CloudUploadStatus | null> => {
  const reply = expectReply(await safeSend(() => send({ _tag: 'CloudStatusRequest' })))
  return reply.status === 'ok' ? (decodeCloudStatus(reply.reply) ?? null) : null
}
