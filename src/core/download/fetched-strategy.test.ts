import { describe, expect, it, vi } from 'vitest'
import { Effect } from 'effect'
import type { ByteSource, FetchedTransferGateway } from './fetched-transfer-contract'
import {
  FETCHED_ACCESS_MISSING_REASON,
  FETCHED_HOST_PATTERNS,
  FETCHED_SIZE_LIMIT_REASON,
  MAX_FETCHED_BYTES,
  isAllowedContentType,
  makeFetchedStrategy,
  makeFetchPort,
  mimeBase,
  requestFetchedAccess,
  type FetchPort,
  type PermissionRequestPort,
  type PermissionsPort,
} from './fetched-strategy'
import type { SaveRequest } from './strategy'

const request: SaveRequest = {
  id: 'm1',
  url: 'https://pbs.twimg.com/media/a.jpg',
  filename: 'a.jpg',
}
const owner = {
  tag: 'transfer' as const,
  requestId: 'm1',
  projectionId: 'projection-1',
  attempt: 0,
  since: 1,
}
const source = (): ByteSource => ({
  read: vi.fn<ByteSource['read']>(async () => ({ done: true })),
  cancel: vi.fn<ByteSource['cancel']>(async () => {}),
})

const gateway = (
  result: Awaited<ReturnType<FetchedTransferGateway['start']>> = {
    kind: 'started',
    downloadId: 7,
  },
  opensSource = false,
): FetchedTransferGateway => ({
  reserve: vi.fn<FetchedTransferGateway['reserve']>(async () => ({
    kind: 'reserved',
    leaseId: 'lease-1',
  })),
  awaitCaptureReservation: vi.fn<FetchedTransferGateway['awaitCaptureReservation']>(async () => ({
    kind: 'reserved',
    leaseId: 'lease-1',
  })),
  startReserved: vi.fn<FetchedTransferGateway['startReserved']>(async (input) => {
    if (opensSource) await input.open()
    return result.kind === 'busy' ? { kind: 'unavailable' } : result
  }),
  start: vi.fn<FetchedTransferGateway['start']>(async (input) => {
    if (opensSource) await input.open()
    return result
  }),
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
    tag: 'available',
    observations: [],
  })),
})

const fetchPort = (body: ByteSource | null = source()): FetchPort => ({
  fetch: vi.fn<FetchPort['fetch']>(async () => ({
    ok: true,
    status: 200,
    contentType: 'image/jpeg',
    contentLength: 4,
    body,
  })),
})

describe('fetched strategy', () => {
  it('requests the exact Fetched access from a gesture-owning UI', async () => {
    const requestAccess = vi.fn<PermissionRequestPort['request']>(async () => true)

    await expect(requestFetchedAccess({ request: requestAccess })).resolves.toBe(true)

    expect(requestAccess).toHaveBeenCalledOnce()
    expect(requestAccess).toHaveBeenCalledWith({
      origins: FETCHED_HOST_PATTERNS,
    })
  })

  it('checks access, streams through its gateway, and returns the browser handle', async () => {
    const g = gateway()
    const port = fetchPort()
    const handle = await Effect.runPromise(
      makeFetchedStrategy({
        permissions: { contains: async () => true },
        fetch: port,
        gateway: g,
        ownerFor: () => owner,
      }).save(request),
    )
    expect(handle).toEqual({ kind: 'browser', id: 7 })
    expect(port.fetch).not.toHaveBeenCalled()
    const input = vi.mocked(g.start).mock.calls[0]?.[0]
    expect(input).toMatchObject({ owner, filename: 'a.jpg' })
    await expect(input?.open()).resolves.toMatchObject({
      mimeType: 'image/jpeg',
    })
    expect(port.fetch).toHaveBeenCalledOnce()
  })

  it('passes the gateway AbortSignal unchanged to the media fetch port', async () => {
    const controller = new AbortController()
    const port = fetchPort()
    const g = gateway()
    vi.mocked(g.start).mockImplementationOnce(async (input) => {
      await input.open(controller.signal)
      return { kind: 'started', downloadId: 7 }
    })

    await Effect.runPromise(
      makeFetchedStrategy({
        permissions: { contains: async () => true },
        fetch: port,
        gateway: g,
        ownerFor: () => owner,
      }).save(request),
    )

    expect(port.fetch).toHaveBeenCalledWith(request.url, controller.signal)
  })

  it('never prompts from the worker and reports missing access exactly', async () => {
    const contains = vi.fn<PermissionsPort['contains']>(async () => false)
    const permissions: PermissionsPort = { contains }
    await expect(
      Effect.runPromise(
        makeFetchedStrategy({
          permissions,
          fetch: fetchPort(),
          gateway: gateway(),
          ownerFor: () => owner,
        }).save(request),
      ),
    ).rejects.toMatchObject({ reason: FETCHED_ACCESS_MISSING_REASON })
    expect(contains).toHaveBeenCalledWith({
      origins: FETCHED_HOST_PATTERNS,
    })
  })

  it.each([
    {
      name: 'HTTP failure',
      response: {
        ok: false,
        status: 503,
        contentType: 'image/jpeg',
        contentLength: 2,
      },
      reason: 'fetch failed: HTTP 503',
    },
    {
      name: 'disallowed MIME',
      response: {
        ok: true,
        status: 200,
        contentType: 'text/html',
        contentLength: 2,
      },
      reason: 'disallowed content-type: text/html',
    },
    {
      name: 'declared oversize body',
      response: {
        ok: true,
        status: 200,
        contentType: 'image/jpeg',
        contentLength: MAX_FETCHED_BYTES + 1,
      },
      reason: FETCHED_SIZE_LIMIT_REASON,
    },
  ])('cancels the body before rejecting $name', async ({ response, reason }) => {
    const body = source()
    const g = gateway({ kind: 'started', downloadId: 7 }, true)
    const port: FetchPort = { fetch: async () => ({ ...response, body }) }

    await expect(
      Effect.runPromise(
        makeFetchedStrategy({
          permissions: { contains: async () => true },
          fetch: port,
          gateway: g,
          ownerFor: () => owner,
        }).save(request),
      ),
    ).rejects.toMatchObject({ reason })
    expect(body.cancel).toHaveBeenCalledOnce()
    expect(g.start).toHaveBeenCalledOnce()
  })

  it('reports an absent body without staging', async () => {
    const g = gateway({ kind: 'started', downloadId: 7 }, true)

    await expect(
      Effect.runPromise(
        makeFetchedStrategy({
          permissions: { contains: async () => true },
          fetch: fetchPort(null),
          gateway: g,
          ownerFor: () => owner,
        }).save(request),
      ),
    ).rejects.toMatchObject({ reason: 'fetched response has no body' })
    expect(g.start).toHaveBeenCalledOnce()
  })

  it('maps gateway cap result to the stable user reason', async () => {
    await expect(
      Effect.runPromise(
        makeFetchedStrategy({
          permissions: { contains: async () => true },
          fetch: fetchPort(),
          gateway: gateway({ kind: 'too-large' }),
          ownerFor: () => owner,
        }).save(request),
      ),
    ).rejects.toMatchObject({ reason: FETCHED_SIZE_LIMIT_REASON })
  })

  it('fences a duplicate owner as an ambiguous, non-retryable handoff', async () => {
    await expect(
      Effect.runPromise(
        makeFetchedStrategy({
          permissions: { contains: async () => true },
          fetch: fetchPort(),
          gateway: gateway({ kind: 'owner-duplicate' }),
          ownerFor: () => owner,
        }).save(request),
      ),
    ).rejects.toMatchObject({
      reason: 'Fetched transfer is already pending.',
      retryable: false,
      certainty: 'ambiguous-handoff',
    })
  })

  it('fails closed when Fetched recovery is unavailable', async () => {
    const port = fetchPort()
    await expect(
      Effect.runPromise(
        makeFetchedStrategy({
          permissions: { contains: async () => true },
          fetch: port,
          gateway: gateway({ kind: 'unavailable' }),
          ownerFor: () => owner,
        }).save(request),
      ),
    ).rejects.toMatchObject({
      reason: 'Fetched recovery is unavailable.',
      retryable: false,
    })
    expect(port.fetch).not.toHaveBeenCalled()
  })
})

