import { describe, expect, it } from 'vitest'
import {
  decodeCloudBackfillResponse,
  decodeCloudConnectRequest,
  decodeCloudConnectResponse,
  decodeCloudDisconnectRequest,
  decodeCloudRequest,
  decodeCloudStatusRequest,
  decodeSyncStatusRequest,
} from './cloud'
import { MAX_CLOUD_ACCOUNT_LENGTH, MAX_OAUTH_CLIENT_ID_LENGTH } from './settings'

describe('cloud request contract', () => {
  it('accepts a capped client id and rejects one character over', () => {
    expect(
      decodeCloudConnectRequest({
        _tag: 'CloudConnectRequest',
        provider: 'gdrive',
        clientId: 'x'.repeat(MAX_OAUTH_CLIENT_ID_LENGTH),
      }),
    ).toMatchObject({ provider: 'gdrive' })
    expect(
      decodeCloudConnectRequest({
        _tag: 'CloudConnectRequest',
        provider: 'gdrive',
        clientId: 'x'.repeat(MAX_OAUTH_CLIENT_ID_LENGTH + 1),
      }),
    ).toBeUndefined()
  })

  it('rejects unknown fields on each cloud request shape', () => {
    expect(
      decodeCloudConnectRequest({
        _tag: 'CloudConnectRequest',
        provider: 'gdrive',
        clientId: 'client',
        extra: true,
      }),
    ).toBeUndefined()
    expect(
      decodeCloudDisconnectRequest({
        _tag: 'CloudDisconnectRequest',
        provider: 'gdrive',
        extra: true,
      }),
    ).toBeUndefined()
    expect(decodeCloudStatusRequest({ _tag: 'CloudStatusRequest', extra: true })).toBeUndefined()
    expect(decodeSyncStatusRequest({ _tag: 'SyncStatusRequest', extra: true })).toBeUndefined()
    expect(decodeCloudRequest({ _tag: 'CloudBackfillRequest', extra: true })).toBeUndefined()
  })
})

describe('cloud reply contract', () => {
  it('accepts capped reply text and rejects one character over', () => {
    const text = 'x'.repeat(MAX_CLOUD_ACCOUNT_LENGTH)
    expect(decodeCloudConnectResponse({ ok: true, detail: text, account: text })).toEqual({
      ok: true,
      detail: text,
      account: text,
    })
    expect(
      decodeCloudConnectResponse({
        ok: true,
        detail: text,
        account: 'x'.repeat(MAX_CLOUD_ACCOUNT_LENGTH + 1),
      }),
    ).toBeUndefined()
    expect(
      decodeCloudBackfillResponse({
        ok: true,
        queued: 0,
        detail: 'x'.repeat(MAX_CLOUD_ACCOUNT_LENGTH + 1),
      }),
    ).toBeUndefined()
  })

  it('rejects malformed replies and unsafe queued counts', () => {
    for (const reply of [
      { ok: true, detail: 'Connected.', account: undefined },
      { ok: false, detail: 'Cancelled.', account: 'stale' },
      { ok: true, detail: 'Connected.', extra: true },
      { ok: 'true', detail: 'Connected.' },
    ])
      expect(decodeCloudConnectResponse(reply)).toBeUndefined()

    for (const reply of [
      { ok: true, queued: -1, detail: 'Queued.' },
      { ok: true, queued: 1.5, detail: 'Queued.' },
      { ok: true, queued: Number.MAX_SAFE_INTEGER + 1, detail: 'Queued.' },
      { ok: false, queued: 0, detail: 'Not queued.', extra: true },
    ])
      expect(decodeCloudBackfillResponse(reply)).toBeUndefined()
  })
})
