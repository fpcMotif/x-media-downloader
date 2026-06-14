import { describe, it, expect } from 'vitest'
import {
  UnsafeUrlError,
  assertAllowedMediaUrl,
  assertAllowedMediaUrls,
  guardedFetch,
} from './url-guard'

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

  it('rejects RFC-1918 / loopback / metadata IP literals', () => {
    for (const ip of [
      'https://10.0.0.1/',
      'https://192.168.1.5/',
      'https://172.16.0.1/',
      'https://127.0.0.1/',
      'https://169.254.169.254/',
    ]) {
      expect(() => assertAllowedMediaUrl(ip)).toThrow(UnsafeUrlError)
    }
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

  it('bounds redirect chains (too many hops throws)', async () => {
    const fetchImpl = (() =>
      Promise.resolve(resp(302, 'https://pbs.twimg.com/loop'))) as unknown as typeof fetch
    await expect(
      guardedFetch('https://pbs.twimg.com/loop', {}, fetchImpl, 3),
    ).rejects.toBeInstanceOf(UnsafeUrlError)
  })
})
