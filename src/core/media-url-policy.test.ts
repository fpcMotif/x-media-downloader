import { describe, it, expect, vi } from 'vitest'
import {
  UnsafeUrlError,
  assertAllowedMediaUrl,
  assertAllowedMediaUrls,
  guardedFetch,
  makeMediaFetchPort,
} from './media-url-policy'
import { cdnHostsForAllPlatforms } from './adapters/catalog'

const thrown = (fn: () => unknown): unknown => {
  try {
    fn()
    return undefined
  } catch (e) {
    return e
  }
}

describe('assertAllowedMediaUrl', () => {
  it('allows original-quality pbs.twimg photo URLs', () => {
    const u = assertAllowedMediaUrl('https://pbs.twimg.com/media/AAA?format=jpg&name=orig')
    expect(u.hostname).toBe('pbs.twimg.com')
  })

  it('allows video.twimg MP4 URLs (incl. the ?tag= param)', () => {
    expect(() =>
      assertAllowedMediaUrl('https://video.twimg.com/ext_tw_video/BBB.mp4?tag=12'),
    ).not.toThrow()
  })

  it('rejects non-https schemes', () => {
    expect(() => assertAllowedMediaUrl('http://pbs.twimg.com/media/AAA')).toThrow(UnsafeUrlError)
  })

  it('rejects a host not on the exact allow-list', () => {
    expect(() => assertAllowedMediaUrl('https://evil.com/x')).toThrow(UnsafeUrlError)
  })

  it('rejects a look-alike subdomain (suffix attack)', () => {
    expect(() => assertAllowedMediaUrl('https://pbs.twimg.com.evil.com/x')).toThrow(UnsafeUrlError)
    expect(() => assertAllowedMediaUrl('https://evilpbs.twimg.com/x')).toThrow(UnsafeUrlError)
  })

  it('rejects embedded credentials', () => {
    expect(() => assertAllowedMediaUrl('https://user:pass@pbs.twimg.com/media/AAA')).toThrow(
      UnsafeUrlError,
    )
  })

  it('rejects a non-443 port', () => {
    expect(() => assertAllowedMediaUrl('https://pbs.twimg.com:8080/media/AAA')).toThrow(
      UnsafeUrlError,
    )
  })

  it('rejects RFC-1918 / loopback / metadata / CGNAT IP literals', () => {
    for (const ip of [
      'https://0.0.0.0/', // this-network
      'https://10.0.0.1/',
      'https://192.168.1.5/',
      'https://172.16.0.1/', // RFC-1918 /12 low
      'https://172.31.255.1/', // RFC-1918 /12 high
      'https://127.0.0.1/',
      'https://169.254.169.254/',
      'https://100.64.0.1/', // CGNAT /10 low
      'https://100.127.0.1/', // CGNAT /10 high
    ]) {
      const e = thrown(() => assertAllowedMediaUrl(ip))
      expect(e).toBeInstanceOf(UnsafeUrlError)
      expect((e as UnsafeUrlError).reason).toMatch(/private\/link-local ip/)
    }
  })

  it('rejects an out-of-range-octet host that the URL parser refuses to parse', () => {
    // WHATWG URL parsing rejects 999.x as an invalid IPv4 before our check runs.
    const e = thrown(() => assertAllowedMediaUrl('https://999.1.1.1/'))
    expect(e).toBeInstanceOf(UnsafeUrlError)
    expect((e as UnsafeUrlError).reason).toMatch(/unparseable url/)
  })

  it('rejects a public IPv4 literal (not private) as a disallowed ip-literal host', () => {
    const e = thrown(() => assertAllowedMediaUrl('https://8.8.8.8/'))
    expect(e).toBeInstanceOf(UnsafeUrlError)
    expect((e as UnsafeUrlError).reason).toMatch(/ip-literal host not allowed/)
  })

  it('rejects an IPv6 literal host (bracketed)', () => {
    const e = thrown(() => assertAllowedMediaUrl('https://[2606:4700:4700::1111]/'))
    expect(e).toBeInstanceOf(UnsafeUrlError)
    expect((e as UnsafeUrlError).reason).toMatch(/ip-literal host not allowed/)
  })

  it('rejects an IPv4-mapped IPv6 loopback literal (::ffff:127.0.0.1)', () => {
    // The classic SSRF bypass — smuggle 127.0.0.1 inside an IPv6 literal. The
    // colon-bearing host is caught by the ip-literal gate regardless.
    const e = thrown(() => assertAllowedMediaUrl('https://[::ffff:127.0.0.1]/'))
    expect(e).toBeInstanceOf(UnsafeUrlError)
    expect((e as UnsafeUrlError).reason).toMatch(/ip-literal host not allowed/)
  })

  it('allows a 172.x address outside the RFC-1918 /12 range only if on the CDN list (host still wins)', () => {
    // 172.15/172.32 are public; they fail on the allow-list, not the private check.
    const e = thrown(() => assertAllowedMediaUrl('https://172.15.0.1/'))
    expect((e as UnsafeUrlError).reason).toMatch(/ip-literal host not allowed/)
  })

  it('rejects an unparseable url', () => {
    expect(() => assertAllowedMediaUrl('not a url')).toThrow(UnsafeUrlError)
  })

  it('carries a tagged reason', () => {
    const e = thrown(() => assertAllowedMediaUrl('https://evil.com/x'))
    expect(e).toBeInstanceOf(UnsafeUrlError)
    expect((e as UnsafeUrlError)._tag).toBe('UnsafeUrlError')
    expect((e as UnsafeUrlError).reason).toMatch(/host/)
  })
})

