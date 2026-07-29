// Shared Knowledge Capture export, used by the options panel AND the popup.
//
// The background streams a bounded artifact through the shared offscreen Blob
// gateway and hands it to Chrome. Popup/options receive only the exact outcome.
// Heavily logged ([XMD] capture-export …) so a failed click is diagnosable from
// the page console without guessing.

import { expectReply, safeSend } from '@/core/messaging'
import { DEFAULT_CAPTURE_SUMMARY_LIMIT, MAX_CAPTURE_SUMMARY_LIMIT } from '@/core/capture/contract'
import {
  decodeCaptureExportResult,
  decodeCaptureSummary,
  type CaptureExportKind,
  type CaptureExportResult,
  type ExportCaptureRequest,
  type CaptureSummary as CaptureSummaryContract,
} from '@/core/schema/capture'

export type { CaptureExportKind } from '@/core/schema/capture'

export interface ExportOutcome {
  readonly ok: boolean
  readonly detail: string
}

const EXPORT_FAILED = 'Could not build the export. Try again.'
const EXPORT_EMPTY = 'Nothing harvested yet — turn on Capture and browse X.'
const EXPORT_TOO_LARGE = 'Export exceeds the 15 MiB limit.'
const EXPORT_UNAVAILABLE = 'Export is unavailable. Other archive actions still work.'
const EXPORT_UNCERTAIN = 'Export may have started. Check your Downloads folder.'

export type CaptureExportSender = (request: ExportCaptureRequest) => Promise<unknown>

export const requestCaptureExport = async (
  kind: CaptureExportKind,
  conversationId: string | undefined,
  send: CaptureExportSender,
): Promise<CaptureExportResult | null> => {
  const request =
    conversationId === undefined
      ? { _tag: 'ExportCaptureRequest' as const, kind }
      : { _tag: 'ExportCaptureRequest' as const, kind, conversationId }
  const reply = expectReply(await safeSend(() => send(request)))
  return reply.status === 'ok' ? (decodeCaptureExportResult(reply.reply) ?? null) : null
}

export async function runCaptureExport(
  kind: CaptureExportKind,
  conversationId?: string,
): Promise<ExportOutcome> {
  console.info(`[XMD] capture-export click kind=${kind} conv=${conversationId ?? '-'}`)

  const res = await requestCaptureExport(kind, conversationId, (request) =>
    browser.runtime.sendMessage(request),
  )

  console.info('[XMD] capture-export response', {
    tag: res?._tag,
    filename: res?._tag === 'CaptureExportStarted' ? res.filename : undefined,
  })
  if (res === null) return { ok: false, detail: EXPORT_FAILED }
  if (res._tag === 'CaptureExportEmpty') return { ok: false, detail: EXPORT_EMPTY }
  if (res._tag === 'CaptureExportTooLarge') return { ok: false, detail: EXPORT_TOO_LARGE }
  if (res._tag === 'CaptureExportUnavailable') return { ok: false, detail: EXPORT_UNAVAILABLE }
  if (res._tag === 'CaptureExportUncertain') return { ok: false, detail: EXPORT_UNCERTAIN }
  if (res._tag === 'CaptureExportFailed') return { ok: false, detail: EXPORT_FAILED }
  console.info(`[XMD] capture-export download started → ${res.filename}`)
  return { ok: true, detail: `Exported ${res.filename} — check your Downloads folder.` }
}

export type CaptureSummary = CaptureSummaryContract

export type CaptureSummaryResult =
  | { readonly status: 'available'; readonly summary: CaptureSummary }
  | { readonly status: 'unavailable' }

export type CaptureSummarySender = (request: {
  readonly _tag: 'CaptureSummaryRequest'
  readonly limit?: number
}) => Promise<unknown>

/** `limit` caps the `recent` list: 0 = counts only (popup), omitted = background
 *  default, large = the options archive browser. */
export const fetchCaptureSummary = async (
  limit?: number,
  send: CaptureSummarySender = (request) => browser.runtime.sendMessage(request),
): Promise<CaptureSummaryResult> => {
  if (
    limit !== undefined &&
    (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_CAPTURE_SUMMARY_LIMIT)
  )
    return { status: 'unavailable' }
  const request =
    limit === undefined
      ? { _tag: 'CaptureSummaryRequest' as const }
      : { _tag: 'CaptureSummaryRequest' as const, limit }
  const reply = expectReply(await safeSend(() => send(request)))
  const summary =
    reply.status === 'ok'
      ? decodeCaptureSummary(reply.reply, limit ?? DEFAULT_CAPTURE_SUMMARY_LIMIT)
      : undefined
  return summary === undefined ? { status: 'unavailable' } : { status: 'available', summary }
}
