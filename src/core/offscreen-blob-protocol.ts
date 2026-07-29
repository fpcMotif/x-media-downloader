/**
 * The only runtime protocol shared by the MV3 worker and the offscreen page.
 * It carries bounded byte chunks; the offscreen page never receives a download
 * command or a URL from an untrusted sender.
 */
export const OFFSCREEN_BLOB_CHUNK_BYTES = 256 * 1024
/** Matches the Fetched gateway's documented per-file ceiling. */
export const OFFSCREEN_BLOB_MAX_LEASE_BYTES = 15 * 1024 * 1024
/** Blob URLs stay alive until Chrome reports a terminal download. */
export const OFFSCREEN_BLOB_MAX_LEASES = 4
export const OFFSCREEN_BLOB_MAX_TOTAL_BYTES =
  OFFSCREEN_BLOB_MAX_LEASES * OFFSCREEN_BLOB_MAX_LEASE_BYTES
export const OFFSCREEN_BLOB_LEASE_ID_MAX_LENGTH = 512
export const OFFSCREEN_BLOB_MIME_TYPE_MAX_LENGTH = 128
export const OFFSCREEN_BLOB_OBJECT_URL_MAX_LENGTH = 4_096
export const OFFSCREEN_BLOB_ERROR_MAX_LENGTH = 256

export type OffscreenBlobRequest =
  | { readonly _tag: 'OffscreenBlobBegin'; readonly leaseId: string; readonly mimeType: string }
  | {
      readonly _tag: 'OffscreenBlobAppend'
      readonly leaseId: string
      readonly bytes: ReadonlyArray<number>
    }
  | { readonly _tag: 'OffscreenBlobFinalize'; readonly leaseId: string }
  | { readonly _tag: 'OffscreenBlobDiscard'; readonly leaseId: string }
  | { readonly _tag: 'OffscreenBlobList' }

export type OffscreenBlobReply =
  | { readonly _tag: 'OffscreenBlobOk' }
  | { readonly _tag: 'OffscreenBlobFinalized'; readonly objectUrl: string }
  | { readonly _tag: 'OffscreenBlobLeases'; readonly leaseIds: ReadonlyArray<string> }
  | { readonly _tag: 'OffscreenBlobError'; readonly reason: string }

const exact = (value: unknown, keys: ReadonlyArray<string>): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  try {
    const entries = Object.keys(value)
    return (
      entries.length === keys.length &&
      keys.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        return descriptor !== undefined && 'value' in descriptor
      })
    )
  } catch {
    return false
  }
}

const boundedText = (value: unknown, maxLength: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maxLength

export const isOffscreenBlobLeaseId = (value: unknown): value is string =>
  boundedText(value, OFFSCREEN_BLOB_LEASE_ID_MAX_LENGTH)

/** Blob types are passed directly to Blob; protocol inputs never carry parameters. */
export const isOffscreenBlobMimeType = (value: unknown): value is string =>
  boundedText(value, OFFSCREEN_BLOB_MIME_TYPE_MAX_LENGTH) &&
  /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value)

export const isOffscreenBlobObjectUrl = (value: unknown): value is string =>
  boundedText(value, OFFSCREEN_BLOB_OBJECT_URL_MAX_LENGTH) && value.startsWith('blob:')

export const isOffscreenBlobErrorReason = (value: unknown): value is string =>
  boundedText(value, OFFSCREEN_BLOB_ERROR_MAX_LENGTH)

export const isByteArray = (value: unknown): value is ReadonlyArray<number> => {
  if (!Array.isArray(value) || value.length === 0 || value.length > OFFSCREEN_BLOB_CHUNK_BYTES)
    return false
  try {
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (
        descriptor === undefined ||
        !('value' in descriptor) ||
        !Number.isInteger(descriptor.value) ||
        descriptor.value < 0 ||
        descriptor.value > 255
      )
        return false
    }
    return Object.getOwnPropertyNames(value).length === value.length + 1
  } catch {
    return false
  }
}

export function isOffscreenBlobRequest(value: unknown): value is OffscreenBlobRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const tag = Object.getOwnPropertyDescriptor(value, '_tag')?.value
  if (tag === 'OffscreenBlobList') return exact(value, ['_tag'])
  if (tag === 'OffscreenBlobBegin')
    return (
      exact(value, ['_tag', 'leaseId', 'mimeType']) &&
      isOffscreenBlobLeaseId(value.leaseId) &&
      isOffscreenBlobMimeType(value.mimeType)
    )
  if (tag === 'OffscreenBlobAppend')
    return (
      exact(value, ['_tag', 'leaseId', 'bytes']) &&
      isOffscreenBlobLeaseId(value.leaseId) &&
      isByteArray(value.bytes)
    )
  return (
    (tag === 'OffscreenBlobFinalize' || tag === 'OffscreenBlobDiscard') &&
    exact(value, ['_tag', 'leaseId']) &&
    isOffscreenBlobLeaseId(value.leaseId)
  )
}

export function isOffscreenBlobReply(value: unknown): value is OffscreenBlobReply {
  if (exact(value, ['_tag']) && value._tag === 'OffscreenBlobOk') return true
  if (
    exact(value, ['_tag', 'objectUrl']) &&
    value._tag === 'OffscreenBlobFinalized' &&
    isOffscreenBlobObjectUrl(value.objectUrl)
  )
    return true
  if (
    exact(value, ['_tag', 'leaseIds']) &&
    value._tag === 'OffscreenBlobLeases' &&
    Array.isArray(value.leaseIds) &&
    value.leaseIds.length <= OFFSCREEN_BLOB_MAX_LEASES &&
    value.leaseIds.every(isOffscreenBlobLeaseId) &&
    new Set(value.leaseIds).size === value.leaseIds.length
  )
    return true
  return (
    exact(value, ['_tag', 'reason']) &&
    value._tag === 'OffscreenBlobError' &&
    isOffscreenBlobErrorReason(value.reason)
  )
}
