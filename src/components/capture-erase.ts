import { Option, Schema } from 'effect'
import { browser } from 'wxt/browser'
import { erasedArchiveCopy, eraseFailedCopy } from './capture-copy'

export interface EraseOutcome {
  readonly ok: boolean
  readonly detail: string
}

type EraseReply = { readonly cleared?: number } | null | undefined

const decodeClearedReply = Schema.decodeUnknownOption(Schema.Struct({ cleared: Schema.Number }))

const sendClearCapture = (): Promise<EraseReply> =>
  browser.runtime.sendMessage({ _tag: 'ClearCaptureRequest' })

/** Ask the worker to erase the archive. The erase counts as done only when the
 *  worker answers with the number it cleared. */
export async function runCaptureErase(
  tweets: number,
  send: () => Promise<EraseReply> = sendClearCapture,
): Promise<EraseOutcome> {
  try {
    const reply = await send()
    if (Option.isSome(decodeClearedReply(reply)))
      return { ok: true, detail: erasedArchiveCopy(tweets) }
  } catch {
    return { ok: false, detail: eraseFailedCopy }
  }
  return { ok: false, detail: eraseFailedCopy }
}
