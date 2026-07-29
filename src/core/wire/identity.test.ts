import { describe, expect, it } from 'vitest'
import { MAX_TRANSFER_PROJECTION_ID_LENGTH } from './limits'
import { isTransferProjectionId } from './identity'

describe('isTransferProjectionId', () => {
  it('owns the shared bounded transfer projection contract', () => {
    expect(isTransferProjectionId('x'.repeat(MAX_TRANSFER_PROJECTION_ID_LENGTH))).toBe(true)
    expect(isTransferProjectionId('x'.repeat(MAX_TRANSFER_PROJECTION_ID_LENGTH + 1))).toBe(false)
    expect(isTransferProjectionId(' receipt')).toBe(false)
    expect(isTransferProjectionId('receipt ')).toBe(false)
    expect(isTransferProjectionId('')).toBe(false)
  })
})
