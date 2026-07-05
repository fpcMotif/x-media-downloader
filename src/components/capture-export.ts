// Shared Knowledge Capture export, used by the options panel AND the popup.
//
// The MV3 service worker can't mint blob: URLs, so it only BUILDS the artifact
// text (ExportCaptureRequest → { ok, filename, text }); the download happens here
// in an extension PAGE, which has a DOM, URL.createObjectURL, and chrome.downloads.
// Heavily logged ([XMD] capture-export …) so a failed click is diagnosable from
// the page console without guessing.

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

export async function runCaptureExport(
  kind: CaptureExportKind,
  conversationId?: string,
): Promise<ExportOutcome> {
  console.info(`[XMD] capture-export click kind=${kind} conv=${conversationId ?? '-'}`)

  let res: ExportResponse | null = null
  try {
    res = (await browser.runtime.sendMessage({
      _tag: 'ExportCaptureRequest',
      kind,
      conversationId,
    })) as ExportResponse | null
  } catch (err) {
    console.error('[XMD] capture-export sendMessage threw', err)
    return { ok: false, detail: 'Could not reach the extension worker.' }
  }

  console.info('[XMD] capture-export response', {
    ok: res?.ok,
    filename: res?.filename,
    bytes: res?.text?.length ?? 0,
  })
  if (!res?.ok || typeof res.text !== 'string' || res.text.length === 0) {
    return { ok: false, detail: 'Nothing harvested yet — turn on Capture and browse X.' }
  }

  const filename = res.filename ?? 'xharvest.jsonl'
  const url = URL.createObjectURL(new Blob([res.text], { type: 'application/octet-stream' }))

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
  console.info(`[XMD] capture-export <a download> fired → ${filename} (${res.text.length} bytes)`)
  return { ok: true, detail: `Exported ${filename} — check your Downloads folder.` }
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

/** `limit` caps the `recent` list: 0 = counts only (popup), omitted = background
 *  default, large = the options archive browser. */
export const fetchCaptureSummary = (limit?: number): Promise<CaptureSummary | null> =>
  browser.runtime
    .sendMessage(
      limit === undefined
        ? { _tag: 'CaptureSummaryRequest' }
        : { _tag: 'CaptureSummaryRequest', limit },
    )
    .then((s) => (s as CaptureSummary | null) ?? null)
    .catch(() => null)
