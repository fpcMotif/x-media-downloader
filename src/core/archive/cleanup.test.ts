import { describe, it, expect, vi } from 'vitest'
import {
  buildCleanupRequest,
  csrfFromCookie,
  cleanupHeaders,
  isCleanupSuccess,
  makeCleanupPort,
  CLEANUP_QUERY_IDS,
} from './cleanup'
import type { CleanupRequest } from './cleanup'

const okResponse = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  }) as unknown as Response

describe('CLEANUP_QUERY_IDS', () => {
  it('exposes two distinct non-empty (opaque) query ids', () => {
    const del = CLEANUP_QUERY_IDS.DeleteBookmark
    const unfav = CLEANUP_QUERY_IDS.UnfavoriteTweet
    expect(typeof del).toBe('string')
    expect(typeof unfav).toBe('string')
    expect(del.length).toBeGreaterThan(0)
    expect(unfav.length).toBeGreaterThan(0)
    expect(del).not.toBe(unfav)
  })
})

describe('buildCleanupRequest', () => {
  it('maps bookmarks to DeleteBookmark with the right url + body', () => {
    const req = buildCleanupRequest('123', 'bookmarks')
    expect(req.op).toBe('DeleteBookmark')
    expect(req.tweetId).toBe('123')
    expect(req.source).toBe('bookmarks')
    expect(req.url).toBe(
      `https://x.com/i/api/graphql/${CLEANUP_QUERY_IDS.DeleteBookmark}/DeleteBookmark`,
    )
    const body = JSON.parse(req.body)
    expect(body).toEqual({
      variables: { tweet_id: '123' },
      queryId: CLEANUP_QUERY_IDS.DeleteBookmark,
    })
  })

  it('maps likes to UnfavoriteTweet with the right url + body', () => {
    const req = buildCleanupRequest('456', 'likes')
    expect(req.op).toBe('UnfavoriteTweet')
    expect(req.url).toBe(
      `https://x.com/i/api/graphql/${CLEANUP_QUERY_IDS.UnfavoriteTweet}/UnfavoriteTweet`,
    )
    const body = JSON.parse(req.body)
    expect(body).toEqual({
      variables: { tweet_id: '456' },
      queryId: CLEANUP_QUERY_IDS.UnfavoriteTweet,
    })
  })
})

describe('csrfFromCookie', () => {
  it('parses ct0 out of a document.cookie string', () => {
    expect(csrfFromCookie('guest_id=v1; ct0=abcdef123; auth_token=zzz')).toBe('abcdef123')
  })

  it('parses ct0 when it is the first or only pair', () => {
    expect(csrfFromCookie('ct0=solo')).toBe('solo')
    expect(csrfFromCookie('ct0=first; other=x')).toBe('first')
  })

  it('returns null when ct0 is absent or the cookie is empty', () => {
    expect(csrfFromCookie('guest_id=v1; auth_token=zzz')).toBeNull()
    expect(csrfFromCookie('')).toBeNull()
  })

  it('does not match a substring key like my_ct0', () => {
    expect(csrfFromCookie('my_ct0=nope; lang=en')).toBeNull()
  })
})

describe('cleanupHeaders', () => {
  it('carries content-type, the csrf token, and a non-empty bearer', () => {
    const h = cleanupHeaders('tok-123')
    expect(h['content-type']).toBe('application/json')
    expect(h['x-csrf-token']).toBe('tok-123')
    const auth = h['authorization'] ?? h['Authorization']
    expect(typeof auth).toBe('string')
    expect((auth as string).toLowerCase().startsWith('bearer ')).toBe(true)
    expect((auth as string).length).toBeGreaterThan('Bearer '.length)
  })
})

describe('isCleanupSuccess', () => {
  it('is true for a parsed body with a data object and no errors', () => {
    expect(isCleanupSuccess({ data: { tweet_bookmark_delete: 'Done' } })).toBe(true)
  })

  it('is true with an empty errors array alongside data', () => {
    expect(isCleanupSuccess({ data: {}, errors: [] })).toBe(true)
  })

  it('is false when errors is a non-empty array', () => {
    expect(isCleanupSuccess({ data: {}, errors: [{ message: 'boom' }] })).toBe(false)
    expect(isCleanupSuccess({ errors: [{ message: 'boom' }] })).toBe(false)
  })

  it('is false without a data object', () => {
    expect(isCleanupSuccess({})).toBe(false)
    expect(isCleanupSuccess(null)).toBe(false)
    expect(isCleanupSuccess('Done')).toBe(false)
    expect(isCleanupSuccess(undefined)).toBe(false)
  })
})

describe('makeCleanupPort', () => {
  const req: CleanupRequest = buildCleanupRequest('123', 'bookmarks')

  it('returns true on a successful mutation (data, no errors)', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(okResponse({ data: { ok: true } }))
    const port = makeCleanupPort({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getCookie: () => 'ct0=tok',
    })
    expect(await port.run(req)).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe(req.url)
    expect((init as RequestInit).method).toBe('POST')
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers['x-csrf-token']).toBe('tok')
  })

  it('returns false when the cookie carries no ct0 (missing csrf, no fetch)', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const port = makeCleanupPort({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getCookie: () => 'guest_id=v1',
    })
    expect(await port.run(req)).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('returns false (never throws) when fetch rejects', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('network down'))
    const port = makeCleanupPort({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getCookie: () => 'ct0=tok',
    })
    await expect(port.run(req)).resolves.toBe(false)
  })

  it('returns false when the response body reports errors', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(okResponse({ errors: [{ message: 'rate limited' }] }))
    const port = makeCleanupPort({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getCookie: () => 'ct0=tok',
    })
    expect(await port.run(req)).toBe(false)
  })
})
