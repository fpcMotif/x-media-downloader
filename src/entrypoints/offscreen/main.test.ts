import { describe, expect, it, vi } from 'vitest'
import {
  OFFSCREEN_BLOB_ERROR_MAX_LENGTH,
  type OffscreenBlobReply,
  type OffscreenBlobRequest,
} from '../../core/offscreen-blob-protocol'
import { makeOffscreenBlobHandler, makeOffscreenMessageListener } from './main'

describe('offscreen Blob handler', () => {
  it.each([
    ['popup', 'popup-document-id'],
    ['options', 'options-document-id'],
  ])('rejects %s document messages before the Blob handler', (_surface, documentId) => {
    const handle = vi.fn<(request: OffscreenBlobRequest) => OffscreenBlobReply>(
      () => ({ _tag: 'OffscreenBlobOk' }) as const,
    )
    const respond = vi.fn<(reply: OffscreenBlobReply) => void>()
    const listener = makeOffscreenMessageListener('own-id', handle)

    expect(listener({ _tag: 'OffscreenBlobList' }, { id: 'own-id', documentId }, respond)).toBe(
      false,
    )
    expect(handle).not.toHaveBeenCalled()
    expect(respond).not.toHaveBeenCalled()
  })

  it('holds the URL until its matching discard', () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:lease')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const handle = makeOffscreenBlobHandler()
    expect(handle({ _tag: 'OffscreenBlobBegin', leaseId: 'a', mimeType: 'image/jpeg' })).toEqual({
      _tag: 'OffscreenBlobOk',
    })
    expect(handle({ _tag: 'OffscreenBlobAppend', leaseId: 'a', bytes: [1, 2] })).toEqual({
      _tag: 'OffscreenBlobOk',
    })
    expect(handle({ _tag: 'OffscreenBlobFinalize', leaseId: 'a' })).toEqual({
      _tag: 'OffscreenBlobFinalized',
      objectUrl: 'blob:lease',
    })
    expect(handle({ _tag: 'OffscreenBlobList' })).toEqual({
      _tag: 'OffscreenBlobLeases',
      leaseIds: ['a'],
    })
    expect(revoke).not.toHaveBeenCalled()
    expect(handle({ _tag: 'OffscreenBlobDiscard', leaseId: 'a' })).toEqual({
      _tag: 'OffscreenBlobOk',
    })
    expect(revoke).toHaveBeenCalledWith('blob:lease')
    create.mockRestore()
    revoke.mockRestore()
  })

  it('rejects unknown and duplicate leases', () => {
    const handle = makeOffscreenBlobHandler()
    expect(handle({ _tag: 'OffscreenBlobFinalize', leaseId: 'missing' })).toMatchObject({
      _tag: 'OffscreenBlobError',
    })
    handle({ _tag: 'OffscreenBlobBegin', leaseId: 'a', mimeType: 'image/jpeg' })
    expect(
      handle({ _tag: 'OffscreenBlobBegin', leaseId: 'a', mimeType: 'image/jpeg' }),
    ).toMatchObject({ _tag: 'OffscreenBlobError' })
  })

  it('does not clone retained chunks while finalizing', () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:lease')
    const handle = makeOffscreenBlobHandler()
    handle({ _tag: 'OffscreenBlobBegin', leaseId: 'a', mimeType: 'image/jpeg' })
    handle({ _tag: 'OffscreenBlobAppend', leaseId: 'a', bytes: [1, 2] })
    const copy = vi.spyOn(Uint8Array, 'from')

    handle({ _tag: 'OffscreenBlobFinalize', leaseId: 'a' })

    expect(copy).not.toHaveBeenCalled()
    copy.mockRestore()
    create.mockRestore()
  })

  it('caps leases and retained bytes, then releases that budget on discard', () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:lease')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const handle = makeOffscreenBlobHandler({ maxLeaseBytes: 2, maxLeases: 2, maxTotalBytes: 3 })

    expect(
      handle({ _tag: 'OffscreenBlobBegin', leaseId: 'a', mimeType: 'image/jpeg' }),
    ).toMatchObject({
      _tag: 'OffscreenBlobOk',
    })
    expect(
      handle({ _tag: 'OffscreenBlobBegin', leaseId: 'b', mimeType: 'image/jpeg' }),
    ).toMatchObject({
      _tag: 'OffscreenBlobOk',
    })
    expect(
      handle({ _tag: 'OffscreenBlobBegin', leaseId: 'c', mimeType: 'image/jpeg' }),
    ).toMatchObject({
      _tag: 'OffscreenBlobError',
    })
    expect(handle({ _tag: 'OffscreenBlobAppend', leaseId: 'a', bytes: [1, 2] })).toMatchObject({
      _tag: 'OffscreenBlobOk',
    })
    expect(handle({ _tag: 'OffscreenBlobAppend', leaseId: 'a', bytes: [3] })).toMatchObject({
      _tag: 'OffscreenBlobError',
    })
    expect(handle({ _tag: 'OffscreenBlobAppend', leaseId: 'b', bytes: [3, 4] })).toMatchObject({
      _tag: 'OffscreenBlobError',
    })
    expect(handle({ _tag: 'OffscreenBlobAppend', leaseId: 'b', bytes: [3] })).toMatchObject({
      _tag: 'OffscreenBlobOk',
    })
    expect(handle({ _tag: 'OffscreenBlobFinalize', leaseId: 'a' })).toMatchObject({
      _tag: 'OffscreenBlobFinalized',
    })
    handle({ _tag: 'OffscreenBlobDiscard', leaseId: 'a' })
    expect(handle({ _tag: 'OffscreenBlobAppend', leaseId: 'b', bytes: [4] })).toMatchObject({
      _tag: 'OffscreenBlobOk',
    })
    expect(revoke).toHaveBeenCalledWith('blob:lease')
    create.mockRestore()
    revoke.mockRestore()
  })

  it('contains thrown error text within the reply contract', () => {
    const respond = vi.fn<(reply: OffscreenBlobReply) => void>()
    const listener = makeOffscreenMessageListener('own-id', () => {
      throw new Error('x'.repeat(OFFSCREEN_BLOB_ERROR_MAX_LENGTH + 1))
    })

    listener({ _tag: 'OffscreenBlobList' }, { id: 'own-id' }, respond)

    expect(respond).toHaveBeenCalledWith({
      _tag: 'OffscreenBlobError',
      reason: 'offscreen Blob failed',
    })
  })
})
