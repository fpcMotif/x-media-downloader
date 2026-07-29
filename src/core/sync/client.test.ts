import { describe, expect, it } from 'vitest'
import { requestSyncStatus, requestSyncTest } from './client'

describe('sync UI client', () => {
  it('returns only exact claimed statuses', async () => {
    await expect(
      requestSyncStatus(async () => ({ ok: true, detail: 'Connected.', pending: 0 })),
    ).resolves.toEqual({ ok: true, detail: 'Connected.', pending: 0 })
  })

  it.each([
    ['unclaimed', async () => undefined],
    ['extra key', async () => ({ ok: true, detail: 'Connected.', pending: 0, stale: true })],
    ['negative pending', async () => ({ ok: true, detail: 'Connected.', pending: -1 })],
    ['fractional pending', async () => ({ ok: true, detail: 'Connected.', pending: 0.5 })],
    ['rejection', async () => Promise.reject(new Error('port closed'))],
  ])('rejects %s status replies', async (_name, send) => {
    await expect(requestSyncStatus(send)).resolves.toBeNull()
  })

  it('uses the same decoder for explicit connection tests', async () => {
    await expect(
      requestSyncTest(async () => ({ ok: false, detail: 'Unreachable.', pending: 2 })),
    ).resolves.toEqual({ ok: false, detail: 'Unreachable.', pending: 2 })
  })
})
