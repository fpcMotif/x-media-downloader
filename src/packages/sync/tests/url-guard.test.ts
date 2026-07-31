import { describe, it, expect } from 'vitest'
import {
  UnsafeUrlError,
  assertAllowedMediaUrl,
  assertAllowedMediaUrls,
  guardedFetch,
  partitionAllowedMediaItems,
} from '../url-guard'
import { cdnHostsForAllAdapters } from '@/core/adapters/registry'
import type { MediaItem } from '@/packages/schema'

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

describe('assertAllowedMediaUrl — registry-derived Meta CDN allow-list', () => {
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
  // through url-guard's OWN public surface — assertAllowedMediaUrl's
  // accept/reject behavior — not registry data equality alone.
  it('pins the exact registry-derived CDN allow-list, exercised through assertAllowedMediaUrl', () => {
    const pinned: ReadonlyArray<{ host: string; includeSubdomains: boolean }> = [
      { host: 'pbs.twimg.com', includeSubdomains: false },
      { host: 'video.twimg.com', includeSubdomains: false },
      { host: 'cdninstagram.com', includeSubdomains: true },
    ]
    expect(cdnHostsForAllAdapters()).toEqual(pinned)

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

const resp = (status: number, location?: string): Response =>
  new Response(null, { status, headers: location ? { location } : {} })

describe('guardedFetch', () => {
  it('fetches an allowed URL with manual redirect handling and returns the response', async () => {
    const calls: Array<{ url: string; redirect: RequestRedirect | undefined }> = []
    const fetchImpl = ((url: string, init: RequestInit) => {
      calls.push({ url, redirect: init.redirect })
      return Promise.resolve(resp(200))
    }) as unknown as typeof fetch
    const r = await guardedFetch('https://pbs.twimg.com/media/AAA', {}, fetchImpl)
    expect(r.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.redirect).toBe('manual')
  })

  it('re-runs the full guard on each redirect hop and follows an allowed redirect', async () => {
    const fetchImpl = ((url: string) =>
      Promise.resolve(
        url === 'https://pbs.twimg.com/start'
          ? resp(302, 'https://video.twimg.com/final.mp4')
          : resp(200),
      )) as unknown as typeof fetch
    const r = await guardedFetch('https://pbs.twimg.com/start', {}, fetchImpl)
    expect(r.status).toBe(200)
  })

  it('rejects a redirect to a non-allowlisted host', async () => {
    const fetchImpl = (() =>
      Promise.resolve(resp(302, 'https://evil.com/x'))) as unknown as typeof fetch
    await expect(guardedFetch('https://pbs.twimg.com/start', {}, fetchImpl)).rejects.toBeInstanceOf(
      UnsafeUrlError,
    )
  })

  it('rejects a redirect to a metadata IP', async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        resp(302, 'https://169.254.169.254/latest/meta-data/'),
      )) as unknown as typeof fetch
    await expect(guardedFetch('https://pbs.twimg.com/start', {}, fetchImpl)).rejects.toBeInstanceOf(
      UnsafeUrlError,
    )
  })

  it('validates the initial url before any fetch happens', async () => {
    let called = false
    const fetchImpl = (() => {
      called = true
      return Promise.resolve(resp(200))
    }) as unknown as typeof fetch
    await expect(guardedFetch('http://evil.com/x', {}, fetchImpl)).rejects.toBeInstanceOf(
      UnsafeUrlError,
    )
    expect(called).toBe(false)
  })

  it('hands back a 3xx with no Location header as-is (nothing to follow)', async () => {
    const fetchImpl = (() => Promise.resolve(resp(302))) as unknown as typeof fetch
    const r = await guardedFetch('https://pbs.twimg.com/media/AAA', {}, fetchImpl)
    expect(r.status).toBe(302)
  })

  it('hands back a 3xx with an empty Location header as-is', async () => {
    const fetchImpl = (() => {
      const h = new Headers()
      h.set('location', '')
      return Promise.resolve(new Response(null, { status: 302, headers: h }))
    }) as unknown as typeof fetch
    const r = await guardedFetch('https://pbs.twimg.com/media/AAA', {}, fetchImpl)
    expect(r.status).toBe(302)
  })

  it('bounds redirect chains (too many hops throws)', async () => {
    const fetchImpl = (() =>
      Promise.resolve(resp(302, 'https://pbs.twimg.com/loop'))) as unknown as typeof fetch
    await expect(
      guardedFetch('https://pbs.twimg.com/loop', {}, fetchImpl, 3),
    ).rejects.toBeInstanceOf(UnsafeUrlError)
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

describe('guardedFetch — adversarial redirect shapes (SSRF)', () => {
  it('rejects a protocol-relative redirect that swaps to a metadata host', async () => {
    // `Location: //169.254.169.254/…` keeps the scheme but swaps the host; it must
    // resolve against the current URL and re-fail the guard, not slip through.
    const fetchImpl = (() =>
      Promise.resolve(resp(302, '//169.254.169.254/latest/meta-data/'))) as unknown as typeof fetch
    const e = await guardedFetch('https://pbs.twimg.com/start', {}, fetchImpl).catch((x) => x)
    expect(e).toBeInstanceOf(UnsafeUrlError)
    expect((e as UnsafeUrlError).reason).toMatch(/private\/link-local ip/)
  })

  it('follows a relative-path redirect that stays on the allowed host', async () => {
    const seen: string[] = []
    const fetchImpl = ((url: string) => {
      seen.push(url)
      return Promise.resolve(
        url === 'https://pbs.twimg.com/start' ? resp(302, '/media/final.jpg') : resp(200),
      )
    }) as unknown as typeof fetch
    const r = await guardedFetch('https://pbs.twimg.com/start', {}, fetchImpl)
    expect(r.status).toBe(200)
    expect(seen).toEqual(['https://pbs.twimg.com/start', 'https://pbs.twimg.com/media/final.jpg'])
  })

  it('stops after exactly maxHops+1 fetches and reports too-many-redirects', async () => {
    let calls = 0
    const fetchImpl = (() => {
      calls += 1
      return Promise.resolve(resp(302, 'https://pbs.twimg.com/loop'))
    }) as unknown as typeof fetch
    const e = await guardedFetch('https://pbs.twimg.com/loop', {}, fetchImpl, 3).catch((x) => x)
    expect(e).toBeInstanceOf(UnsafeUrlError)
    expect((e as UnsafeUrlError).reason).toMatch(/too many redirects/)
    expect(calls).toBe(4) // maxHops(3) + 1
  })
})

const partitionItem = (over: Partial<MediaItem>): MediaItem => ({
  id: 'm1',
  platform: 'x',
  postId: 'p1',
  author: 'alice',
  type: 'photo',
  url: 'https://pbs.twimg.com/media/A.jpg',
  ext: 'jpg',
  index: 0,
  ...over,
})

describe('partitionAllowedMediaItems', () => {
  it('allows a valid X item', () => {
    const { allowed, rejected } = partitionAllowedMediaItems([partitionItem({})])
    expect(allowed).toHaveLength(1)
    expect(rejected).toEqual([])
  })

  it('allows a valid Meta item', () => {
    const { allowed, rejected } = partitionAllowedMediaItems([
      partitionItem({
        platform: 'instagram',
        url: 'https://scontent.cdninstagram.com/v/example.jpg',
      }),
    ])
    expect(allowed).toHaveLength(1)
    expect(rejected).toEqual([])
  })

  it('rejects a hostile host with its reason', () => {
    const { allowed, rejected } = partitionAllowedMediaItems([
      partitionItem({ url: 'https://attacker.example/payload.exe' }),
    ])
    expect(allowed).toEqual([])
    expect(rejected).toEqual([{ itemId: 'm1', reason: 'host not on allow-list: attacker.example' }])
  })

  it('rejects a hostile previewUrl even when the media url is allowed', () => {
    const { allowed, rejected } = partitionAllowedMediaItems([
      partitionItem({ previewUrl: 'https://attacker.example/preview.jpg' }),
    ])
    expect(allowed).toEqual([])
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.itemId).toBe('m1')
  })

  it('keeps valid items in a mixed-order batch and preserves order', () => {
    const good = partitionItem({ id: 'good-1' })
    const bad = partitionItem({ id: 'bad-1', url: 'https://evil.com/x.jpg' })
    const good2 = partitionItem({ id: 'good-2', url: 'https://video.twimg.com/v.mp4' })
    const { allowed, rejected } = partitionAllowedMediaItems([good, bad, good2])
    expect(allowed.map((i) => i.id)).toEqual(['good-1', 'good-2'])
    expect(rejected.map((r) => r.itemId)).toEqual(['bad-1'])
  })

  it('propagates unexpected (non-guard) errors', () => {
    const boom = partitionItem({})
    Object.defineProperty(boom, 'url', {
      get() {
        throw new Error('boom')
      },
    })
    expect(() => partitionAllowedMediaItems([boom])).toThrow('boom')
  })
})