describe('assertAllowedMediaUrl — catalog-derived Meta CDN allow-list', () => {
  it('allows a region-prefixed cdninstagram.com subdomain', () => {
    expect(() =>
      assertAllowedMediaUrl('https://scontent-lax3-1.cdninstagram.com/v/t51.82787-15/AAA_n.jpg'),
    ).not.toThrow()
  })

  it('allows the bare cdninstagram.com host', () => {
    expect(() =>
      assertAllowedMediaUrl('https://cdninstagram.com/v/t51.82787-15/AAA_n.jpg'),
    ).not.toThrow()
  })

  it('rejects a look-alike host that merely starts with the allowed name (dot-anchoring)', () => {
    expect(() => assertAllowedMediaUrl('https://evilcdninstagram.com/x')).toThrow(UnsafeUrlError)
  })

  it('rejects a look-alike host that merely ends with the allowed name (suffix attack)', () => {
    expect(() => assertAllowedMediaUrl('https://cdninstagram.com.evil.com/x')).toThrow(
      UnsafeUrlError,
    )
  })

  it('still allows pbs.twimg.com', () => {
    expect(() => assertAllowedMediaUrl('https://pbs.twimg.com/media/AAA.jpg')).not.toThrow()
  })

  it('rejects a subdomain of pbs.twimg.com — X hosts are exact-only, no includeSubdomains', () => {
    expect(() => assertAllowedMediaUrl('https://foo.pbs.twimg.com/media/AAA.jpg')).toThrow(
      UnsafeUrlError,
    )
  })

  // Security pin: the FULL derived allow-list content, spelled out exactly.
  // A new adapter (or a new cdnHosts entry on an existing one) widens what
  // guardedFetch/Cloud Upload can reach — this must fail and be consciously
  // updated (not silently pass) whenever that set changes. Unlike
  // registry.test.ts's structural pin on the same list, this one is proved
  // through the media URL policy's public surface — assertAllowedMediaUrl's
  // accept/reject behavior — not registry data equality alone.
  it('pins the exact catalog-derived CDN allow-list, exercised through assertAllowedMediaUrl', () => {
    const pinned: ReadonlyArray<{ host: string; includeSubdomains: boolean }> = [
      { host: 'pbs.twimg.com', includeSubdomains: false },
      { host: 'video.twimg.com', includeSubdomains: false },
      { host: 'cdninstagram.com', includeSubdomains: true },
    ]
    expect(cdnHostsForAllPlatforms()).toEqual(pinned)

    // The canonical representative URL for every pinned host is accepted.
    for (const { host } of pinned) {
      expect(assertAllowedMediaUrl(`https://${host}/media`).hostname).toBe(host)
    }

    // A subdomain is accepted only for hosts that opt into includeSubdomains.
    for (const { host } of pinned.filter((entry) => entry.includeSubdomains)) {
      expect(assertAllowedMediaUrl(`https://sub.${host}/media`).hostname).toBe(`sub.${host}`)
    }
    for (const { host } of pinned.filter((entry) => !entry.includeSubdomains)) {
      expect(() => assertAllowedMediaUrl(`https://sub.${host}/media`)).toThrow(UnsafeUrlError)
    }
  })
})

