import { describe, expect, it } from 'vitest'
import { requestCloudBackfill, requestCloudConnect, requestCloudStatus } from './client'

describe('cloud UI client', () => {
  it('returns an exact claimed OAuth reply', async () => {
    await expect(
      requestCloudConnect(
        { _tag: 'CloudConnectRequest', provider: 'gdrive', clientId: 'client-id' },
        async () => ({ ok: true, detail: 'Connected Google Drive.' }),
      ),
    ).resolves.toEqual({ ok: true, detail: 'Connected Google Drive.' })
  })

  it.each([
    ['unclaimed', async () => undefined],
    ['stale shape', async () => ({ ok: false, error: 'handler failed' })],
    ['extra key', async () => ({ ok: true, detail: 'Connected Google Drive.', extra: true })],
    ['rejection', async () => Promise.reject(new Error('port closed'))],
    ['stale context', async () => Promise.reject(new Error('Extension context invalidated'))],
  ])('rejects OAuth %s', async (_name, send) => {
    await expect(
      requestCloudConnect(
        { _tag: 'CloudConnectRequest', provider: 'gdrive', clientId: 'client-id' },
        send,
      ),
    ).resolves.toBeUndefined()
  })

  it('returns an exact claimed backfill reply', async () => {
    await expect(
      requestCloudBackfill(async () => ({
        ok: true,
        queued: 1,
        detail: 'Queued 1 upload from past downloads.',
      })),
    ).resolves.toEqual({ ok: true, queued: 1, detail: 'Queued 1 upload from past downloads.' })
  })

  it.each([
    ['unclaimed', async () => undefined],
    ['stale shape', async () => ({ detail: 'Queued uploads.' })],
    ['extra key', async () => ({ ok: true, queued: 1, detail: 'Queued uploads.', extra: true })],
    ['rejection', async () => Promise.reject(new Error('port closed'))],
  ])('rejects backfill %s', async (_name, send) => {
    await expect(requestCloudBackfill(send)).resolves.toBeUndefined()
  })

  it('returns only exact claimed upload statuses', async () => {
    await expect(
      requestCloudStatus(async () => ({
        summary: { pending: 0, uploading: 0, succeeded: 1, failed: 0, dead: 0, skipped: 0 },
        lastError: null,
      })),
    ).resolves.toEqual({
      summary: { pending: 0, uploading: 0, succeeded: 1, failed: 0, dead: 0, skipped: 0 },
      lastError: null,
    })
  })

  it.each([
    ['unclaimed', async () => undefined],
    [
      'extra key',
      async () => ({
        summary: { pending: 0, uploading: 0, succeeded: 0, failed: 0, dead: 0, skipped: 0 },
        lastError: null,
        stale: true,
      }),
    ],
    [
      'negative count',
      async () => ({
        summary: { pending: -1, uploading: 0, succeeded: 0, failed: 0, dead: 0, skipped: 0 },
        lastError: null,
      }),
    ],
    [
      'oversized diagnostic',
      async () => ({
        summary: { pending: 0, uploading: 0, succeeded: 0, failed: 0, dead: 0, skipped: 0 },
        lastError: 'x'.repeat(1_025),
      }),
    ],
  ])('rejects %s upload status replies', async (_name, send) => {
    await expect(requestCloudStatus(send)).resolves.toBeNull()
  })
})
