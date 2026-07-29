import { isFromExtensionWorker, type MessageSenderLike } from '../../core/sender-guard'
import {
  OFFSCREEN_BLOB_MAX_LEASE_BYTES,
  OFFSCREEN_BLOB_MAX_LEASES,
  OFFSCREEN_BLOB_MAX_TOTAL_BYTES,
  isOffscreenBlobErrorReason,
  isOffscreenBlobObjectUrl,
  isOffscreenBlobRequest,
  type OffscreenBlobReply,
  type OffscreenBlobRequest,
} from '../../core/offscreen-blob-protocol'

interface BlobParts {
  readonly mimeType: string
  /** Owned chunks, compatible with the DOM Blob BufferSource boundary. */
  readonly parts: Array<Uint8Array<ArrayBuffer>>
  bytes: number
}

interface BlobUrl {
  readonly objectUrl: string
  readonly bytes: number
}

export interface OffscreenBlobHandlerLimits {
  readonly maxLeaseBytes?: number
  readonly maxLeases?: number
  readonly maxTotalBytes?: number
}

const error = (reason: string): OffscreenBlobReply => ({
  _tag: 'OffscreenBlobError',
  reason: isOffscreenBlobErrorReason(reason) ? reason : 'offscreen Blob failed',
})

const positiveSafeInt = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid ${name}`)
  return value
}

/** In-document state only. Its lifetime deliberately matches Blob URL lifetime. */
export function makeOffscreenBlobHandler(limits: OffscreenBlobHandlerLimits = {}) {
  const maxLeaseBytes = positiveSafeInt(
    limits.maxLeaseBytes ?? OFFSCREEN_BLOB_MAX_LEASE_BYTES,
    'offscreen Blob lease limit',
  )
  const maxLeases = positiveSafeInt(
    limits.maxLeases ?? OFFSCREEN_BLOB_MAX_LEASES,
    'offscreen Blob lease count',
  )
  const maxTotalBytes = positiveSafeInt(
    limits.maxTotalBytes ?? OFFSCREEN_BLOB_MAX_TOTAL_BYTES,
    'offscreen Blob total limit',
  )
  if (maxTotalBytes < maxLeaseBytes) throw new Error('offscreen Blob total limit is too small')
  const building = new Map<string, BlobParts>()
  const urls = new Map<string, BlobUrl>()
  let retainedBytes = 0
  const discard = (leaseId: string): void => {
    const buildingLease = building.get(leaseId)
    if (buildingLease !== undefined) {
      retainedBytes -= buildingLease.bytes
      building.delete(leaseId)
    }
    const urlLease = urls.get(leaseId)
    if (urlLease !== undefined) {
      retainedBytes -= urlLease.bytes
      URL.revokeObjectURL(urlLease.objectUrl)
    }
    urls.delete(leaseId)
  }
  return (request: OffscreenBlobRequest): OffscreenBlobReply => {
    switch (request._tag) {
      case 'OffscreenBlobBegin':
        if (building.has(request.leaseId) || urls.has(request.leaseId))
          return error('lease already exists')
        if (building.size + urls.size >= maxLeases)
          return error('offscreen Blob lease limit reached')
        building.set(request.leaseId, { mimeType: request.mimeType, parts: [], bytes: 0 })
        return { _tag: 'OffscreenBlobOk' }
      case 'OffscreenBlobAppend': {
        const lease = building.get(request.leaseId)
        if (lease === undefined) return error('lease is not building')
        const bytes = request.bytes.length
        if (bytes > maxLeaseBytes - lease.bytes) return error('offscreen Blob lease is too large')
        if (bytes > maxTotalBytes - retainedBytes) return error('offscreen Blob total is too large')
        lease.parts.push(Uint8Array.from(request.bytes))
        lease.bytes += bytes
        retainedBytes += bytes
        return { _tag: 'OffscreenBlobOk' }
      }
      case 'OffscreenBlobFinalize': {
        const lease = building.get(request.leaseId)
        if (lease === undefined) return error('lease is not building')
        const objectUrl = URL.createObjectURL(
          // Blob snapshots its BufferSource inputs. The chunks already belong to
          // this document, so cloning each one here only doubles peak memory.
          new Blob(lease.parts, { type: lease.mimeType }),
        )
        if (!isOffscreenBlobObjectUrl(objectUrl)) {
          URL.revokeObjectURL(objectUrl)
          return error('offscreen Blob URL is invalid')
        }
        building.delete(request.leaseId)
        urls.set(request.leaseId, { objectUrl, bytes: lease.bytes })
        return { _tag: 'OffscreenBlobFinalized', objectUrl }
      }
      case 'OffscreenBlobDiscard':
        discard(request.leaseId)
        return { _tag: 'OffscreenBlobOk' }
      case 'OffscreenBlobList':
        return { _tag: 'OffscreenBlobLeases', leaseIds: [...building.keys(), ...urls.keys()] }
    }
  }
}

const handle = makeOffscreenBlobHandler()

export const makeOffscreenMessageListener =
  (ownId: string, blobHandler: (request: OffscreenBlobRequest) => OffscreenBlobReply = handle) =>
  (
    message: unknown,
    sender: MessageSenderLike | undefined,
    sendResponse: (reply: OffscreenBlobReply) => void,
  ): false => {
    if (!isFromExtensionWorker(sender, ownId) || !isOffscreenBlobRequest(message)) return false
    try {
      sendResponse(blobHandler(message))
    } catch (cause) {
      sendResponse(error(cause instanceof Error ? cause.message : 'offscreen Blob failed'))
    }
    return false
  }

browser.runtime.onMessage.addListener(makeOffscreenMessageListener(browser.runtime.id))
