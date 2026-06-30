import { describe, it, expect } from 'vitest'
import { Effect, Exit, Layer, Option } from 'effect'
import {
  buildAria2Options,
  buildJsonRpcBody,
  makeAria2Strategy,
  makeAria2RpcPort,
  aria2OriginPattern,
  type Aria2Options,
  type Aria2RpcPort,
} from './aria2'
import { FetchService, FetchError } from '../fetch-service'
import type { SaveRequest } from './strategy'

const req: SaveRequest = { id: 't1', url: 'https://x/v.mp4', filename: 'alice/v.mp4' }

/** A FetchService stub that routes via `respond` (sync return or throw) and records calls. */
const makeFetch = (respond: (url: string, init?: RequestInit) => Response) => {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const layer = Layer.succeed(FetchService, {
    fetch: (url, init) => {
      calls.push({ url, init })
      return Effect.tryPromise({ try: async () => respond(url, init), catch: (cause) => new FetchError({ url, cause }) })
    },
    fetchPromise: (async (url: string | URL, init?: RequestInit) => respond(String(url), init)) as typeof fetch,
  })
  return { layer, calls }
}

const noFetch = Layer.succeed(FetchService, {
  fetch: () => Effect.die(new Error('unexpected fetch')),
  fetchPromise: (() => Promise.reject(new Error('unexpected fetch'))) as typeof fetch,
})

const runAddUri = (
  port: Aria2RpcPort,
  layer: Layer.Layer<FetchService>,
  urls: ReadonlyArray<string> = ['u'],
  options: Record<string, string> = {},
): Promise<string> => Effect.runPromise(port.addUri(urls, options).pipe(Effect.provide(layer)))

describe('buildAria2Options', () => {
  it('includes dir, out, split + max-connection-per-server', () => {
    expect(buildAria2Options(req, { dir: '/downloads', split: 8 })).toEqual({
      out: 'alice/v.mp4',
      split: '8',
      'max-connection-per-server': '8',
      dir: '/downloads',
    })
  })

  it('omits dir when empty', () => {
    const opts = buildAria2Options(req, { dir: '', split: 4 })
    expect(opts.dir).toBeUndefined()
    expect(opts).toEqual({ out: 'alice/v.mp4', split: '4', 'max-connection-per-server': '4' })
  })
})

describe('aria2OriginPattern', () => {
  it('derives a host-only match pattern (drops the port)', () => {
    expect(Option.getOrNull(aria2OriginPattern('http://localhost:6800/jsonrpc'))).toBe('http://localhost/*')
    expect(Option.getOrNull(aria2OriginPattern('https://aria.example.com/rpc'))).toBe('https://aria.example.com/*')
  })

  it('returns none for an unparseable url', () => {
    expect(Option.getOrNull(aria2OriginPattern('not a url'))).toBe(null)
  })
})

describe('buildJsonRpcBody', () => {
  it('prepends token param when secret is set', () => {
    const body = buildJsonRpcBody('aria2.addUri', [['u'], {}], 'S')
    expect(body.method).toBe('aria2.addUri')
    expect(body.jsonrpc).toBe('2.0')
    expect(body.params[0]).toBe('token:S')
  })

  it('omits token param when secret is empty', () => {
    const body = buildJsonRpcBody('aria2.addUri', [['u'], {}], '')
    expect(body.params[0]).not.toBe('token:')
    expect(body.params).toEqual([['u'], {}])
  })
})

const split8: Aria2Options = { split: 8 }

