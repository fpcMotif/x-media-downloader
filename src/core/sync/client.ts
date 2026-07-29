import { expectReply, safeSend } from '../messaging'
import type { SyncStatusRequest, SyncTestRequest } from '../schema'
import { decodeSyncStatus, type SyncStatus } from './status'
export { decodeSyncStatus } from './status'

export type SyncStatusSender = (request: SyncStatusRequest | SyncTestRequest) => Promise<unknown>

const requestStatus = async (
  message: SyncStatusRequest | SyncTestRequest,
  send: SyncStatusSender,
): Promise<SyncStatus | null> => {
  const reply = expectReply(await safeSend(() => send(message)))
  return reply.status === 'ok' ? (decodeSyncStatus(reply.reply) ?? null) : null
}

/** Read the worker's last sync result without exposing raw runtime replies to UI callers. */
export const requestSyncStatus = (send: SyncStatusSender): Promise<SyncStatus | null> =>
  requestStatus({ _tag: 'SyncStatusRequest' }, send)

/** Run a zero-write sync probe and decode its exact result. */
export const requestSyncTest = (send: SyncStatusSender): Promise<SyncStatus | null> =>
  requestStatus({ _tag: 'SyncTestRequest' }, send)
