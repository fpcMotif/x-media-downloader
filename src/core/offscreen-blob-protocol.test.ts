import { describe, expect, it, vi } from 'vitest'
import {
  OFFSCREEN_BLOB_CHUNK_BYTES,
  OFFSCREEN_BLOB_ERROR_MAX_LENGTH,
  OFFSCREEN_BLOB_LEASE_ID_MAX_LENGTH,
  OFFSCREEN_BLOB_MAX_LEASES,
  OFFSCREEN_BLOB_MIME_TYPE_MAX_LENGTH,
  isByteArray,
  isOffscreenBlobReply,
  isOffscreenBlobRequest,
} from './offscreen-blob-protocol'

describe('offscreen Blob protocol', () => {
  it('accepts only exact tagged requests', () => {
    expect(
      isOffscreenBlobRequest({ _tag: 'OffscreenBlobBegin', leaseId: 'a', mimeType: 'image/jpeg' }),
    ).toBe(true)
    expect(isOffscreenBlobRequest({ _tag: 'OffscreenBlobList' })).toBe(true)
    expect(isOffscreenBlobRequest({ _tag: 'OffscreenBlobList', extra: true })).toBe(false)
    expect(
      isOffscreenBlobRequest({ _tag: 'OffscreenBlobAppend', leaseId: 'a', bytes: [0, 255] }),
    ).toBe(true)
    expect(isOffscreenBlobRequest({ _tag: 'OffscreenBlobAppend', leaseId: 'a', bytes: [-1] })).toBe(
      false,
    )
  })

  it('caps and validates byte arrays', () => {
    expect(isByteArray(Array.from(new Uint8Array(OFFSCREEN_BLOB_CHUNK_BYTES)))).toBe(true)
    expect(isByteArray(Array.from(new Uint8Array(OFFSCREEN_BLOB_CHUNK_BYTES + 1)))).toBe(false)
    expect(isByteArray([1.5])).toBe(false)
    expect(isByteArray([])).toBe(false)
    expect(isByteArray(Array.from({ length: 1 }))).toBe(false)
  })

  it('rejects accessors and oversized protocol text before reading it', () => {
    const message = { _tag: 'OffscreenBlobBegin', leaseId: 'a', mimeType: 'image/jpeg' }
    const getter = vi.fn<() => string>(() => 'a')
    Object.defineProperty(message, 'leaseId', { enumerable: true, get: getter })

    expect(isOffscreenBlobRequest(message)).toBe(false)
    expect(getter).not.toHaveBeenCalled()
    expect(
      isOffscreenBlobRequest({
        _tag: 'OffscreenBlobBegin',
        leaseId: 'x'.repeat(OFFSCREEN_BLOB_LEASE_ID_MAX_LENGTH + 1),
        mimeType: 'image/jpeg',
      }),
    ).toBe(false)
    expect(
      isOffscreenBlobRequest({
        _tag: 'OffscreenBlobBegin',
        leaseId: 'a',
        mimeType: 'x'.repeat(OFFSCREEN_BLOB_MIME_TYPE_MAX_LENGTH + 1),
      }),
    ).toBe(false)
  })

  it('accepts only exact tagged replies', () => {
    expect(isOffscreenBlobReply({ _tag: 'OffscreenBlobOk' })).toBe(true)
    expect(isOffscreenBlobReply({ _tag: 'OffscreenBlobFinalized', objectUrl: 'blob:x' })).toBe(true)
    expect(isOffscreenBlobReply({ _tag: 'OffscreenBlobError', reason: '' })).toBe(false)
    expect(isOffscreenBlobReply({ _tag: 'OffscreenBlobOk', extra: true })).toBe(false)
    expect(
      isOffscreenBlobReply({
        _tag: 'OffscreenBlobLeases',
        leaseIds: Array.from({ length: OFFSCREEN_BLOB_MAX_LEASES + 1 }, (_, index) => `${index}`),
      }),
    ).toBe(false)
    expect(
      isOffscreenBlobReply({
        _tag: 'OffscreenBlobError',
        reason: 'x'.repeat(OFFSCREEN_BLOB_ERROR_MAX_LENGTH + 1),
      }),
    ).toBe(false)
  })
})
