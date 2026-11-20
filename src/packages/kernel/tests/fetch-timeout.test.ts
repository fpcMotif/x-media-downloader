import { describe, expect, it } from 'vitest'
import { withStallTimeout, withTotalTimeout } from '../fetch-timeout'

const never: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(init.signal?.reason)
    })
  })

const brandChecked: typeof fetch = function (this: typeof globalThis | undefined) {
  if (this !== globalThis) {
    throw new TypeError("Failed to execute 'fetch' on 'WorkerGlobalScope': Illegal invocation")
  }
  return Promise.resolve(new Response('ok'))
}

const chunkedFetch: typeof fetch = async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const chunks = [1, 2, 3, 4, 5]
      for (const [index, byte] of chunks.entries()) {
        setTimeout(
          () => {
            controller.enqueue(new Uint8Array([byte]))
            if (index === chunks.length - 1) controller.close()
          },
          (index + 1) * 10,
        )
      }
    },
  })
  return new Response(body)
}

describe('withTotalTimeout', () => {
  it('aborts a fetch that never settles after the timeout', async () => {
    await expect(withTotalTimeout(never, 20)('https://x.test')).rejects.toMatchObject({
      name: 'TimeoutError',
    })
  })

  it('passes through the response when fetch resolves before the timeout', async () => {
    const response = new Response('ok')
    const okFetch: typeof fetch = async () => response
    await expect(withTotalTimeout(okFetch, 50)('https://x.test')).resolves.toBe(response)
  })

  it('aborts when the caller signal fires before the timeout', async () => {
    const caller = new AbortController()
    const pending = withTotalTimeout(never, 200)('https://x.test', { signal: caller.signal })
    caller.abort(new Error('caller cancelled'))
    await expect(pending).rejects.toThrow('caller cancelled')
  })

  it('binds fetch to globalThis so brand-checked stubs do not throw', async () => {
    const owner = { fetchImpl: brandChecked }
    await expect(withTotalTimeout(owner.fetchImpl, 50)('https://x.test')).resolves.toBeInstanceOf(
      Response,
    )
  })
})

describe('withStallTimeout', () => {
  it('aborts when response headers time out', async () => {
    await expect(withStallTimeout(never, 20, 20)('https://x.test')).rejects.toThrow(
      'response headers timed out',
    )
  })

  it('aborts when the caller signal fires before headers arrive', async () => {
    const caller = new AbortController()
    const pending = withStallTimeout(never, 200, 200)('https://x.test', { signal: caller.signal })
    caller.abort(new Error('caller cancelled'))
    await expect(pending).rejects.toThrow('caller cancelled')
  })

  it('aborts when a response body stalls after sending a chunk', async () => {
    let seenSignal: AbortSignal | null | undefined
    const stalledFetch: typeof fetch = async (_input, init) => {
      seenSignal = init?.signal
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]))
        },
      })
      return new Response(body)
    }
    const response = await withStallTimeout(stalledFetch, 50, 20)('https://x.test')
    await expect(response.arrayBuffer()).rejects.toThrow('response body stalled')
    expect(seenSignal?.aborted).toBe(true)
  })

  it('streams chunks that arrive within the idle limit even when total time exceeds idleMs', async () => {
    const response = await withStallTimeout(chunkedFetch, 50, 30)('https://x.test')
    const bytes = new Uint8Array(await response.arrayBuffer())
    expect(bytes).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
  })

  it('returns a null-body response unchanged', async () => {
    const empty = new Response(null, { status: 204 })
    const emptyFetch: typeof fetch = async () => empty
    const response = await withStallTimeout(emptyFetch, 50, 50)('https://x.test')
    expect(response).toBe(empty)
  })

  it('preserves status, statusText, and headers on a wrapped response', async () => {
    const original = new Response('hello', {
      status: 201,
      statusText: 'Created',
      headers: { 'x-test': '42', 'content-type': 'text/plain' },
    })
    const okFetch: typeof fetch = async () => original
    const response = await withStallTimeout(okFetch, 50, 50)('https://x.test')
    expect(response.status).toBe(201)
    expect(response.statusText).toBe('Created')
    expect(response.headers.get('x-test')).toBe('42')
    expect(response.headers.get('content-type')).toBe('text/plain')
    expect(await response.text()).toBe('hello')
  })

  it('aborts the underlying request and cancels the source stream when the wrapped body is cancelled', async () => {
    let seenSignal: AbortSignal | null | undefined
    let cancelledWith: string | undefined
    const openFetch: typeof fetch = async (_input, init) => {
      seenSignal = init?.signal
      const body = new ReadableStream<Uint8Array>({
        cancel(reason) {
          cancelledWith = String(reason)
        },
      })
      return new Response(body)
    }
    const response = await withStallTimeout(openFetch, 50, 50)('https://x.test')
    await response.body?.cancel('stop')
    expect(seenSignal?.aborted).toBe(true)
    expect(seenSignal?.reason).toBe('stop')
    expect(cancelledWith).toBe('stop')
  })
})
