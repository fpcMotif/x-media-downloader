import type { JsonObject } from '@/packages/schema'
import { isJsonObject, isJsonString } from '@/core/adapters/json-predicates'
import { isFromExtensionWorker } from '@/packages/kernel/sender-guard'

// A `type` alias, not an `interface`: `isSaveRequest`'s predicate narrows from
// `JsonObject`, and only a `type`'s object-literal shape gets TypeScript's
// implicit index signature there — a same-shape `interface` fails that
// assignability with "index signature for type 'string' is missing".
type OffscreenSaveRequest = {
  readonly _tag: 'OffscreenSaveRequest'
  readonly bytes: ReadonlyArray<number>
  readonly mimeType: string
  readonly filename: string
}

// Type guard for message validation
function isSaveRequest(message: JsonObject): message is OffscreenSaveRequest {
  return (
    message._tag === 'OffscreenSaveRequest' &&
    Array.isArray(message.bytes) &&
    isJsonString(message.mimeType) &&
    isJsonString(message.filename)
  )
}

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only the background service worker may drive this download sink — it is the
  // sole sender of OffscreenSaveRequest (makeOffscreenPort.saveBlob). A content
  // script shares our extension id but carries a `tab`, and runtime.sendMessage
  // broadcasts to this document too, so reject it: least privilege.
  if (!isFromExtensionWorker(sender, browser.runtime.id)) return false

  if (!isJsonObject(message)) return false
  if (!isSaveRequest(message)) return false
  const m = message

  void (async () => {
    let objectUrl: string | null = null
    try {
      const blob = new Blob([Uint8Array.from(m.bytes)], { type: m.mimeType })
      objectUrl = URL.createObjectURL(blob)
      const downloadId = await browser.downloads.download({
        url: objectUrl,
        filename: m.filename,
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
