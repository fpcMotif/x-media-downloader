import { beforeEach, describe, expect, it, vi } from 'vitest'

type LoadListener = () => void

type FakeXHRInstance = InstanceType<ReturnType<typeof createFakeXHRClass>>

function createFakeXHRClass() {
  return class FakeXHR {
    status = 200
    responseURL = 'https://x.com/i/api/graphql/abc/TweetDetail'
    responseText = '{"data":true}'
    listeners = new Map<string, LoadListener>()
    openedWith: unknown[] | undefined

    addEventListener(type: string, listener: LoadListener): void {
      this.listeners.set(type, listener)
    }

    open(...args: unknown[]): void {
      this.openedWith = args
    }

    load(): void {
      this.listeners.get('load')?.()
    }
  }
}

const nativeFetch = window.fetch

async function loadContentScript() {
  vi.resetModules()
  const FakeXHR = createFakeXHRClass()
  vi.stubGlobal('defineContentScript', (config: unknown) => config)
  vi.stubGlobal('XMLHttpRequest', FakeXHR)
  const events: unknown[] = []
  document.addEventListener('xmd:media-response', (event) => {
    events.push((event as CustomEvent).detail)
  })
  const mod = await import('../entrypoints/inject.content')
  return {
    config: mod.default as { main(): void; matches: string[]; world: string; runAt: string },
    events,
    FakeXHR,
  }
}

beforeEach(() => {
  delete window.xmdResponseTeeInstalled
  window.fetch = nativeFetch
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe.sequential('MAIN-world response tee content script', () => {
  it('registers the expected X/Twitter content-script scope', async () => {
    const { config } = await loadContentScript()

    expect(config.matches).toEqual(['*://x.com/*', '*://twitter.com/*'])
    expect(config.world).toBe('MAIN')
    expect(config.runAt).toBe('document_start')
  })

  it('tees successful media XHR responses and leaves other requests alone', async () => {
    const { config, events, FakeXHR } = await loadContentScript()
    config.main()
    config.main()

    const mediaRequest = new FakeXHR() as FakeXHRInstance
    mediaRequest.open('GET', 'https://x.com/i/api/graphql/abc/TweetDetail')
    mediaRequest.load()

    const nonMediaRequest = new FakeXHR() as FakeXHRInstance
    nonMediaRequest.open('GET', 'https://x.com/i/api/graphql/abc/CreateBookmark')
    nonMediaRequest.load()

    expect(mediaRequest.openedWith).toEqual(['GET', 'https://x.com/i/api/graphql/abc/TweetDetail'])
    expect(events).toEqual([{ path: '/i/api/graphql/abc/TweetDetail', body: '{"data":true}' }])
  })

  it('does not tee XHR failures or malformed response URLs', async () => {
    const { config, events, FakeXHR } = await loadContentScript()
    config.main()

    const failed = new FakeXHR() as FakeXHRInstance
    failed.status = 500
    failed.open('GET', 'https://x.com/i/api/graphql/abc/UserMedia')
    failed.load()

    const malformed = new FakeXHR() as FakeXHRInstance
    malformed.responseURL = '::::'
    malformed.open('GET', 'https://x.com/i/api/graphql/abc/UserMedia')
    malformed.load()

    expect(events).toEqual([])
  })

  it('tees successful media fetch responses for string, URL, and Request inputs', async () => {
    const { config, events } = await loadContentScript()
    const fetch = vi.fn<(input: RequestInfo | URL) => Promise<Response>>((input) =>
      Promise.resolve(new Response(`body:${String(input)}`)),
    )
    vi.stubGlobal('fetch', fetch)
    config.main()

    await window.fetch('https://x.com/i/api/graphql/abc/TweetDetail')
    await window.fetch(new URL('https://x.com/i/api/graphql/abc/TweetResultByRestId'))
    await window.fetch(new Request('https://x.com/i/api/graphql/abc/UserMedia'))
    await Promise.resolve()

    expect(fetch).toHaveBeenCalledTimes(3)
    expect(events).toEqual([
      {
        path: '/i/api/graphql/abc/TweetDetail',
        body: 'body:https://x.com/i/api/graphql/abc/TweetDetail',
      },
      {
        path: '/i/api/graphql/abc/TweetResultByRestId',
        body: 'body:https://x.com/i/api/graphql/abc/TweetResultByRestId',
      },
      {
        path: '/i/api/graphql/abc/UserMedia',
        body: 'body:[object Request]',
      },
    ])
  })

  it('ignores non-ok fetches, clone text failures, non-media URLs, and unreadable inputs', async () => {
    const { config, events } = await loadContentScript()
    const badClone = {
      ok: true,
      clone: () => ({
        text: () => Promise.reject(new Error('body unavailable')),
      }),
    } as Response
    const fetch = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response('skip', { status: 404 }))
      .mockResolvedValueOnce(badClone)
      .mockResolvedValueOnce(new Response('not media'))
      .mockResolvedValueOnce(new Response('unreadable'))
    vi.stubGlobal('fetch', fetch)
    config.main()

    await window.fetch('https://x.com/i/api/graphql/abc/TweetDetail')
    await window.fetch('https://x.com/i/api/graphql/abc/UserMedia')
    await window.fetch('https://x.com/i/api/graphql/abc/CreateBookmark')
    await window.fetch({
      get url(): string {
        throw new Error('no url')
      },
    } as Request)
    await Promise.resolve()

    expect(events).toEqual([])
  })
})
