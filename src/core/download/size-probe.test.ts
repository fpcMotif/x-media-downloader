import { describe, it, expect, vi } from 'vitest'
import {
  makeGuardedProbeFetch,
  makeSizeProbe,
  type ProbeFetch,
  type ProbeResponse,
} from './size-probe'

const response = (ok: boolean, status: number, contentLength: string | null): ProbeResponse => ({
  ok,
  status,
  headers: { get: (name) => (name.toLowerCase() === 'content-length' ? contentLength : null) },
})

const fakeFetch =
  (res: ProbeResponse): ProbeFetch =>
  async () =>
    res

const stallUntilAborted: ProbeFetch = async (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
  })

describe('makeSizeProbe', () => {
  it('returns the parsed content-length on success', async () => {
    const probe = makeSizeProbe({ fetch: fakeFetch(response(true, 200, '1048576')) })
    await expect(probe.probe('https://pbs.twimg.com/a.jpg')).resolves.toBe(1048576)
  })

  it('issues a HEAD request to the given url', async () => {
    let seenUrl: string | undefined
    let seenMethod: string | undefined
    let seenSignal: AbortSignal | undefined
    const probe = makeSizeProbe({
      fetch: async (url, init) => {
        seenUrl = url
        seenMethod = init.method
        seenSignal = init.signal
        return response(true, 200, '42')
      },
    })
    await probe.probe('https://pbs.twimg.com/b.jpg')
    expect(seenUrl).toBe('https://pbs.twimg.com/b.jpg')
    expect(seenMethod).toBe('HEAD')
    expect(seenSignal).toBeInstanceOf(AbortSignal)
    expect(seenSignal?.aborted).toBe(false)
  })

  it('fails open to null on a missing content-length header', async () => {
    const probe = makeSizeProbe({ fetch: fakeFetch(response(true, 200, null)) })
    await expect(probe.probe('https://pbs.twimg.com/a.jpg')).resolves.toBeNull()
  })

  it('fails open to null on a non-numeric content-length header', async () => {
    const probe = makeSizeProbe({ fetch: fakeFetch(response(true, 200, 'not-a-number')) })
    await expect(probe.probe('https://pbs.twimg.com/a.jpg')).resolves.toBeNull()
  })

  it.each(['1.5', '9007199254740992', '-1'])(
    'fails open to null on unsafe content-length %s',
    async (length) => {
      const probe = makeSizeProbe({ fetch: fakeFetch(response(true, 200, length)) })
      await expect(probe.probe('https://pbs.twimg.com/a.jpg')).resolves.toBeNull()
    },
  )

  it('fails open to null on a non-ok status', async () => {
    const probe = makeSizeProbe({ fetch: fakeFetch(response(false, 401, '1048576')) })
    await expect(probe.probe('https://pbs.twimg.com/a.jpg')).resolves.toBeNull()
  })

  it('fails open to null when fetch rejects (never throws)', async () => {
    const probe = makeSizeProbe({
      fetch: async () => {
        throw new Error('network down')
      },
    })
    await expect(probe.probe('https://pbs.twimg.com/a.jpg')).resolves.toBeNull()
  })

  it('aborts a stalled HEAD probe at its deadline', async () => {
    vi.useFakeTimers()
    try {
      const result = makeSizeProbe({ fetch: stallUntilAborted, timeoutMs: 10 }).probe(
        'https://pbs.twimg.com/a.jpg',
      )

      await vi.advanceTimersByTimeAsync(10)
      await expect(result).resolves.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('makeGuardedProbeFetch', () => {
  it('forces redirect rejection while preserving HEAD + signal', async () => {
    const controller = new AbortController()
    const seen: RequestInit[] = []
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen.push(init ?? {})
      return new Response(null, {
        status: 200,
        headers: { 'content-length': '42' },
      })
    }) as typeof fetch

    await makeGuardedProbeFetch(fetchImpl)('https://pbs.twimg.com/a.jpg', {
      method: 'HEAD',
      signal: controller.signal,
    })

    expect(seen).toEqual([{ method: 'HEAD', signal: controller.signal, redirect: 'error' }])
  })

  it('turns a redirect into no size without dereferencing its target', async () => {
    const cancel = vi.fn<() => Promise<void>>(async () => {})
    const fetchImpl = vi.fn<() => Promise<Response>>(async () => {
      return {
        ok: false,
        status: 302,
        redirected: false,
        type: 'default',
        headers: new Headers({ location: 'https://evil.com/target' }),
        body: { cancel },
      } as unknown as Response
    }) as unknown as typeof fetch
    const probe = makeSizeProbe({ fetch: makeGuardedProbeFetch(fetchImpl) })

    await expect(probe.probe('https://pbs.twimg.com/a.jpg')).resolves.toBeNull()
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
  })
})
