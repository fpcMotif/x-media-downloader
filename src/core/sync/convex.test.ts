import { describe, it, expect } from 'vitest'
import { Effect, Layer, Option } from 'effect'
import {
  buildFunctionCall,
  convexOriginPattern,
  makeConvexHttpPort,
  MAX_CONVEX_RESPONSE_BYTES,
  queryDownloadedAmong,
  queryDownloadedRequestIdsAmong,
  type ConvexPort,
} from './convex'
import { classifySyncError } from './status'
import { FetchService, FetchError } from '../fetch-service'

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status })

const recordingFetch = (respond: (url: string, init?: RequestInit) => Response) => {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const layer = Layer.succeed(FetchService, {
    fetch: (url, init) => {
      calls.push({ url, init })
      return Effect.tryPromise({
        try: async () => respond(url, init),
        catch: (cause) => new FetchError({ url, cause }),
      })
    },
    fetchPromise: (async (u: string | URL, i?: RequestInit) =>
      respond(String(u), i)) as typeof fetch,
  })
  return { layer, calls }
}

const run = (
  port: ConvexPort,
  layer: Layer.Layer<FetchService>,
  args: Record<string, unknown> = {},
): Promise<unknown> =>
  Effect.runPromise(port.mutation('sync:recordEvents', args).pipe(Effect.provide(layer)))

const runQuery = (
  port: ConvexPort,
  layer: Layer.Layer<FetchService>,
  path: string,
  args: Record<string, unknown> = {},
): Promise<unknown> => Effect.runPromise(port.query(path, args).pipe(Effect.provide(layer)))

describe('buildFunctionCall', () => {
  it('builds the documented /api/mutation envelope', () => {
    expect(buildFunctionCall('sync:recordEvents', { events: [] })).toEqual({
      path: 'sync:recordEvents',
      args: { events: [] },
      format: 'json',
    })
  })
})

describe('convexOriginPattern', () => {
  it('derives a host match pattern from a deployment URL', () => {
    expect(convexOriginPattern('https://happy-otter-123.convex.cloud')).toEqual(
      Option.some('https://happy-otter-123.convex.cloud/*'),
    )
  })

  it('returns none for an unparseable url', () => {
    expect(convexOriginPattern('not a url')).toEqual(Option.none())
  })
})

