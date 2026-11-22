// Shared Knowledge Capture export, used by the options panel AND the popup.
//
// The MV3 service worker can't mint blob: URLs, so it only BUILDS the artifact
// text (ExportCaptureRequest → { ok, filename, text }); the download happens here
// in an extension PAGE, which has a DOM, URL.createObjectURL, and chrome.downloads.
// Heavily logged ([XMD] capture-export …) so a failed click is diagnosable from
// the page console without guessing.

import { Option, Schema } from 'effect'

export type CaptureExportKind = 'jsonl' | 'tree' | 'markdown'

interface ExportResponse {
  readonly ok?: boolean
  readonly filename?: string
  readonly text?: string
}

export interface ExportOutcome {
  readonly ok: boolean
  readonly detail: string
}

/** Shared with `diagnostics-export.ts` — both extension-side "build text in the
 *  SW, download it here" exports gate on the same non-empty-string check. */
export const isNonEmptyString = (v: string | undefined): v is string =>
  typeof v === 'string' && v.length > 0

const ExportChunkReplySchema = Schema.Struct({
  lines: Schema.String,
  next: Schema.optional(Schema.NullOr(Schema.String)),
  filename: Schema.optional(Schema.String),
})
export type ExportChunkResponse = typeof ExportChunkReplySchema.Type

export type RequestExportChunk = (after?: string) => Promise<Option.Option<ExportChunkResponse>>

export type JsonlCollection =
  | { readonly kind: 'ready'; readonly filename: string; readonly chunks: ReadonlyArray<string> }
  | { readonly kind: 'empty' }
  | { readonly kind: 'unreachable' }

export function collectJsonlExport(requestChunk: RequestExportChunk): Promise<JsonlCollection> {
  const chunks: string[] = []
  const collectFrom = async (after?: string): Promise<JsonlCollection> => {
    const res = await requestChunk(after).catch(() => Option.none<ExportChunkResponse>())
    if (Option.isNone(res)) return { kind: 'unreachable' }
    const reply = res.value
    if (reply.lines !== '') chunks.push(reply.lines)
    if (reply.next !== undefined && reply.next !== null) return collectFrom(reply.next)
    if (chunks.length === 0) return { kind: 'empty' }
    return { kind: 'ready', filename: reply.filename ?? 'xharvest.jsonl', chunks }
  }
  return collectFrom(undefined)
}

const decodeExportChunkReply = Schema.decodeUnknownOption(ExportChunkReplySchema)

const requestChunkFromWorker: RequestExportChunk = (after) =>
  browser.runtime
    .sendMessage(
      after === undefined
        ? { _tag: 'ExportCaptureChunkRequest' }
        : { _tag: 'ExportCaptureChunkRequest', after },
    )
    .then(decodeExportChunkReply)
    .catch(() => Option.none<ExportChunkResponse>())

function saveExport(filename: string, parts: BlobPart[], bytes: number): ExportOutcome {
  const url = URL.createObjectURL(new Blob(parts, { type: 'application/octet-stream' }))

  // A synthetic <a download> click fires the download on the button's user
  // gesture — reliable in both the options tab AND the popup, with no Save dialog
  // (a dialog would close the popup on focus loss and cancel the download). The
  // file lands silently in the browser's Downloads folder; the returned detail
  // tells the user where to look.
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
  console.info(`[XMD] capture-export <a download> fired → ${filename} (${bytes} bytes)`)
  return { ok: true, detail: `Exported ${filename} — check your Downloads folder.` }
}

