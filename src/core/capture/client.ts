import { expectReply, safeSend } from '../messaging'
import { decodeCaptureEraseResult, type ClearCaptureRequest } from '../schema'

/** The one background request needed to erase the local capture archive. */
export type CaptureEraseSender = (request: ClearCaptureRequest) => Promise<unknown>

export type CaptureEraseOutcome =
  | { readonly ok: true; readonly cleared: number }
  | { readonly ok: false }

/**
 * Ask the background to erase captures. A fulfilled message is not success:
 * it must claim the request and return exactly one non-negative count.
 */
export const requestCaptureErase = async (
  send: CaptureEraseSender,
): Promise<CaptureEraseOutcome> => {
  const reply = expectReply(await safeSend(() => send({ _tag: 'ClearCaptureRequest' })))
  if (reply.status !== 'ok') return { ok: false }
  const result = decodeCaptureEraseResult(reply.reply)
  return result === undefined ? { ok: false } : { ok: true, cleared: result.cleared }
}
