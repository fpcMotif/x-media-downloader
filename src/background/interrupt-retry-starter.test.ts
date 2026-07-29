import { describe, expect, it, vi } from 'vitest'
import type { ByteSource, FetchedTransferGateway } from '../core/download/fetched-transfer-contract'
import type { FetchPort, PermissionsPort } from '../core/download/fetched-strategy'
import type { DownloadsPort } from '../core/download/strategy'
import { makeInterruptRetryStarter } from './interrupt-retry-starter'

const request = {
  id: 'm1',
  url: 'https://pbs.twimg.com/a.jpg',
  filename: 'a.jpg',
}
const owner = {
  tag: 'transfer' as const,
  requestId: 'm1',
  projectionId: 'projection-1',
  attempt: 1,
  since: 2,
  priorDownloadId: 7,
}
const source = (): ByteSource => ({
  read: vi.fn<ByteSource['read']>(async () => ({ done: true })),
  cancel: vi.fn<ByteSource['cancel']>(async () => {}),
})
const gateway = (): FetchedTransferGateway => ({
  reserve: vi.fn<FetchedTransferGateway['reserve']>(async () => ({
    kind: 'reserved',
    leaseId: 'lease-1',
  })),
  awaitCaptureReservation: vi.fn<FetchedTransferGateway['awaitCaptureReservation']>(async () => ({
    kind: 'reserved',
    leaseId: 'lease-1',
  })),
  startReserved: vi.fn<FetchedTransferGateway['startReserved']>(async () => ({
    kind: 'started',
    downloadId: 42,
  })),
  start: vi.fn<FetchedTransferGateway['start']>(async () => ({
    kind: 'started' as const,
    downloadId: 42,
  })),
  releaseTerminal: vi.fn<FetchedTransferGateway['releaseTerminal']>(async () => {}),
  releaseCaptureTerminal: vi.fn<FetchedTransferGateway['releaseCaptureTerminal']>(async () => {}),
  releaseAutonomousTerminal: vi.fn<FetchedTransferGateway['releaseAutonomousTerminal']>(
    async () => {},
  ),
  observeTerminalTransfer: vi.fn<FetchedTransferGateway['observeTerminalTransfer']>(
    async () => undefined,
  ),
  retryAutonomousTerminalCleanup: vi.fn<FetchedTransferGateway['retryAutonomousTerminalCleanup']>(
    async () => {},
  ),
  discardRecoveredStaging: vi.fn<FetchedTransferGateway['discardRecoveredStaging']>(async () => {}),
  inspectOnBoot: vi.fn<FetchedTransferGateway['inspectOnBoot']>(async () => ({
    tag: 'available' as const,
    observations: [],
  })),
})

describe('makeInterruptRetryStarter', () => {
  it('restarts Fetched through its gateway, never raw browser.downloads', async () => {
    const download = vi.fn<DownloadsPort['download']>(async () => 7)
    const g = gateway()
    const starter = makeInterruptRetryStarter({
      download,
      permissions: {
        contains: vi.fn<PermissionsPort['contains']>(async () => true),
      },
      fetch: {
        fetch: async () => ({
          ok: true,
          status: 200,
          contentType: 'image/jpeg',
          contentLength: 1,
          body: source(),
        }),
      },
      gateway: g,
    })

    await expect(starter.start('fetched', request, owner)).resolves.toEqual({
      tag: 'started',
      downloadId: 42,
    })
    expect(g.start).toHaveBeenCalledWith(expect.objectContaining({ owner, filename: 'a.jpg' }))
    expect(download).not.toHaveBeenCalled()
  })

  it('restarts Direct through browser.downloads', async () => {
    const download = vi.fn<DownloadsPort['download']>(async () => 7)
    const starter = makeInterruptRetryStarter({
      download,
      permissions: {
        contains: vi.fn<PermissionsPort['contains']>(async () => true),
      },
      fetch: { fetch: async () => ({}) as never },
      gateway: gateway(),
    })

    await expect(starter.start('direct', request, owner)).resolves.toEqual({
      tag: 'started',
      downloadId: 7,
    })
    expect(download).toHaveBeenCalledWith({
      url: request.url,
      filename: request.filename,
      conflictAction: 'uniquify',
    })
  })

  it.each(['direct', 'fetched'] as const)(
    'fails invalid %s retry URLs before any egress handoff',
    async (mode) => {
      const download = vi.fn<DownloadsPort['download']>(async () => 7)
      const permissions = {
        contains: vi.fn<PermissionsPort['contains']>(async () => true),
      }
      const fetch = {
        fetch: vi.fn<FetchPort['fetch']>(async () => ({}) as never),
      }
      const g = gateway()
      const starter = makeInterruptRetryStarter({
        download,
        permissions,
        fetch,
        gateway: g,
      })

      await expect(
        starter.start(mode, { ...request, url: 'https://evil.example/private' }, owner),
      ).resolves.toEqual({ tag: 'failed' })
      expect(download).not.toHaveBeenCalled()
      expect(permissions.contains).not.toHaveBeenCalled()
      expect(fetch.fetch).not.toHaveBeenCalled()
      expect(g.start).not.toHaveBeenCalled()
    },
  )

  it('does not retry a data URL sidecar as media', async () => {
    const download = vi.fn<DownloadsPort['download']>(async () => 7)
    const starter = makeInterruptRetryStarter({
      download,
      permissions: {
        contains: vi.fn<PermissionsPort['contains']>(async () => true),
      },
      fetch: { fetch: vi.fn<FetchPort['fetch']>(async () => ({}) as never) },
      gateway: gateway(),
    })

    await expect(
      starter.start('direct', { ...request, url: 'data:application/json,{}' }, owner),
    ).resolves.toEqual({ tag: 'failed' })
    expect(download).not.toHaveBeenCalled()
  })
})
