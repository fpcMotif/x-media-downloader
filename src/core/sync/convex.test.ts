import { describe, it, expect } from 'vitest'
import { Option } from 'effect'
import { buildFunctionCall, convexOriginPattern, makeConvexHttpPort } from './convex'
import { classifySyncError } from './status'

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

  it('uses a default message when a function error omits errorMessage', async () => {
    const fetchImpl = (() =>
      Promise.resolve({
        ok: true,
        json: async () => ({ status: 'error' }),
      } as Response)) as typeof fetch
    const port = makeConvexHttpPort({ deploymentUrl: 'https://x.convex.cloud', fetchImpl })
    await expect(port.mutation('sync:recordEvents', {})).rejects.toThrow('convex: function error')
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

  it('calls fetch with a global receiver, never as a method of cfg (Illegal invocation)', async () => {
    // Native `fetch` in the MV3 service worker throws when its receiver is not
    // the global scope. Emulate that brand check with a non-arrow stub so the
    // dynamic `this` is observable, and prove the port never invokes it as
    // `cfg.fetchImpl(...)` (which would run it with `this === cfg`).
    const brandChecked = function (this: unknown) {
      if (this !== globalThis && this !== undefined) {
        throw new TypeError("Failed to execute 'fetch' on 'WorkerGlobalScope': Illegal invocation")
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ status: 'success', value: 'ok' }),
      } as Response)
    } as typeof fetch
    const port = makeConvexHttpPort({
      deploymentUrl: 'https://x.convex.cloud',
      fetchImpl: brandChecked,
    })
    await expect(port.mutation('sync:recordEvents', {})).resolves.toBe('ok')
  })

  // Real-world: the deployment URL was fat-fingered to a host that ISN'T a
  // Convex deployment (a parked domain, a corp proxy, an SPA index.html) — it
  // answers 200 with an HTML page, so `res.json()` blows up. The port should
  // still hand the caller a classifiable failure, not crash the drain loop.
  it('surfaces a failure when a non-Convex host returns 200 with an HTML body', async () => {
    // A non-arrow stub keeps the SW this-binding footgun guarded for this path
    // too: a brand-checked native fetch would reject if called as cfg.fetchImpl.
    const htmlFetch = function (this: unknown) {
      if (this !== globalThis && this !== undefined) {
        throw new TypeError("Failed to execute 'fetch' on 'WorkerGlobalScope': Illegal invocation")
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => {
          // What `Response.json()` throws when the body is `<!DOCTYPE html>…`.
          throw new SyntaxError('Unexpected token <')
        },
      } as unknown as Response)
    } as typeof fetch
    const port = makeConvexHttpPort({
      deploymentUrl: 'https://parked.example.com',
      fetchImpl: htmlFetch,
    })

    // The raw body-parse SyntaxError is normalized into the port's `malformed`
    // vocabulary rather than propagating an opaque JS parser stack trace.
    await expect(port.mutation('sync:recordEvents', { events: [] })).rejects.toThrow(
      /convex: malformed response/,
    )

    // Because it now lands in the `malformed` branch, the classifier surfaces the
    // purpose-built "is the URL really a Convex deployment?" hint instead of the
    // generic "could not reach" fallback with a leaked parser message.
    const caught = await port.mutation('sync:recordEvents', { events: [] }).catch((e) => e)
    expect(classifySyncError(caught)).toMatch(/is the URL really a Convex deployment/)
  })

  // Real-world: a transient edge 5xx (Convex behind a CDN hiccup) on one drain,
  // then the very next drain of the SAME batch succeeds — the outbox redrains a
  // single-shot port, so model the sequence as two mutation() calls and assert
  // the 5xx is classified as retryable before the resend lands.
  it('classifies a transient 5xx then accepts the resend of the same batch', async () => {
    const batch = {
      events: [
        {
          eventId: 'dev-1/req-1/completed',
          kind: 'outcome',
          url: 'https://video.twimg.com/ext_tw_video/100/pu/vid/720x1280/x.mp4?tag=12',
        },
      ],
    }
    let calls = 0
    const fetchImpl = (() => {
      calls += 1
      if (calls === 1) {
        return Promise.resolve({ ok: false, status: 502, json: async () => ({}) } as Response)
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ status: 'success', value: { received: 1, inserted: 1 } }),
      } as Response)
    }) as typeof fetch
    const port = makeConvexHttpPort({ deploymentUrl: 'https://x.convex.cloud', fetchImpl })

    const firstErr = await port.mutation('sync:recordEvents', batch).catch((e) => e)
    expect(firstErr).toBeInstanceOf(Error)
    expect((firstErr as Error).message).toMatch(/HTTP 502/)
    expect(classifySyncError(firstErr)).toMatch(/try again shortly/)

    // Backoff elapsed; the redrain of the identical batch is accepted.
    await expect(port.mutation('sync:recordEvents', batch)).resolves.toEqual({
      received: 1,
      inserted: 1,
    })
    expect(calls).toBe(2)
  })
})
