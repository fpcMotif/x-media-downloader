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

  it('rejects with an unknown-code fallback for an empty JSON-RPC error', async () => {
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
})
