import { describe, it, expect } from 'vitest'
import { Effect, Exit, Layer, Option } from 'effect'
import {
  ARIA2_DECIMAL_MAX_DIGITS,
  ARIA2_ERROR_CODE_MAX_LENGTH,
  ARIA2_ERROR_MESSAGE_MAX_LENGTH,
  MAX_ARIA2_RESPONSE_BYTES,
  buildAria2Options,
  buildAria2GidOption,
  buildJsonRpcBody,
  isAria2Gid,
  makeAria2Strategy,
  makeAria2RpcPort,
  aria2OriginPattern,
  type Aria2Options,
  type Aria2RpcPort,
} from './aria2'
import { FetchService, FetchError } from '../fetch-service'
import type { SaveRequest } from './strategy'

const req: SaveRequest = { id: 't1', url: 'https://x/v.mp4', filename: 'alice/v.mp4' }
const GID = '0123456789abcdef'
const rpcSuccess = (result: unknown) => ({ jsonrpc: '2.0', id: 'xmd', result })
const rpcError = (code: number, message: string) => ({
  jsonrpc: '2.0',
  id: 'xmd',
  error: { code, message },
})
const jsonResponse = (body: unknown): Response => new Response(JSON.stringify(body))

/** A FetchService stub that routes via `respond` (sync return or throw) and records calls. */
const makeFetch = (respond: (url: string, init?: RequestInit) => Response) => {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const layer = Layer.succeed(FetchService, {
    fetch: (url, init) => {
      calls.push({ url, init })
      return Effect.tryPromise({
        try: async () => respond(url, init),
        catch: (cause) => new FetchError({ url, cause }),
      })
    },
    fetchPromise: (async (url: string | URL, init?: RequestInit) =>
      respond(String(url), init)) as typeof fetch,
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

const runTellStatus = (port: Aria2RpcPort, layer: Layer.Layer<FetchService>, gid = GID) =>
  Effect.runPromise(port.tellStatus(gid).pipe(Effect.provide(layer)))

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

describe('aria2 GID helpers', () => {
  it('accepts exact, non-reserved 16-digit hexadecimal GIDs', () => {
    expect(isAria2Gid(GID)).toBe(true)
    expect(buildAria2GidOption('0123456789ABCDEF')).toEqual({ gid: GID })
  })

  it.each(['0000000000000000', '1234', 'g123456789abcdef'])('rejects invalid GIDs: %s', (gid) => {
    expect(isAria2Gid(gid)).toBe(false)
    expect(() => buildAria2GidOption(gid)).toThrow('aria2 gid')
  })
})

describe('aria2OriginPattern', () => {
  it('derives a host-only match pattern (drops the port)', () => {
    expect(Option.getOrNull(aria2OriginPattern('http://localhost:6800/jsonrpc'))).toBe(
      'http://localhost/*',
    )
    expect(Option.getOrNull(aria2OriginPattern('https://aria.example.com/rpc'))).toBe(
      'https://aria.example.com/*',
    )
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
      tellStatus: () => Effect.die(new Error('unexpected tellStatus')),
    }
    const handle = await Effect.runPromise(makeAria2Strategy(port, split8, noFetch).save(req))
    expect(handle).toEqual({ kind: 'aria2', gid: 'gid123' })
    expect(captured?.urls).toEqual([req.url])
    expect(captured?.options.out).toBe(req.filename)
  })

  it('save failure produces a Failure exit', async () => {
    const port: Aria2RpcPort = {
      addUri: () => Effect.die(new Error('boom')),
      tellStatus: () => Effect.die(new Error('unexpected tellStatus')),
    }
    const exit = await Effect.runPromiseExit(makeAria2Strategy(port, split8, noFetch).save(req))
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it('sends the reserved gid and rejects a different receipt', async () => {
    const calls: Record<string, string>[] = []
    const port: Aria2RpcPort = {
      addUri: (_urls, options) =>
        Effect.sync(() => {
          calls.push(options)
          return '0000000000000002'
        }),
      tellStatus: () => Effect.die(new Error('unexpected tellStatus')),
    }
    const exit = await Effect.runPromiseExit(
      makeAria2Strategy(port, split8, noFetch, () => '0000000000000001').save(req),
    )
    expect(calls).toEqual([expect.objectContaining({ gid: '0000000000000001' })])
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe('makeAria2RpcPort', () => {
  it('POSTs a JSON-RPC envelope and returns the gid', async () => {
    const { layer, calls } = makeFetch(() => jsonResponse(rpcSuccess(GID)))
    const port = makeAria2RpcPort({ rpcUrl: 'http://localhost:6800/jsonrpc', secret: 'S' })
    expect(await runAddUri(port, layer, ['https://x/v.mp4'], { out: 'v.mp4' })).toBe(GID)
    expect(calls[0]!.url).toBe('http://localhost:6800/jsonrpc')
    expect(calls[0]!.init?.method).toBe('POST')
    const body = JSON.parse(String(calls[0]!.init?.body))
    expect(body.method).toBe('aria2.addUri')
    expect(body.params).toEqual(['token:S', ['https://x/v.mp4'], { out: 'v.mp4' }])
  })

  it('fails when the JSON-RPC response carries an error', async () => {
    const { layer } = makeFetch(() => jsonResponse(rpcError(1, 'unauthorized')))
    const port = makeAria2RpcPort({ rpcUrl: 'http://localhost:6800/jsonrpc', secret: '' })
    await expect(runAddUri(port, layer)).rejects.toThrow('unauthorized')
  })

  it('rejects an error without its required message', async () => {
    const { layer } = makeFetch(() =>
      jsonResponse({ jsonrpc: '2.0', id: 'xmd', error: { code: 1 } }),
    )
    await expect(
      runAddUri(makeAria2RpcPort({ rpcUrl: 'http://x', secret: '' }), layer),
    ).rejects.toThrow('malformed')
  })

  it('rejects an error without its required code', async () => {
    const { layer } = makeFetch(() =>
      jsonResponse({ jsonrpc: '2.0', id: 'xmd', error: { message: 'bad' } }),
    )
    await expect(
      runAddUri(makeAria2RpcPort({ rpcUrl: 'http://x', secret: '' }), layer),
    ).rejects.toThrow('malformed')
  })

  it('fails on a malformed body with neither result nor error', async () => {
    const { layer } = makeFetch(() => jsonResponse({}))
    await expect(
      runAddUri(makeAria2RpcPort({ rpcUrl: 'http://x', secret: '' }), layer),
    ).rejects.toThrow('malformed')
  })

  it('fails (Aria2RpcError) when the daemon is down (fetch refuses the connection)', async () => {
    const { layer } = makeFetch(() => {
      throw new TypeError('Failed to fetch')
    })
    const port = makeAria2RpcPort({ rpcUrl: 'http://localhost:6800/jsonrpc', secret: '' })
    await expect(runAddUri(port, layer, ['https://x/v.mp4'], {})).rejects.toThrow(/Failed to fetch/)
  })

  it('maps a non-aria2 HTML 200 to a malformed-response error', async () => {
    const { layer } = makeFetch(() => new Response('<html>'))
    const port = makeAria2RpcPort({ rpcUrl: 'http://localhost:8080/', secret: '' })
    await expect(runAddUri(port, layer, ['https://x/v.mp4'], {})).rejects.toThrow(/malformed/)
  })
})

const errorBody = (body: unknown) => makeFetch(() => jsonResponse(body))

describe('makeAria2RpcPort error mapping', () => {
  it('fails with Aria2RpcError + code on an error envelope', async () => {
    const { layer } = errorBody(rpcError(1, 'bad uri'))
    await expect(
      runAddUri(makeAria2RpcPort({ rpcUrl: 'http://x', secret: '' }), layer),
    ).rejects.toMatchObject({
      _tag: 'Aria2RpcError',
      message: 'bad uri',
      code: 1,
    })
  })

  it('fails with Aria2RpcError on a malformed response', async () => {
    const { layer } = errorBody(rpcSuccess(42))
    await expect(
      runAddUri(makeAria2RpcPort({ rpcUrl: 'http://x', secret: '' }), layer),
    ).rejects.toMatchObject({
      _tag: 'Aria2RpcError',
      message: 'aria2: malformed JSON-RPC response',
    })
  })

  it.each([
    ['missing protocol fields', { result: GID }],
    ['wrong version', { ...rpcSuccess(GID), jsonrpc: '1.0' }],
    ['wrong id', { ...rpcSuccess(GID), id: 'other' }],
    ['an extra success key', { ...rpcSuccess(GID), extra: true }],
    ['both result and error', { ...rpcSuccess(GID), error: { code: 1, message: 'bad' } }],
    ['an extra error-envelope key', { ...rpcError(1, 'bad'), extra: true }],
    [
      'an extra error-object key',
      { ...rpcError(1, 'bad'), error: { code: 1, message: 'bad', data: 'unused' } },
    ],
    ['an unsafe error code', rpcError(Number.MAX_SAFE_INTEGER + 1, 'bad')],
    ['an empty error message', rpcError(1, '   ')],
    ['an oversized error message', rpcError(1, 'x'.repeat(ARIA2_ERROR_MESSAGE_MAX_LENGTH + 1))],
  ])('rejects %s', async (_description, body) => {
    const { layer } = errorBody(body)
    await expect(
      runAddUri(makeAria2RpcPort({ rpcUrl: 'http://x', secret: '' }), layer),
    ).rejects.toMatchObject({
      _tag: 'Aria2RpcError',
      message: 'aria2: malformed JSON-RPC response',
    })
  })

  it.each(['0000000000000000', '1234', 'g123456789abcdef'])(
    'rejects invalid addUri GID %s',
    async (gid) => {
      const { layer } = errorBody(rpcSuccess(gid))
      await expect(
        runAddUri(makeAria2RpcPort({ rpcUrl: 'http://x', secret: '' }), layer),
      ).rejects.toMatchObject({
        _tag: 'Aria2RpcError',
        message: 'aria2: malformed JSON-RPC response',
      })
    },
  )
})

describe('makeAria2RpcPort tellStatus', () => {
  const statusResult = (status: string, extra: Record<string, unknown> = {}) => ({
    ...rpcSuccess({
      gid: GID,
      status,
      completedLength: '42',
      totalLength: '90071992547409931234567890',
      ...extra,
    }),
  })

  it.each([
    ['active', {}],
    ['waiting', {}],
    ['paused', {}],
    ['complete', { errorCode: '0' }],
    ['error', { errorCode: '3', errorMessage: 'disk full' }],
    ['removed', { errorCode: '1', errorMessage: 'removed' }],
  ])('decodes %s without rounding decimal lengths', async (status, extra) => {
    const { layer } = errorBody(statusResult(status, extra))
    await expect(
      runTellStatus(makeAria2RpcPort({ rpcUrl: 'http://x', secret: '' }), layer),
    ).resolves.toEqual({
      gid: GID,
      status,
      completedLength: '42',
      totalLength: '90071992547409931234567890',
      ...extra,
    })
  })

  it('sends the token and only the six requested status keys', async () => {
    const { layer, calls } = errorBody(statusResult('active'))
    await runTellStatus(makeAria2RpcPort({ rpcUrl: 'http://x', secret: 'S' }), layer)
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      jsonrpc: '2.0',
      id: 'xmd',
      method: 'aria2.tellStatus',
      params: [
        'token:S',
        GID,
        ['gid', 'status', 'completedLength', 'totalLength', 'errorCode', 'errorMessage'],
      ],
    })
  })

  it('omits auth when no secret is configured', async () => {
    const { layer, calls } = errorBody(statusResult('active'))
    await runTellStatus(makeAria2RpcPort({ rpcUrl: 'http://x', secret: '' }), layer)
    expect(JSON.parse(String(calls[0]!.init?.body)).params).toEqual([
      GID,
      ['gid', 'status', 'completedLength', 'totalLength', 'errorCode', 'errorMessage'],
    ])
  })

  it.each([
    ['a mismatched gid', statusResult('active', { gid: 'other' })],
    ['an unknown status', statusResult('seeding')],
    ['a leading-zero length', statusResult('active', { completedLength: '01' })],
    ['a signed length', statusResult('active', { totalLength: '+1' })],
    [
      'an oversized decimal length',
      statusResult('active', { totalLength: '1'.repeat(ARIA2_DECIMAL_MAX_DIGITS + 1) }),
    ],
    ['a numeric length', statusResult('active', { completedLength: 42 })],
    [
      'an unsafe numeric length',
      statusResult('active', { totalLength: Number.MAX_SAFE_INTEGER + 1 }),
    ],
    ['error data for an active transfer', statusResult('active', { errorCode: '3' })],
    ['a non-string error field', statusResult('error', { errorCode: 3 })],
    [
      'an oversized error code',
      statusResult('error', { errorCode: '1'.repeat(ARIA2_ERROR_CODE_MAX_LENGTH + 1) }),
    ],
    [
      'an oversized error message',
      statusResult('error', { errorMessage: 'x'.repeat(ARIA2_ERROR_MESSAGE_MAX_LENGTH + 1) }),
    ],
    ['an unexpected result key', statusResult('complete', { files: [] })],
  ])('rejects %s', async (_description, body) => {
    const { layer } = errorBody(body)
    await expect(
      runTellStatus(makeAria2RpcPort({ rpcUrl: 'http://x', secret: '' }), layer),
    ).rejects.toMatchObject({
      _tag: 'Aria2RpcError',
      message: 'aria2: malformed JSON-RPC response',
    })
  })

  it('maps JSON-RPC and network errors to Aria2RpcError', async () => {
    const rpc = errorBody(rpcError(1, 'unauthorized'))
    await expect(
      runTellStatus(makeAria2RpcPort({ rpcUrl: 'http://x', secret: '' }), rpc.layer),
    ).rejects.toMatchObject({ _tag: 'Aria2RpcError', code: 1, message: 'unauthorized' })

    const network = makeFetch(() => {
      throw new TypeError('Failed to fetch')
    })
    await expect(
      runTellStatus(makeAria2RpcPort({ rpcUrl: 'http://x', secret: '' }), network.layer),
    ).rejects.toThrow('Failed to fetch')
  })

  it('rejects an oversized JSON-RPC response before envelope decode', async () => {
    const { layer } = makeFetch(() => new Response('x'.repeat(MAX_ARIA2_RESPONSE_BYTES + 1)))
    await expect(
      runAddUri(makeAria2RpcPort({ rpcUrl: 'http://x', secret: '' }), layer),
    ).rejects.toMatchObject({
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
    const { layer, calls } = makeFetch(() => jsonResponse(rpcSuccess('AABBCCDDEEFF0011')))
    const port = makeAria2RpcPort({ rpcUrl: 'http://localhost:6800/jsonrpc', secret: 'sek' })
    const handle = await Effect.runPromise(
      makeAria2Strategy(port, { split: 16, dir: '/Users/alice/Downloads/x' }, layer).save(videoReq),
    )
    expect(handle).toEqual({ kind: 'aria2', gid: 'aabbccddeeff0011' })
    expect(calls[0]!.url).toBe('http://localhost:6800/jsonrpc')
    const body = JSON.parse(String(calls[0]!.init?.body))
    expect(body.params).toEqual([
      'token:sek',
      [videoReq.url],
      {
        out: 'alice/1750000000000000000_0.mp4',
        split: '16',
        'max-connection-per-server': '16',
        dir: '/Users/alice/Downloads/x',
      },
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
