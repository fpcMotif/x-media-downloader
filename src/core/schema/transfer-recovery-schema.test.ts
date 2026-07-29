import { describe, expect, it } from 'vitest'
import { decodeTransferRecoveryRequest, decodeTransferRecoveryResponse } from './transfer-recovery'
import { MAX_TRANSFER_REGISTRY_ID_LENGTH } from '../wire/limits'

const item = {
  id: 'media-1',
  kind: 'browser-unresolved',
  mode: 'fetched',
  createdAt: 1,
  downloadId: 2,
}

describe('transfer recovery wire', () => {
  it('accepts only exact inspect/forget requests', () => {
    expect(
      decodeTransferRecoveryRequest({
        _tag: 'TransferRecoveryRequest',
        action: 'inspect',
      }),
    ).toBeDefined()
    expect(
      decodeTransferRecoveryRequest({
        _tag: 'TransferRecoveryRequest',
        action: 'inspect',
        id: 'nope',
      }),
    ).toBeUndefined()
    expect(
      decodeTransferRecoveryRequest({
        _tag: 'TransferRecoveryRequest',
        action: 'forget',
        id: 'media-1',
        extra: true,
      }),
    ).toBeUndefined()
  })

  it('shares the transfer registry ID limit', () => {
    expect(
      decodeTransferRecoveryRequest({
        _tag: 'TransferRecoveryRequest',
        action: 'forget',
        id: 'x'.repeat(MAX_TRANSFER_REGISTRY_ID_LENGTH),
      }),
    ).toBeDefined()
    expect(
      decodeTransferRecoveryRequest({
        _tag: 'TransferRecoveryRequest',
        action: 'forget',
        id: 'x'.repeat(MAX_TRANSFER_REGISTRY_ID_LENGTH + 1),
      }),
    ).toBeUndefined()
  })

  it('rejects duplicate, cross-field, and extra recovery replies', () => {
    expect(
      decodeTransferRecoveryResponse({
        _tag: 'TransferRecovery',
        items: [item],
      }),
    ).toBeDefined()
    expect(
      decodeTransferRecoveryResponse({
        _tag: 'TransferRecovery',
        items: [item, item],
      }),
    ).toBeUndefined()
    expect(
      decodeTransferRecoveryResponse({
        _tag: 'TransferRecovery',
        items: [{ ...item, mode: 'aria2' }],
      }),
    ).toBeUndefined()
    expect(
      decodeTransferRecoveryResponse({
        _tag: 'TransferRecoveryUnavailable',
        extra: true,
      }),
    ).toBeUndefined()
  })

  it('accepts prepared holds only for current transfer modes without a handle', () => {
    for (const mode of ['direct', 'fetched', 'aria2'] as const)
      expect(
        decodeTransferRecoveryResponse({
          _tag: 'TransferRecovery',
          items: [{ id: `prepared-${mode}`, kind: 'prepared-launch', mode, createdAt: 1 }],
        }),
      ).toBeDefined()
    expect(
      decodeTransferRecoveryResponse({
        _tag: 'TransferRecovery',
        items: [{ id: 'prepared-legacy', kind: 'prepared-launch', mode: 'legacy', createdAt: 1 }],
      }),
    ).toBeUndefined()
    expect(
      decodeTransferRecoveryResponse({
        _tag: 'TransferRecovery',
        items: [
          {
            id: 'prepared-handle',
            kind: 'prepared-launch',
            mode: 'direct',
            createdAt: 1,
            downloadId: 2,
          },
        ],
      }),
    ).toBeUndefined()
  })

  it('accepts a handle-free pending close for every transfer mode', () => {
    for (const mode of ['direct', 'fetched', 'aria2', 'legacy'] as const)
      expect(
        decodeTransferRecoveryResponse({
          _tag: 'TransferRecovery',
          items: [{ id: `pending-${mode}`, kind: 'forget-pending', mode, createdAt: 1 }],
        }),
      ).toBeDefined()
    expect(
      decodeTransferRecoveryResponse({
        _tag: 'TransferRecovery',
        items: [
          {
            id: 'pending-handle',
            kind: 'forget-pending',
            mode: 'direct',
            createdAt: 1,
            downloadId: 2,
          },
        ],
      }),
    ).toBeUndefined()
  })
})