describe('makeAria2Strategy', () => {
  it('save success yields an aria2 handle with the gid', async () => {
    let captured: { urls: ReadonlyArray<string>; options: Record<string, string> } | undefined
    const port: Aria2RpcPort = {
      addUri: (urls, options) =>
        Effect.sync(() => {
          captured = { urls, options }
          return 'gid123'
        }),
    }
    const handle = await Effect.runPromise(makeAria2Strategy(port, split8, noFetch).save(req))
    expect(handle).toEqual({ kind: 'aria2', gid: 'gid123' })
    expect(captured?.urls).toEqual([req.url])
    expect(captured?.options.out).toBe(req.filename)
  })

  it('save failure produces a Failure exit', async () => {
    const port: Aria2RpcPort = { addUri: () => Effect.die(new Error('boom')) }
    const exit = await Effect.runPromiseExit(makeAria2Strategy(port, split8, noFetch).save(req))
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe('makeAria2RpcPort', () => {
  it('POSTs a JSON-RPC envelope and returns the gid', async () => {
    const { layer, calls } = makeFetch(() => ({ json: async () => ({ result: 'gidABC' }) }) as Response)
    const port = makeAria2RpcPort({ rpcUrl: 'http://localhost:6800/jsonrpc', secret: 'S' })
    expect(await runAddUri(port, layer, ['https://x/v.mp4'], { out: 'v.mp4' })).toBe('gidABC')
    expect(calls[0]!.url).toBe('http://localhost:6800/jsonrpc')
    expect(calls[0]!.init?.method).toBe('POST')
    const body = JSON.parse(String(calls[0]!.init?.body))
    expect(body.method).toBe('aria2.addUri')
    expect(body.params).toEqual(['token:S', ['https://x/v.mp4'], { out: 'v.mp4' }])
  })

  it('fails when the JSON-RPC response carries an error', async () => {
    const { layer } = makeFetch(() => ({ json: async () => ({ error: { code: 1, message: 'unauthorized' } }) }) as Response)
    const port = makeAria2RpcPort({ rpcUrl: 'http://localhost:6800/jsonrpc', secret: '' })
    await expect(runAddUri(port, layer)).rejects.toThrow('unauthorized')
  })

  it('fails (with the code) when an error carries no message', async () => {
    const { layer } = makeFetch(() => ({ json: async () => ({ error: { code: 1 } }) }) as Response)
    await expect(runAddUri(makeAria2RpcPort({ rpcUrl: 'http://x', secret: '' }), layer)).rejects.toThrow('aria2 error 1')
  })

  it('fails with a placeholder code when an error carries neither message nor code', async () => {
    const { layer } = makeFetch(() => ({ json: async () => ({ error: {} }) }) as Response)
    await expect(runAddUri(makeAria2RpcPort({ rpcUrl: 'http://x', secret: '' }), layer)).rejects.toThrow('aria2 error ?')
  })

  it('fails on a malformed body with neither result nor error', async () => {
    const { layer } = makeFetch(() => ({ json: async () => ({}) }) as Response)
    await expect(runAddUri(makeAria2RpcPort({ rpcUrl: 'http://x', secret: '' }), layer)).rejects.toThrow('malformed')
  })

  it('fails (Aria2RpcError) when the daemon is down (fetch refuses the connection)', async () => {
    const { layer } = makeFetch(() => {
      throw new TypeError('Failed to fetch')
    })
    const port = makeAria2RpcPort({ rpcUrl: 'http://localhost:6800/jsonrpc', secret: '' })
    await expect(runAddUri(port, layer, ['https://x/v.mp4'], {})).rejects.toThrow(/Failed to fetch/)
  })

  it('maps a non-aria2 HTML 200 (json throws) to a malformed-response error', async () => {
    const { layer } = makeFetch(
      () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError('Unexpected token < in JSON at position 0')
          },
        }) as unknown as Response,
    )
    const port = makeAria2RpcPort({ rpcUrl: 'http://localhost:8080/', secret: '' })
    await expect(runAddUri(port, layer, ['https://x/v.mp4'], {})).rejects.toThrow(/malformed/)
  })
})

const errorBody = (body: unknown) => makeFetch(() => new Response(JSON.stringify(body)))

describe('makeAria2RpcPort error mapping', () => {
  it('fails with Aria2RpcError + code on an error envelope', async () => {
    const { layer } = errorBody({ error: { code: 1, message: 'bad uri' } })
    await expect(runAddUri(makeAria2RpcPort({ rpcUrl: 'http://x', secret: '' }), layer)).rejects.toMatchObject({
      _tag: 'Aria2RpcError',
      message: 'bad uri',
      code: 1,
    })
  })

  it('fails with Aria2RpcError on a malformed response', async () => {
    const { layer } = errorBody({ result: 42 })
    await expect(runAddUri(makeAria2RpcPort({ rpcUrl: 'http://x', secret: '' }), layer)).rejects.toMatchObject({
      _tag: 'Aria2RpcError',
      message: 'aria2: malformed JSON-RPC response',
    })
  })
})

describe('real-world: aria2 end-to-end with a twimg video', () => {
  const videoReq: SaveRequest = {
    id: '1750000000000000000-0',
    url: 'https://video.twimg.com/ext_tw_video/1750000000000000000/pu/vid/avc1/720x1280/abcDEF123.mp4?tag=12',
    filename: 'alice/1750000000000000000_0.mp4',
  }

  it('hands the full CDN url (query intact) + nested out path to the daemon and yields the gid', async () => {
    const { layer, calls } = makeFetch(() => ({ json: async () => ({ result: 'GID9f3a' }) }) as Response)
    const port = makeAria2RpcPort({ rpcUrl: 'http://localhost:6800/jsonrpc', secret: 'sek' })
    const handle = await Effect.runPromise(
      makeAria2Strategy(port, { split: 16, dir: '/Users/alice/Downloads/x' }, layer).save(videoReq),
    )
    expect(handle).toEqual({ kind: 'aria2', gid: 'GID9f3a' })
    expect(calls[0]!.url).toBe('http://localhost:6800/jsonrpc')
    const body = JSON.parse(String(calls[0]!.init?.body))
    expect(body.params).toEqual([
      'token:sek',
      [videoReq.url],
      { out: 'alice/1750000000000000000_0.mp4', split: '16', 'max-connection-per-server': '16', dir: '/Users/alice/Downloads/x' },
    ])
  })

  it('turns a dead daemon into a Failure exit (never a silent success)', async () => {
    const { layer } = makeFetch(() => {
      throw new TypeError('Failed to fetch')
    })
    const port = makeAria2RpcPort({ rpcUrl: 'http://localhost:6800/jsonrpc', secret: '' })
    const exit = await Effect.runPromiseExit(makeAria2Strategy(port, split8, layer).save(videoReq))
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