describe('assertAllowedMediaUrls', () => {
  it('validates both url and previewUrl (skips undefined)', () => {
    expect(() =>
      assertAllowedMediaUrls('https://video.twimg.com/x.mp4', 'https://pbs.twimg.com/poster.jpg'),
    ).not.toThrow()
    expect(() =>
      assertAllowedMediaUrls('https://video.twimg.com/x.mp4', 'https://evil.com/p.jpg'),
    ).toThrow(UnsafeUrlError)
    expect(() => assertAllowedMediaUrls('https://pbs.twimg.com/a', undefined)).not.toThrow()
  })
})

const resp = (status: number): Response => new Response(null, { status })

describe('guardedFetch', () => {
  it('forwards method + identical signal while forcing redirect rejection', async () => {
    const controller = new AbortController()
    const calls: Array<{
      url: string
      method: string | undefined
      redirect: RequestRedirect | undefined
      signal: AbortSignal | null | undefined
    }> = []
    const fetchImpl = ((url: string, init: RequestInit) => {
      calls.push({
        url,
        method: init.method,
        redirect: init.redirect,
        signal: init.signal,
      })
      return Promise.resolve(resp(200))
    }) as unknown as typeof fetch
    const r = await makeMediaFetchPort(fetchImpl).fetch('https://pbs.twimg.com/media/AAA', {
      method: 'HEAD',
      signal: controller.signal,
    })
    expect(r.status).toBe(200)
    expect(calls).toEqual([
      {
        url: 'https://pbs.twimg.com/media/AAA',
        method: 'HEAD',
        redirect: 'error',
        signal: controller.signal,
      },
    ])
  })

  it('validates the initial url before any fetch happens', async () => {
    const fetchImpl = vi.fn<() => Promise<Response>>(async () =>
      resp(200),
    ) as unknown as typeof fetch
    await expect(guardedFetch('http://evil.com/x', {}, fetchImpl)).rejects.toBeInstanceOf(
      UnsafeUrlError,
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('forces the Fetch-standard error mode, so no redirect target is requested', async () => {
    const seen: string[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push(url)
      if (init?.redirect === 'error') throw new TypeError('redirect blocked')
      return resp(200)
    }) as typeof fetch

    await expect(guardedFetch('https://pbs.twimg.com/redirect', {}, fetchImpl)).rejects.toThrow(
      'redirect blocked',
    )
    expect(seen).toEqual(['https://pbs.twimg.com/redirect'])
  })

  it('fails closed and cancels if an injected transport ignores redirect mode', async () => {
    const cancel = vi.fn<() => Promise<void>>(async () => {})
    const redirected = {
      status: 302,
      type: 'default',
      redirected: false,
      body: { cancel },
    } as unknown as Response
    const fetchImpl = vi.fn<() => Promise<Response>>(
      async () => redirected,
    ) as unknown as typeof fetch

    await expect(
      guardedFetch('https://pbs.twimg.com/redirect', {}, fetchImpl),
    ).rejects.toMatchObject({ reason: 'redirects are not allowed' })
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('rejects an opaque manual-redirect response', async () => {
    const response = {
      status: 0,
      type: 'opaqueredirect',
      redirected: false,
      body: null,
    } as Response
    const fetchImpl = (async () => response) as typeof fetch

    await expect(
      guardedFetch('https://pbs.twimg.com/redirect', {}, fetchImpl),
    ).rejects.toBeInstanceOf(UnsafeUrlError)
  })

  it('preserves the caller AbortSignal and its rejection reason', async () => {
    const controller = new AbortController()
    const reason = new Error('caller aborted')
    controller.abort(reason)
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      throw init?.signal?.reason
    }) as typeof fetch

    await expect(
      guardedFetch('https://pbs.twimg.com/media/AAA', { signal: controller.signal }, fetchImpl),
    ).rejects.toBe(reason)
  })

  it('calls fetch with a global receiver, never unbound (Illegal invocation)', async () => {
    // background passes the bare global `fetch` straight in; calling it unbound runs
    // it with `this === undefined`, which the MV3 SW rejects. A non-arrow stub exposes
    // the dynamic `this` (arrow mocks ignore it); bindFetch must detach it to globalThis.
    const brandChecked = function (this: unknown) {
      if (this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch' on 'WorkerGlobalScope': Illegal invocation")
      }
      return Promise.resolve(resp(200))
    } as typeof fetch
    const r = await guardedFetch('https://pbs.twimg.com/media/AAA', {}, brandChecked)
    expect(r.status).toBe(200)
  })
})
