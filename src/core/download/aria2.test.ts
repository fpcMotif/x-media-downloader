import { describe, it, expect } from 'vitest'
import { Effect, Exit } from 'effect'
import {
  buildAria2Options,
  buildJsonRpcBody,
  makeAria2Strategy,
  makeAria2RpcPort,
  aria2OriginPattern,
  type Aria2RpcPort,
} from './aria2'
import type { SaveRequest } from './strategy'

const req: SaveRequest = { id: 't1', url: 'https://x/v.mp4', filename: 'alice/v.mp4' }

describe('buildAria2Options', () => {
  it('includes dir, out, split + max-connection-per-server', () => {
    const opts = buildAria2Options(req, { dir: '/downloads', split: 8 })
    expect(opts).toEqual({
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
    expect(aria2OriginPattern('http://localhost:6800/jsonrpc')).toBe('http://localhost/*')
    expect(aria2OriginPattern('https://aria.example.com/rpc')).toBe('https://aria.example.com/*')
  })

  it('returns null for an unparseable url', () => {
    expect(aria2OriginPattern('not a url')).toBe(null)
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

describe('makeAria2Strategy', () => {
  it('save success yields an aria2 handle with the gid', async () => {
    let captured: { urls: ReadonlyArray<string>; options: Record<string, string> } | undefined
    const port: Aria2RpcPort = {
      addUri: (urls, options) => {
        captured = { urls, options }
        return Promise.resolve('gid123')
      },
    }
    const handle = await Effect.runPromise(makeAria2Strategy(port, { split: 8 }).save(req))
    expect(handle).toEqual({ kind: 'aria2', gid: 'gid123' })
    expect(captured?.urls).toEqual([req.url])
    expect(captured?.options.out).toBe(req.filename)
  })

  it('save failure produces a Failure exit', async () => {
    const port: Aria2RpcPort = {
      addUri: () => Promise.reject(new Error('boom')),
    }
    const exit = await Effect.runPromiseExit(makeAria2Strategy(port, { split: 8 }).save(req))
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe('makeAria2RpcPort', () => {
  it('POSTs a JSON-RPC envelope and returns the gid', async () => {
    let url: string | undefined
    let init: RequestInit | undefined
    const fetchImpl = ((u: string, i: RequestInit) => {
      url = u
      init = i
      return Promise.resolve({ json: async () => ({ result: 'gidABC' }) } as Response)
    }) as typeof fetch
    const port = makeAria2RpcPort({
      rpcUrl: 'http://localhost:6800/jsonrpc',
      secret: 'S',
      fetchImpl,
    })
    const gid = await port.addUri(['https://x/v.mp4'], { out: 'v.mp4' })
    expect(gid).toBe('gidABC')
    expect(url).toBe('http://localhost:6800/jsonrpc')
    expect(init?.method).toBe('POST')
    const body = JSON.parse(String(init?.body))
    expect(body.method).toBe('aria2.addUri')
    expect(body.params).toEqual(['token:S', ['https://x/v.mp4'], { out: 'v.mp4' }])
  })

  it('rejects when the JSON-RPC response carries an error', async () => {
    const fetchImpl = (() =>
      Promise.resolve({
        json: async () => ({ error: { code: 1, message: 'unauthorized' } }),
      } as Response)) as typeof fetch
    const port = makeAria2RpcPort({
      rpcUrl: 'http://localhost:6800/jsonrpc',
      secret: '',
      fetchImpl,
    })
    await expect(port.addUri(['u'], {})).rejects.toThrow('unauthorized')
  })

  it('rejects (with the code) when an error carries no message', async () => {
    const fetchImpl = (() =>
      Promise.resolve({ json: async () => ({ error: { code: 1 } }) } as Response)) as typeof fetch
    const port = makeAria2RpcPort({ rpcUrl: 'http://x', secret: '', fetchImpl })
    await expect(port.addUri(['u'], {})).rejects.toThrow('aria2 error 1')
  })

  it('rejects with a placeholder code when an error carries neither message nor code', async () => {
    const fetchImpl = (() =>
      Promise.resolve({ json: async () => ({ error: {} }) } as Response)) as typeof fetch
    const port = makeAria2RpcPort({ rpcUrl: 'http://x', secret: '', fetchImpl })
    await expect(port.addUri(['u'], {})).rejects.toThrow('aria2 error ?')
  })

  it('rejects a malformed body with neither result nor error', async () => {
    const fetchImpl = (() =>
      Promise.resolve({ json: async () => ({}) } as Response)) as typeof fetch
    const port = makeAria2RpcPort({ rpcUrl: 'http://x', secret: '', fetchImpl })
    await expect(port.addUri(['u'], {})).rejects.toThrow('malformed')
  })

  it('calls fetch with a global receiver, never as a method of cfg (Illegal invocation)', async () => {
    // Native `fetch` in the MV3 service worker throws when its receiver is not
    // the global scope. A non-arrow stub exposes the dynamic `this`, proving the
    // port never invokes it as `cfg.fetchImpl(...)` (`this === cfg`).
    const brandChecked = function (this: unknown) {
      if (this !== globalThis && this !== undefined) {
        throw new TypeError("Failed to execute 'fetch' on 'WorkerGlobalScope': Illegal invocation")
      }
      return Promise.resolve({ json: async () => ({ result: 'gid' }) } as Response)
    } as typeof fetch
    const port = makeAria2RpcPort({ rpcUrl: 'http://x', secret: '', fetchImpl: brandChecked })
    await expect(port.addUri(['u'], {})).resolves.toBe('gid')
  })

  it('rejects cleanly when the aria2 daemon is down (fetch refuses the connection)', async () => {
    // Nothing listening on :6800 — the SW `fetch` rejects with a TypeError. The
    // port must surface that rather than hang or resolve an undefined gid.
    const fetchImpl = (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch
    const port = makeAria2RpcPort({
      rpcUrl: 'http://localhost:6800/jsonrpc',
      secret: '',
      fetchImpl,
    })
    await expect(port.addUri(['https://x/v.mp4'], {})).rejects.toThrow(/Failed to fetch/)
  })

  it('rejects when pointed at a non-aria2 server that returns an HTML 200', async () => {
    // A misconfigured rpcUrl hitting some web server: 200 OK, but the body is an
    // HTML page, so `res.json()` throws. The port must reject, not crash opaquely.
    const fetchImpl = (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON at position 0')
        },
      } as unknown as Response)) as typeof fetch
    const port = makeAria2RpcPort({ rpcUrl: 'http://localhost:8080/', secret: '', fetchImpl })
    await expect(port.addUri(['https://x/v.mp4'], {})).rejects.toThrow(SyntaxError)
  })
})

const makeErrorMappingPort = (body: unknown) =>
  makeAria2RpcPort({
    rpcUrl: 'http://localhost:6800/jsonrpc',
    secret: '',
    fetchImpl: (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch,
  })

describe('makeAria2RpcPort error mapping', () => {
  it('throws Aria2RpcError with code on an error envelope', async () => {
    await expect(makeErrorMappingPort({ error: { code: 1, message: 'bad uri' } }).addUri(['u'], {})).rejects.toMatchObject(
      { _tag: 'Aria2RpcError', message: 'bad uri', code: 1 },
    )
  })

  it('throws Aria2RpcError on a malformed response', async () => {
    await expect(makeErrorMappingPort({ result: 42 }).addUri(['u'], {})).rejects.toMatchObject({
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
    let sent: { url: string; body: { params: unknown[] } } | undefined
    const fetchImpl = ((u: string, i: RequestInit) => {
      sent = { url: u, body: JSON.parse(String(i.body)) }
      return Promise.resolve({ json: async () => ({ result: 'GID9f3a' }) } as Response)
    }) as typeof fetch
    const port = makeAria2RpcPort({
      rpcUrl: 'http://localhost:6800/jsonrpc',
      secret: 'sek',
      fetchImpl,
    })
    const handle = await Effect.runPromise(
      makeAria2Strategy(port, { split: 16, dir: '/Users/alice/Downloads/x' }).save(videoReq),
    )
    expect(handle).toEqual({ kind: 'aria2', gid: 'GID9f3a' })
    expect(sent?.url).toBe('http://localhost:6800/jsonrpc')
    expect(sent?.body.params).toEqual([
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
    const fetchImpl = (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch
    const port = makeAria2RpcPort({
      rpcUrl: 'http://localhost:6800/jsonrpc',
      secret: '',
      fetchImpl,
    })
    const exit = await Effect.runPromiseExit(makeAria2Strategy(port, { split: 8 }).save(videoReq))
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
