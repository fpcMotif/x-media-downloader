import { describe, it, expect } from 'vitest'
import { Effect, Layer, Option } from 'effect'
import {
  buildFunctionCall,
  convexOriginPattern,
  ConvexFunctionError,
  makeConvexHttpPort,
  makeConvexPromisePort,
  queryDownloadedAmong,
  queryDownloadedMediaIdsAmong,
  type ConvexPort,
} from './convex'
import { classifySyncError } from './status'
import { FetchService, FetchError } from '../fetch-service'

/** A Promise `fetch` (what the airlock takes, vs the FetchService layer above). */
const promiseFetch = (respond: (url: string, init?: RequestInit) => Response): typeof fetch =>
  (async (url: string | URL, init?: RequestInit) => respond(String(url), init)) as typeof fetch

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
    const { layer, calls } = recordingFetch(
      () =>
        ({
          ok: true,
          json: async () => ({ status: 'success', value: { inserted: 2 } }),
        }) as Response,
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
    const { layer } = recordingFetch(
      () =>
        ({ ok: true, json: async () => ({ status: 'error', errorMessage: 'boom' }) }) as Response,
    )
    await expect(
      run(makeConvexHttpPort({ deploymentUrl: 'https://x.convex.cloud' }), layer),
    ).rejects.toThrow('boom')
  })

  it('fails on a non-2xx response', async () => {
    const { layer } = recordingFetch(
      () => ({ ok: false, status: 503, json: async () => ({}) }) as Response,
    )
    await expect(
      run(makeConvexHttpPort({ deploymentUrl: 'https://x.convex.cloud' }), layer),
    ).rejects.toThrow('503')
  })

  it('uses a default message when a function error omits errorMessage', async () => {
    const { layer } = recordingFetch(
      () => ({ ok: true, json: async () => ({ status: 'error' }) }) as Response,
    )
    await expect(
      run(makeConvexHttpPort({ deploymentUrl: 'https://x.convex.cloud' }), layer),
    ).rejects.toThrow('convex: function error')
  })

  it('fails on a malformed body with neither success nor error', async () => {
    const { layer } = recordingFetch(
      () => ({ ok: true, json: async () => ({ unexpected: true }) }) as Response,
    )
    await expect(
      run(makeConvexHttpPort({ deploymentUrl: 'https://x.convex.cloud' }), layer),
    ).rejects.toThrow('malformed')
  })

  // Real-world: the deployment URL points at a host that ISN'T a Convex deployment
  // (a parked domain, a corp proxy, an SPA index.html) — it answers 200 with HTML,
  // so `res.json()` blows up. The port hands the caller a classifiable failure.
  it('surfaces a malformed-response failure when a non-Convex host returns 200 with an HTML body', async () => {
    const { layer } = recordingFetch(
      () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError('Unexpected token <')
          },
        }) as unknown as Response,
    )
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
        ? ({ ok: false, status: 502, json: async () => ({}) } as Response)
        : ({
            ok: true,
            status: 200,
            json: async () => ({ status: 'success', value: { received: 1, inserted: 1 } }),
          } as Response)
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
    const { layer, calls } = recordingFetch(
      () => ({ ok: true, json: async () => ({ status: 'success', value: ['T1'] }) }) as Response,
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
    const { layer } = recordingFetch(
      () => ({ ok: false, status: 500, json: async () => ({}) }) as Response,
    )
    await expect(
      runQuery(
        makeConvexHttpPort({ deploymentUrl: 'https://x.convex.cloud' }),
        layer,
        'sync:downloadedAmong',
      ),
    ).rejects.toThrow('500')
  })

  it('query fails with the server errorMessage on a function error', async () => {
    const { layer } = recordingFetch(
      () =>
        ({ ok: true, json: async () => ({ status: 'error', errorMessage: 'boom' }) }) as Response,
    )
    await expect(
      runQuery(
        makeConvexHttpPort({ deploymentUrl: 'https://x.convex.cloud' }),
        layer,
        'sync:downloadedAmong',
      ),
    ).rejects.toThrow('boom')
  })

  it('query surfaces a malformed failure on an HTML body', async () => {
    const { layer } = recordingFetch(
      () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError('Unexpected token <')
          },
        }) as unknown as Response,
    )
    await expect(
      runQuery(
        makeConvexHttpPort({ deploymentUrl: 'https://parked.example.com' }),
        layer,
        'sync:downloadedAmong',
      ),
    ).rejects.toThrow(/convex: malformed response/)
  })
})

describe('makeConvexPromisePort', () => {
  it('resolves with the success envelope value', async () => {
    const port = makeConvexPromisePort(
      { deploymentUrl: 'https://x.convex.cloud/' },
      promiseFetch(
        () =>
          ({
            ok: true,
            json: async () => ({ status: 'success', value: { inserted: 2 } }),
          }) as Response,
      ),
    )
    expect(await port.mutation('sync:recordEvents', { events: [] })).toEqual({ inserted: 2 })
  })

  it('rejects with the same tagged error makeConvexHttpPort produces, so classifySyncError switches on it', async () => {
    const port = makeConvexPromisePort(
      { deploymentUrl: 'https://x.convex.cloud' },
      promiseFetch(
        () =>
          ({
            ok: true,
            json: async () => ({ status: 'error', errorMessage: 'unauthorized' }),
          }) as Response,
      ),
    )
    const err = await port.mutation('sync:recordEvents', {}).catch((e) => e)
    expect(err).toBeInstanceOf(ConvexFunctionError)
    expect((err as { _tag: string })._tag).toBe('ConvexFunctionError')
    expect(classifySyncError(err)).toMatch(/Secret rejected/)
  })
})

describe('queryDownloadedAmong', () => {
  it('shapes the sync:downloadedAmong call and narrows the value', async () => {
    const { layer, calls } = recordingFetch(
      () => ({ ok: true, json: async () => ({ status: 'success', value: ['T1'] }) }) as Response,
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

describe('queryDownloadedMediaIdsAmong', () => {
  it('shapes the sync:downloadedMediaIdsAmong call and narrows the value', async () => {
    const { layer, calls } = recordingFetch(
      () => ({ ok: true, json: async () => ({ status: 'success', value: ['m1'] }) }) as Response,
    )
    const port = makeConvexHttpPort({ deploymentUrl: 'https://x.convex.cloud' })
    const downloaded = await Effect.runPromise(
      queryDownloadedMediaIdsAmong(port, 'secret', ['m1', 'm2']).pipe(Effect.provide(layer)),
    )
    expect(downloaded).toEqual(['m1'])
    expect(calls[0]!.url).toBe('https://x.convex.cloud/api/query')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      path: 'sync:downloadedMediaIdsAmong',
      args: { secret: 'secret', mediaIds: ['m1', 'm2'] },
      format: 'json',
    })
  })
})
