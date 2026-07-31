import { describe, it, expect } from 'vitest'
import { makeSizeProbe, type ProbeFetch, type ProbeResponse } from '../size-probe'

const response = (ok: boolean, status: number, contentLength: string | null): ProbeResponse => ({
  ok,
  status,
  headers: { get: (name) => (name.toLowerCase() === 'content-length' ? contentLength : null) },
})

const fakeFetch =
  (res: ProbeResponse): ProbeFetch =>
  async () =>
    res

describe('makeSizeProbe', () => {
  it('returns the parsed content-length on success', async () => {
    const probe = makeSizeProbe({ fetch: fakeFetch(response(true, 200, '1048576')) })
    await expect(probe.probe('https://pbs.twimg.com/a.jpg')).resolves.toBe(1048576)
  })

  it('issues a HEAD request to the given url', async () => {
    let seenUrl: string | undefined
    let seenMethod: string | undefined
    const probe = makeSizeProbe({
      fetch: async (url, init) => {
        seenUrl = url
        seenMethod = init.method
        return response(true, 200, '42')
      },
    })
    await probe.probe('https://pbs.twimg.com/b.jpg')
    expect(seenUrl).toBe('https://pbs.twimg.com/b.jpg')
    expect(seenMethod).toBe('HEAD')
  })

  it('fails open to null on a missing content-length header', async () => {
    const probe = makeSizeProbe({ fetch: fakeFetch(response(true, 200, null)) })
    await expect(probe.probe('https://pbs.twimg.com/a.jpg')).resolves.toBeNull()
  })

  it('fails open to null on a non-numeric content-length header', async () => {
    const probe = makeSizeProbe({ fetch: fakeFetch(response(true, 200, 'not-a-number')) })
    await expect(probe.probe('https://pbs.twimg.com/a.jpg')).resolves.toBeNull()
  })

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
})
