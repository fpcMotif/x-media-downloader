import { describe, it, expect } from 'vitest'
import { buildFunctionCall, convexOriginPattern, makeConvexHttpPort } from './convex'

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
    expect(convexOriginPattern('https://happy-otter-123.convex.cloud')).toBe(
      'https://happy-otter-123.convex.cloud/*',
    )
  })

  it('returns null for an unparseable url', () => {
    expect(convexOriginPattern('not a url')).toBe(null)
  })
})

describe('makeConvexHttpPort', () => {
  it('POSTs the envelope to /api/mutation and unwraps the success value', async () => {
    let url: string | undefined
    let init: RequestInit | undefined
    const fetchImpl = ((u: string, i: RequestInit) => {
      url = u
      init = i
      return Promise.resolve({
        ok: true,
        json: async () => ({ status: 'success', value: { inserted: 2 } }),
      } as Response)
    }) as typeof fetch
    const port = makeConvexHttpPort({ deploymentUrl: 'https://x.convex.cloud/', fetchImpl })
    const value = await port.mutation('sync:recordEvents', { events: [] })
    expect(value).toEqual({ inserted: 2 })
    expect(url).toBe('https://x.convex.cloud/api/mutation')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({
      path: 'sync:recordEvents',
      args: { events: [] },
      format: 'json',
    })
  })

  it('rejects with the server errorMessage on a function error', async () => {
    const fetchImpl = (() =>
      Promise.resolve({
        ok: true,
        json: async () => ({ status: 'error', errorMessage: 'boom' }),
      } as Response)) as typeof fetch
    const port = makeConvexHttpPort({ deploymentUrl: 'https://x.convex.cloud', fetchImpl })
    await expect(port.mutation('sync:recordEvents', {})).rejects.toThrow('boom')
  })

  it('rejects on a non-2xx response', async () => {
    const fetchImpl = (() =>
      Promise.resolve({
        ok: false,
        status: 503,
        json: async () => ({}),
      } as Response)) as typeof fetch
    const port = makeConvexHttpPort({ deploymentUrl: 'https://x.convex.cloud', fetchImpl })
    await expect(port.mutation('sync:recordEvents', {})).rejects.toThrow('503')
  })

  it('rejects a malformed body with neither success nor error', async () => {
    const fetchImpl = (() =>
      Promise.resolve({
        ok: true,
        json: async () => ({ unexpected: true }),
      } as Response)) as typeof fetch
    const port = makeConvexHttpPort({ deploymentUrl: 'https://x.convex.cloud', fetchImpl })
    await expect(port.mutation('sync:recordEvents', {})).rejects.toThrow('malformed')
  })
})
