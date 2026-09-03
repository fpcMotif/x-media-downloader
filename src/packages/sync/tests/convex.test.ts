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
} from '../convex'
import { classifySyncError } from '../status'
import { FetchService, FetchError } from '@/packages/kernel/fetch-service'
import type { JsonObject, JsonValue } from '@/packages/schema'

/** `typeof fetch`'s first param is `RequestInfo | URL`; every call in this file
 *  passes a string, so narrow via `instanceof` (never stringify a `Request`,
 *  whose default `toString` is meaningless). */
const urlString = (input: RequestInfo | URL): string =>
  input instanceof URL ? input.href : input instanceof Request ? input.url : input

/** `RequestInit.body` is `BodyInit | null | undefined`; every request this port
 *  sends is JSON-stringified text, so narrow to that before `JSON.parse`. */
const isStringBody = (body: BodyInit | null | undefined): body is string => typeof body === 'string'

/** Parse the JSON body a recorded call actually POSTed, for envelope assertions. */
const parsedRequestBody = (init: RequestInit | undefined) => {
  const body = init?.body
  if (!isStringBody(body)) throw new Error('expected a string request body')
  return JSON.parse(body)
}

/** A Promise `fetch` (what the airlock takes, vs the FetchService layer above). */
const promiseFetch =
  (respond: (url: string, init?: RequestInit) => Response): typeof fetch =>
  async (url, init) =>
    respond(urlString(url), init)

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
    fetchPromise: async (u, i) => respond(urlString(u), i),
  })
  return { layer, calls }
}

const run = (
  port: ConvexPort,
  layer: Layer.Layer<FetchService>,
  args: JsonObject = {},
): Promise<JsonValue> =>
  Effect.runPromise(port.mutation('sync:recordEvents', args).pipe(Effect.provide(layer)))

const runQuery = (
  port: ConvexPort,
  layer: Layer.Layer<FetchService>,
  path: string,
  args: JsonObject = {},
): Promise<JsonValue> => Effect.runPromise(port.query(path, args).pipe(Effect.provide(layer)))

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
      () => new Response(JSON.stringify({ status: 'success', value: { inserted: 2 } })),
    )
    const port = makeConvexHttpPort({ deploymentUrl: 'https://x.convex.cloud/' })
    expect(await run(port, layer, { events: [] })).toEqual({ inserted: 2 })
    expect(calls[0]!.url).toBe('https://x.convex.cloud/api/mutation')
    expect(calls[0]!.init?.method).toBe('POST')
    expect(parsedRequestBody(calls[0]!.init)).toEqual({
      path: 'sync:recordEvents',
      args: { events: [] },
      format: 'json',
    })
  })

  it('fails with the server errorMessage on a function error', async () => {
    const { layer } = recordingFetch(
      () => new Response(JSON.stringify({ status: 'error', errorMessage: 'boom' })),
    )
    await expect(
      run(makeConvexHttpPort({ deploymentUrl: 'https://x.convex.cloud' }), layer),
    ).rejects.toThrow('boom')
  })

  it('fails on a non-2xx response', async () => {
    const { layer } = recordingFetch(() => new Response(JSON.stringify({}), { status: 503 }))
    await expect(
      run(makeConvexHttpPort({ deploymentUrl: 'https://x.convex.cloud' }), layer),
    ).rejects.toThrow('503')
  })

  it('uses a default message when a function error omits errorMessage', async () => {
    const { layer } = recordingFetch(() => new Response(JSON.stringify({ status: 'error' })))
    await expect(
      run(makeConvexHttpPort({ deploymentUrl: 'https://x.convex.cloud' }), layer),
    ).rejects.toThrow('convex: function error')
  })

  it('fails on a malformed body with neither success nor error', async () => {
    const { layer } = recordingFetch(() => new Response(JSON.stringify({ unexpected: true })))
    await expect(
      run(makeConvexHttpPort({ deploymentUrl: 'https://x.convex.cloud' }), layer),
    ).rejects.toThrow('malformed')
  })

  // Real-world: the deployment URL points at a host that ISN'T a Convex deployment
  // (a parked domain, a corp proxy, an SPA index.html) — it answers 200 with HTML,
  // so `res.json()` blows up. The port hands the caller a classifiable failure.
  it('surfaces a malformed-response failure when a non-Convex host returns 200 with an HTML body', async () => {
    // A real Response over a non-JSON body — `.json()` throws for real, exactly
    // the "parked domain/proxy served HTML" symptom this maps to a tagged error.
    const { layer } = recordingFetch(() => new Response('<html>not json</html>'))
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
        ? new Response(JSON.stringify({}), { status: 502 })
        : new Response(JSON.stringify({ status: 'success', value: { received: 1, inserted: 1 } }))
    })
    const port = makeConvexHttpPort({ deploymentUrl: 'https://x.convex.cloud' })

    const firstErr = await run(port, layer, batch).catch((e) => e)
    expect(firstErr).toBeInstanceOf(Error)
    expect(firstErr.message).toMatch(/HTTP 502/)
    expect(classifySyncError(firstErr)).toMatch(/try again shortly/)

    expect(await run(port, layer, batch)).toEqual({ received: 1, inserted: 1 })
    expect(calls).toBe(2)
  })

  it('POSTs the envelope to /api/query and unwraps the success value', async () => {
    const { layer, calls } = recordingFetch(
      () => new Response(JSON.stringify({ status: 'success', value: ['T1'] })),
    )
    const port = makeConvexHttpPort({ deploymentUrl: 'https://x.convex.cloud/' })
    const value = await runQuery(port, layer, 'sync:downloadedAmong', {
      secret: 's',
      tweetIds: ['T1', 'T2'],
    })
    expect(value).toEqual(['T1'])
    expect(calls[0]!.url).toBe('https://x.convex.cloud/api/query')
    expect(calls[0]!.init?.method).toBe('POST')
    expect(parsedRequestBody(calls[0]!.init)).toEqual({
      path: 'sync:downloadedAmong',
      args: { secret: 's', tweetIds: ['T1', 'T2'] },
      format: 'json',
    })
  })

  it('query fails on a non-2xx response', async () => {
    const { layer } = recordingFetch(() => new Response(JSON.stringify({}), { status: 500 }))
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
      () => new Response(JSON.stringify({ status: 'error', errorMessage: 'boom' })),
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
    const { layer } = recordingFetch(() => new Response('<html>not json</html>'))
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
        () => new Response(JSON.stringify({ status: 'success', value: { inserted: 2 } })),
      ),
    )
    expect(await port.mutation('sync:recordEvents', { events: [] })).toEqual({ inserted: 2 })
  })

  it('rejects with the same tagged error makeConvexHttpPort produces, so classifySyncError switches on it', async () => {
    const port = makeConvexPromisePort(
      { deploymentUrl: 'https://x.convex.cloud' },
      promiseFetch(
        () => new Response(JSON.stringify({ status: 'error', errorMessage: 'unauthorized' })),
      ),
    )
    const err = await port.mutation('sync:recordEvents', {}).catch((e) => e)
    expect(err).toBeInstanceOf(ConvexFunctionError)
    expect(err._tag).toBe('ConvexFunctionError')
    expect(classifySyncError(err)).toMatch(/Secret rejected/)
  })
})

