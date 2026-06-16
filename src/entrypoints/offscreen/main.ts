interface OffscreenSaveRequest {
  readonly _tag: 'OffscreenSaveRequest'
  readonly bytes: ReadonlyArray<number>
  readonly mimeType: string
  readonly filename: string
}

function isSaveRequest(message: unknown): message is OffscreenSaveRequest {
  if (typeof message !== 'object' || message === null) return false
  const m = message as Record<string, unknown>
  return (
    m._tag === 'OffscreenSaveRequest' &&
    Array.isArray(m.bytes) &&
    typeof m.mimeType === 'string' &&
    typeof m.filename === 'string'
  )
}

browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isSaveRequest(message)) return false

  void (async () => {
    let objectUrl: string | null = null
    try {
      const blob = new Blob([Uint8Array.from(message.bytes)], { type: message.mimeType })
      objectUrl = URL.createObjectURL(blob)
      const downloadId = await browser.downloads.download({
        url: objectUrl,
        filename: message.filename,
        conflictAction: 'uniquify',
        saveAs: false,
      })
      sendResponse({ downloadId })
    } catch (cause) {
      sendResponse({ error: String(cause) })
    } finally {
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl)
    }
  })()

  return true
})