export async function runCaptureExport(
  kind: CaptureExportKind,
  conversationId?: string,
): Promise<ExportOutcome> {
  console.info(`[XMD] capture-export click kind=${kind} conv=${conversationId ?? '-'}`)
  if (kind === 'jsonl') return runJsonlExport(requestChunkFromWorker)

  let res: ExportResponse | null = null
  try {
    // `browser.runtime.sendMessage`'s reply types as `any` (the polyfill has no way to
    // know the background's response shape), so this is a plain annotation, not a
    // cast: `any` is assignable to any declared type without an assertion. The
    // background's `ExportCaptureRequest` handler always answers `{ ok, filename,
    // text }` via `sendResponse` (or the channel dies and this throws instead);
    // every field is read defensively below regardless.
    res = await browser.runtime.sendMessage({
      _tag: 'ExportCaptureRequest',
      kind,
      conversationId,
    })
  } catch (err) {
    console.error('[XMD] capture-export sendMessage threw', err)
    return { ok: false, detail: 'Could not reach the extension worker.' }
  }

  console.info('[XMD] capture-export response', {
    ok: res?.ok,
    filename: res?.filename,
    bytes: res?.text?.length ?? 0,
  })
  if (!res?.ok || !isNonEmptyString(res.text)) {
    return { ok: false, detail: 'Nothing harvested yet — turn on Capture and browse X.' }
  }

  return saveExport(res.filename ?? 'xharvest.jsonl', [res.text], res.text.length)
}

export async function runJsonlExport(requestChunk: RequestExportChunk): Promise<ExportOutcome> {
  const collected = await collectJsonlExport(requestChunk)
  if (collected.kind === 'unreachable') {
    return { ok: false, detail: 'Could not reach the extension worker.' }
  }
  if (collected.kind === 'empty') {
    return { ok: false, detail: 'Nothing harvested yet — turn on Capture and browse X.' }
  }
  const parts = collected.chunks.flatMap((chunk, i) => (i === 0 ? [chunk] : ['\n', chunk]))
  let bytes = 0
  for (const chunk of collected.chunks) bytes += chunk.length
  return saveExport(collected.filename, parts, bytes)
}

export interface CaptureSummary {
  readonly tweets: number
  readonly conversations: number
  readonly recent: ReadonlyArray<{
    readonly conversationId: string
    readonly rootHandle: string
    readonly rootText: string
    readonly count: number
    readonly lastAt: number
  }>
}

export const EMPTY_CAPTURE_SUMMARY = {
  tweets: 0,
  conversations: 0,
  recent: [],
} satisfies CaptureSummary

/** `limit` caps the `recent` list: 0 = counts only (popup), omitted = background
 *  default, large = the options archive browser. */
export const fetchCaptureSummary = (limit?: number): Promise<CaptureSummary> =>
  browser.runtime
    .sendMessage(
      limit === undefined
        ? { _tag: 'CaptureSummaryRequest' }
        : { _tag: 'CaptureSummaryRequest', limit },
    )
    .then((s: CaptureSummary | null | undefined) => {
      // `browser.runtime.sendMessage`'s reply types as `any`, so this is a plain
      // annotation, not a cast. The background's `CaptureSummaryRequest` handler
      // always answers `{ tweets, conversations, recent }` via `sendResponse`. A dead
      // channel or an empty reply rejects the promise, and `useLoaded` reports `Failed`.
      if (s === null || s === undefined)
        throw new Error('The extension worker returned no capture summary.')
      return s
    })

const CaptureSearchResultSchema = Schema.Struct({
  total: Schema.Number,
  matches: Schema.Array(
    Schema.Struct({
      conversationId: Schema.String,
      rootHandle: Schema.String,
      rootText: Schema.String,
      count: Schema.Number,
      lastAt: Schema.Number,
    }),
  ),
})

export type CaptureSearchResult = typeof CaptureSearchResultSchema.Type

const decodeCaptureSearchResult = Schema.decodeUnknownOption(CaptureSearchResultSchema)

export const fetchCaptureSearch = (
  query: string,
  limit: number,
): Promise<Option.Option<CaptureSearchResult>> =>
  browser.runtime
    .sendMessage({ _tag: 'CaptureSearchRequest', query, limit })
    .then(decodeCaptureSearchResult)
    .catch(() => Option.none<CaptureSearchResult>())