describe('queryDownloadedAmong', () => {
  it('shapes the sync:downloadedAmong call and narrows the value', async () => {
    const { layer, calls } = recordingFetch(
      () => new Response(JSON.stringify({ status: 'success', value: ['T1'] })),
    )
    const port = makeConvexHttpPort({ deploymentUrl: 'https://x.convex.cloud' })
    const downloaded = await Effect.runPromise(
      queryDownloadedAmong(port, 'secret', ['T1', 'T2']).pipe(Effect.provide(layer)),
    )
    expect(downloaded).toEqual(['T1'])
    expect(calls[0]!.url).toBe('https://x.convex.cloud/api/query')
    expect(parsedRequestBody(calls[0]!.init)).toEqual({
      path: 'sync:downloadedAmong',
      args: { secret: 'secret', tweetIds: ['T1', 'T2'] },
      format: 'json',
    })
  })
})

describe('queryDownloadedMediaIdsAmong', () => {
  it('shapes the sync:downloadedMediaIdsAmong call and narrows the value', async () => {
    const { layer, calls } = recordingFetch(
      () => new Response(JSON.stringify({ status: 'success', value: ['m1'] })),
    )
    const port = makeConvexHttpPort({ deploymentUrl: 'https://x.convex.cloud' })
    const downloaded = await Effect.runPromise(
      queryDownloadedMediaIdsAmong(port, 'secret', ['m1', 'm2']).pipe(Effect.provide(layer)),
    )
    expect(downloaded).toEqual(['m1'])
    expect(calls[0]!.url).toBe('https://x.convex.cloud/api/query')
    expect(parsedRequestBody(calls[0]!.init)).toEqual({
      path: 'sync:downloadedMediaIdsAmong',
      args: { secret: 'secret', mediaIds: ['m1', 'm2'] },
      format: 'json',
    })
  })
})