describe('MIME policy', () => {
  it('accepts media/octet-stream and strips parameters', () => {
    expect(mimeBase(' image/jpeg; x=y')).toBe('image/jpeg')
    expect(isAllowedContentType('video/mp4')).toBe(true)
    expect(isAllowedContentType('application/octet-stream')).toBe(true)
    expect(isAllowedContentType('text/html')).toBe(false)
  })
})

describe('makeFetchPort', () => {
  it('uses guarded GET and forwards the exact AbortSignal', async () => {
    const controller = new AbortController()
    const seen: RequestInit[] = []
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen.push(init ?? {})
      return {
        ok: true,
        status: 200,
        redirected: false,
        type: 'default',
        headers: new Headers({
          'content-type': 'image/jpeg',
          'content-length': '4',
        }),
        body: null,
      } as Response
    }) as typeof fetch

    await makeFetchPort(fetchImpl).fetch(request.url, controller.signal)

    expect(seen).toEqual([{ signal: controller.signal, redirect: 'error' }])
  })

  it('rejects a hostile redirect without opening its body or a second URL', async () => {
    const cancel = vi.fn<() => Promise<void>>(async () => {})
    const getReader = vi.fn<() => ReadableStreamDefaultReader<Uint8Array>>()
    const fetchImpl = vi.fn<() => Promise<Response>>(async () => {
      return {
        ok: false,
        status: 302,
        redirected: false,
        type: 'default',
        headers: new Headers({ location: 'https://evil.com/steal' }),
        body: { cancel, getReader },
      } as unknown as Response
    }) as unknown as typeof fetch

    await expect(makeFetchPort(fetchImpl).fetch(request.url)).rejects.toMatchObject({
      reason: 'redirects are not allowed',
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
    expect(getReader).not.toHaveBeenCalled()
  })

  it.each(['1.5', '9007199254740992', '-1'])(
    'treats %s content-length as unknown',
    async (length) => {
      const fetchImpl = (async () =>
        ({
          ok: true,
          status: 200,
          headers: {
            get: (name: string) => (name === 'content-length' ? length : null),
          },
          body: null,
        }) as Response) as typeof fetch
      await expect(
        makeFetchPort(fetchImpl).fetch('https://pbs.twimg.com/a'),
      ).resolves.toMatchObject({
        contentLength: null,
      })
    },
  )

  it('keeps a safe integer content-length', async () => {
    const fetchImpl = (async () =>
      ({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) => (name === 'content-length' ? '1048576' : null),
        },
        body: null,
      }) as Response) as typeof fetch
    await expect(makeFetchPort(fetchImpl).fetch('https://pbs.twimg.com/a')).resolves.toMatchObject({
      contentLength: 1048576,
    })
  })
})