describe('makeConvexHttpPort', () => {
  it('POSTs the envelope to /api/mutation and unwraps the success value', async () => {
    const { layer, calls } = recordingFetch(() =>
      jsonResponse({ status: 'success', value: { inserted: 2 } }),
    )
    const port = makeConvexHttpPort({ deploymentUrl: 'https://x.convex.cloud/' })
    expect(await run(port, layer, { events: [] })).toEqual({ inserted: 2 })
    expect(calls[0]!.url).toBe('https://x.convex.cloud/api/mutation')
    expect(calls[0]!.init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      path: 'sync:recordEvents',
      args: { events: [] },
      format: 'json',
    })
  })

  it('fails with the server errorMessage on a function error', async () => {
    const { layer } = recordingFetch(() => jsonResponse({ status: 'error', errorMessage: 'boom' }))
    await expect(
      run(makeConvexHttpPort({ deploymentUrl: 'https://x.convex.cloud' }), layer),
    ).rejects.toThrow('boom')
  })

  it('accepts the documented optional logLines and errorData fields', async () => {
    const success = recordingFetch(() =>
      jsonResponse({
        status: 'success',
        value: { inserted: 1 },
        logLines: ['recorded'],
      }),
    )
    await expect(
      run(makeConvexHttpPort({ deploymentUrl: 'https://x.convex.cloud' }), success.layer),
    ).resolves.toEqual({ inserted: 1 })

    const failed = recordingFetch(() =>
      jsonResponse({
        status: 'error',
        errorMessage: 'denied',
        errorData: { code: 'UNAUTHORIZED' },
        logLines: ['checked secret'],
      }),
    )
    await expect(
      run(makeConvexHttpPort({ deploymentUrl: 'https://x.convex.cloud' }), failed.layer),
    ).rejects.toThrow('denied')
  })

  it.each([
    {
      status: 'success',
      value: null,
      errorMessage: 'not allowed on success',
    },
    { status: 'success', value: null, logLines: [1] },
    { status: 'error', errorMessage: 'boom', errorData: [] },
    { status: 'error', errorMessage: 'boom', stale: true },
  ])('rejects a non-documented envelope %#', async (body) => {
    const { layer } = recordingFetch(() => jsonResponse(body))
    await expect(
      run(makeConvexHttpPort({ deploymentUrl: 'https://x.convex.cloud' }), layer),
    ).rejects.toThrow('malformed')
  })

  it('rejects an oversized function reply before envelope decode', async () => {
    const { layer } = recordingFetch(() => new Response('x'.repeat(MAX_CONVEX_RESPONSE_BYTES + 1)))
    await expect(
      run(makeConvexHttpPort({ deploymentUrl: 'https://x.convex.cloud' }), layer),
    ).rejects.toThrow('malformed')
  })

  it('fails on a non-2xx response', async () => {
    const { layer } = recordingFetch(() => jsonResponse({}, 503))
    await expect(
      run(makeConvexHttpPort({ deploymentUrl: 'https://x.convex.cloud' }), layer),
    ).rejects.toThrow('503')
  })

  it('rejects a function-error envelope without its required errorMessage', async () => {
    const { layer } = recordingFetch(() => jsonResponse({ status: 'error' }))
    await expect(
      run(makeConvexHttpPort({ deploymentUrl: 'https://x.convex.cloud' }), layer),
    ).rejects.toThrow('convex: malformed response')
  })

  it('fails on a malformed body with neither success nor error', async () => {
    const { layer } = recordingFetch(() => jsonResponse({ unexpected: true }))
    await expect(
      run(makeConvexHttpPort({ deploymentUrl: 'https://x.convex.cloud' }), layer),
    ).rejects.toThrow('malformed')
  })

  // Real-world: the deployment URL points at a host that ISN'T a Convex deployment
  // (a parked domain, a corp proxy, an SPA index.html) — it answers 200 with HTML,
  // so `res.json()` blows up. The port hands the caller a classifiable failure.
  it('surfaces a malformed-response failure when a non-Convex host returns 200 with an HTML body', async () => {
    const { layer } = recordingFetch(() => new Response('<html>'))
    const port = makeConvexHttpPort({ deploymentUrl: 'https://parked.example.com' })
    await expect(run(port, layer, { events: [] })).rejects.toThrow(/convex: malformed response/)
    const caught = await run(port, layer, { events: [] }).catch((e) => e)
    expect(classifySyncError(caught)).toMatch(/is the URL really a Convex deployment/)
  })

  // Real-world: a transient edge 5xx, then the very next drain of the SAME batch
  // succeeds — model the sequence as two mutation() calls.
  it('classifies a transient 5xx then accepts the resend of the same batch', async () => {
    const batch = {
      events: [
        { eventId: 'dev-1/req-1/completed', kind: 'outcome', url: 'https://video.twimg.com/x.mp4' },
      ],
    }
    let calls = 0
    const { layer } = recordingFetch(() => {
      calls += 1
      return calls === 1
        ? jsonResponse({}, 502)
        : jsonResponse({ status: 'success', value: { received: 1, inserted: 1 } })
    })
    const port = makeConvexHttpPort({ deploymentUrl: 'https://x.convex.cloud' })

    const firstErr = await run(port, layer, batch).catch((e) => e)
    expect(firstErr).toBeInstanceOf(Error)
    expect((firstErr as Error).message).toMatch(/HTTP 502/)
    expect(classifySyncError(firstErr)).toMatch(/try again shortly/)

    expect(await run(port, layer, batch)).toEqual({ received: 1, inserted: 1 })
    expect(calls).toBe(2)
  })

  it('POSTs the envelope to /api/query and unwraps the success value', async () => {
    const { layer, calls } = recordingFetch(() =>
      jsonResponse({ status: 'success', value: ['T1'] }),
    )
    const port = makeConvexHttpPort({ deploymentUrl: 'https://x.convex.cloud/' })
    const value = await runQuery(port, layer, 'sync:downloadedAmong', {
      secret: 's',
      tweetIds: ['T1', 'T2'],
    })
    expect(value).toEqual(['T1'])
    expect(calls[0]!.url).toBe('https://x.convex.cloud/api/query')
    expect(calls[0]!.init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      path: 'sync:downloadedAmong',
      args: { secret: 's', tweetIds: ['T1', 'T2'] },
      format: 'json',
    })
  })

  it('query fails on a non-2xx response', async () => {
    const { layer } = recordingFetch(() => jsonResponse({}, 500))
    await expect(
      runQuery(
        makeConvexHttpPort({ deploymentUrl: 'https://x.convex.cloud' }),
        layer,
        'sync:downloadedAmong',
      ),
    ).rejects.toThrow('500')
  })

  it('query fails with the server errorMessage on a function error', async () => {
    const { layer } = recordingFetch(() => jsonResponse({ status: 'error', errorMessage: 'boom' }))
    await expect(
      runQuery(
        makeConvexHttpPort({ deploymentUrl: 'https://x.convex.cloud' }),
        layer,
        'sync:downloadedAmong',
      ),
    ).rejects.toThrow('boom')
  })

  it('query surfaces a malformed failure on an HTML body', async () => {
    const { layer } = recordingFetch(() => new Response('<html>'))
    await expect(
      runQuery(
        makeConvexHttpPort({ deploymentUrl: 'https://parked.example.com' }),
        layer,
        'sync:downloadedAmong',
      ),
    ).rejects.toThrow(/convex: malformed response/)
  })
})

describe('queryDownloadedAmong', () => {
  it('shapes the sync:downloadedAmong call and narrows the value', async () => {
    const { layer, calls } = recordingFetch(() =>
      jsonResponse({ status: 'success', value: ['T1'] }),
    )
    const port = makeConvexHttpPort({ deploymentUrl: 'https://x.convex.cloud' })
    const downloaded = await Effect.runPromise(
      queryDownloadedAmong(port, 'secret', ['T1', 'T2']).pipe(Effect.provide(layer)),
    )
    expect(downloaded).toEqual(['T1'])
    expect(calls[0]!.url).toBe('https://x.convex.cloud/api/query')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      path: 'sync:downloadedAmong',
      args: { secret: 'secret', tweetIds: ['T1', 'T2'] },
      format: 'json',
    })
  })
})

describe('queryDownloadedRequestIdsAmong', () => {
  it('shapes the sync:downloadedRequestIdsAmong call and narrows the value', async () => {
    const { layer, calls } = recordingFetch(() =>
      jsonResponse({ status: 'success', value: ['m1'] }),
    )
    const port = makeConvexHttpPort({ deploymentUrl: 'https://x.convex.cloud' })
    const downloaded = await Effect.runPromise(
      queryDownloadedRequestIdsAmong(port, 'secret', ['m1', 'm2']).pipe(Effect.provide(layer)),
    )
    expect(downloaded).toEqual(['m1'])
    expect(calls[0]!.url).toBe('https://x.convex.cloud/api/query')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      path: 'sync:downloadedRequestIdsAmong',
      args: { secret: 'secret', requestIds: ['m1', 'm2'] },
      format: 'json',
    })
  })
})
