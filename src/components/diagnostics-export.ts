// Ticket #60: Release diagnostics export, mirrors capture-export.ts's split almost
// exactly and for the same reason — the MV3 service worker can't mint blob: URLs, so
// it only BUILDS the artifact text (ExportDiagnosticsRequest → { ok, filename, text });
// the download happens here in an extension PAGE, which has a DOM,
// URL.createObjectURL, and chrome.downloads. Heavily logged ([XMD] release-diag-export
// …) so a failed click is diagnosable from the page console without guessing.

import type { ExportOutcome } from './capture-export'

interface ExportResponse {
  readonly ok?: boolean
  readonly filename?: string
  readonly text?: string
}

export async function runDiagnosticsExport(): Promise<ExportOutcome> {
  console.info('[XMD] release-diag-export click')

  let res: ExportResponse | null = null
  try {
    res = (await browser.runtime.sendMessage({
      _tag: 'ExportDiagnosticsRequest',
    })) as ExportResponse | null
  } catch (err) {
    console.error('[XMD] release-diag-export sendMessage threw', err)
    return { ok: false, detail: 'Could not reach the extension worker.' }
  }

  console.info('[XMD] release-diag-export response', {
    ok: res?.ok,
    filename: res?.filename,
    bytes: res?.text?.length ?? 0,
  })
  if (!res?.ok || typeof res.text !== 'string' || res.text.length === 0) {
    return { ok: false, detail: 'No Release diagnostics recorded yet — run a Release first.' }
  }

  const filename = res.filename ?? 'xmd-release-diagnostics.jsonl'
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
  console.info(
    `[XMD] release-diag-export <a download> fired → ${filename} (${res.text.length} bytes)`,
  )
  return { ok: true, detail: `Exported ${filename} — check your Downloads folder.` }
}
