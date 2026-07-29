import { expectReply, safeSend } from '../messaging'
import { decodeClearLogResponse, type ClearLogRecord, type ClearLogRequest } from '../schema'

export type ClearLogSender = (request: ClearLogRequest) => Promise<unknown>

export type ClearLogOutcome =
  | {
      readonly status: 'available'
      readonly records: readonly ClearLogRecord[]
    }
  | { readonly status: 'unavailable' }

/** Read verified Clear history. Lost ownership, transport errors, and malformed
 * replies are deliberately indistinguishable: none may look like an empty log. */
export const requestClearLog = async (send: ClearLogSender): Promise<ClearLogOutcome> => {
  const reply = expectReply(await safeSend(() => send({ _tag: 'ClearLogRequest' })))
  if (reply.status !== 'ok') return { status: 'unavailable' }
  const decoded = decodeClearLogResponse(reply.reply)
  if (decoded === undefined || decoded._tag === 'ClearLogUnavailable') {
    return { status: 'unavailable' }
  }
  return { status: 'available', records: decoded.records }
}
