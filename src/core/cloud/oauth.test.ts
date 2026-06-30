import { describe, it, expect } from 'vitest'
import { Effect } from 'effect'
import {
  base64UrlEncode,
  buildAuthUrl,
  computeCodeChallenge,
  exchangeCode,
  generateCodeVerifier,
  isTokenExpired,
  parseAuthRedirect,
  randomState,
  refreshAccessToken,
  OAuthError,
} from './oauth'
import { GDRIVE_OAUTH, DROPBOX_OAUTH } from './types'
import { classifyUploadError } from './status'
import { errorReason } from '../error'
import { makeFetchServiceLive } from '../fetch-service'

const REDIRECT = 'https://abcdef.chromiumapp.org/'

/** Run a token Effect against a FetchService backed by the test's fetch. */
const runExchange = (fetchImpl: typeof fetch, input: Parameters<typeof exchangeCode>[0]) =>
  Effect.runPromise(exchangeCode(input).pipe(Effect.provide(makeFetchServiceLive(fetchImpl))))
const runRefresh = (fetchImpl: typeof fetch, input: Parameters<typeof refreshAccessToken>[0]) =>
  Effect.runPromise(refreshAccessToken(input).pipe(Effect.provide(makeFetchServiceLive(fetchImpl))))

describe('PKCE primitives', () => {
  it('base64UrlEncode is url-safe and unpadded', () => {
    const out = base64UrlEncode(Uint8Array.of(251, 255, 191, 0))
    expect(out).not.toMatch(/[+/=]/)
  })

  it('code verifier is 43+ chars, url-safe', () => {
    const v = generateCodeVerifier()
    expect(v.length).toBeGreaterThanOrEqual(43)
    expect(v).not.toMatch(/[+/=]/)
  })

  it('S256 challenge matches a known RFC 7636 vector', async () => {
    // RFC 7636 Appendix B
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    expect(await computeCodeChallenge(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })

  it('challenge is deterministic and differs from the verifier', async () => {
    const v = generateCodeVerifier()
    const c1 = await computeCodeChallenge(v)
    const c2 = await computeCodeChallenge(v)
    expect(c1).toBe(c2)
    expect(c1).not.toBe(v)
  })
})

describe('randomState', () => {
  it('produces a url-safe, non-empty, varying CSRF state', () => {
    const a = randomState()
    const b = randomState()
    expect(a).not.toMatch(/[+/=]/)
    expect(a.length).toBeGreaterThanOrEqual(22)
    expect(a).not.toBe(b)
  })
})

describe('buildAuthUrl', () => {
  it('includes PKCE + provider params (Google)', () => {
    const url = new URL(
      buildAuthUrl(GDRIVE_OAUTH, {
        clientId: 'cid',
        redirectUri: REDIRECT,
        codeChallenge: 'chal',
        state: 'st',
      }),
    )
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('client_id')).toBe('cid')
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('code_challenge')).toBe('chal')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe('st')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/drive')
    expect(url.searchParams.get('scope')).toContain('email')
  })

  it('includes token_access_type=offline (Dropbox)', () => {
    const url = new URL(
      buildAuthUrl(DROPBOX_OAUTH, {
        clientId: 'k',
        redirectUri: REDIRECT,
        codeChallenge: 'c',
        state: 's',
      }),
    )
    expect(url.origin + url.pathname).toBe('https://www.dropbox.com/oauth2/authorize')
    expect(url.searchParams.get('token_access_type')).toBe('offline')
    expect(url.searchParams.get('scope')).toContain('files.content.write')
  })
})

describe('parseAuthRedirect', () => {
  it('returns the code when state matches', () => {
    expect(parseAuthRedirect(`${REDIRECT}?code=AUTH&state=xyz`, 'xyz')).toEqual({ code: 'AUTH' })
  })

  it('rejects a state mismatch (CSRF)', () => {
    expect(() => parseAuthRedirect(`${REDIRECT}?code=AUTH&state=evil`, 'xyz')).toThrow(OAuthError)
  })

  it('surfaces a provider error param', () => {
    expect(() => parseAuthRedirect(`${REDIRECT}?error=access_denied&state=xyz`, 'xyz')).toThrow(
      /consent failed: access_denied/,
    )
  })

  it('rejects a redirect with no code', () => {
    expect(() => parseAuthRedirect(`${REDIRECT}?state=xyz`, 'xyz')).toThrow(/no authorization code/)
  })

  it('rejects a redirect with an empty code value', () => {
    expect(() => parseAuthRedirect(`${REDIRECT}?code=&state=xyz`, 'xyz')).toThrow(
      /no authorization code/,
    )
  })

  it('rejects a malformed redirect url', () => {
    expect(() => parseAuthRedirect('::: not a url', 'xyz')).toThrow(/malformed redirect/)
  })

  it('throws OAuthError with _tag and exact message on malformed input', () => {
    let caught: unknown
    try {
      parseAuthRedirect('::: not a url', 'xyz')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(OAuthError)
    const e = caught as OAuthError
    expect(e._tag).toBe('OAuthError')
    expect(e.message).toBe('malformed redirect url')
    expect(e.context).toBe('malformed-url')
  })
})

describe('OAuthError classification regression', () => {
  it('no-offline-grant message classifies identically to the raw string', () => {
    const raw = 'no refresh_token — reconnect and grant offline access'
    const e = new OAuthError({ message: raw, context: 'no-offline-grant' })
    expect(classifyUploadError(errorReason(e))).toBe(classifyUploadError(raw))
  })

  it('non-json message classifies identically to the raw string', () => {
    const raw = 'token endpoint returned non-JSON (HTTP 502)'
    const e = new OAuthError({ message: raw, context: 'non-json' })
    expect(classifyUploadError(errorReason(e))).toBe(classifyUploadError(raw))
  })
})

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('exchangeCode', () => {
  it('posts PKCE params (no secret) and maps the token response', async () => {
    let captured: { url: string; body: string } | null = null
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      captured = { url: String(url), body: String(init?.body) }
      return jsonResponse({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 })
    }) as unknown as typeof fetch

    const tokens = await runExchange(fetchImpl, {
      cfg: GDRIVE_OAUTH,
      clientId: 'cid',
      code: 'CODE',
      codeVerifier: 'VER',
      redirectUri: REDIRECT,
      now: 1_000,
    })

    expect(tokens).toEqual({ accessToken: 'AT', refreshToken: 'RT', expiresAt: 1_000 + 3_600_000 })
    expect(captured!.url).toBe('https://oauth2.googleapis.com/token')
    const params = new URLSearchParams(captured!.body)
    expect(params.get('grant_type')).toBe('authorization_code')
    expect(params.get('code_verifier')).toBe('VER')
    expect(params.get('code')).toBe('CODE')
    expect(params.has('client_secret')).toBe(false)
  })

  it('derives the account email from a Google id_token', async () => {
    const payload = btoa(JSON.stringify({ email: 'me@example.com' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    const fetchImpl = (async () =>
      jsonResponse({
        access_token: 'AT',
        refresh_token: 'RT',
        expires_in: 3600,
        id_token: `h.${payload}.sig`,
      })) as unknown as typeof fetch
    const tokens = await runExchange(fetchImpl, {
      cfg: GDRIVE_OAUTH,
      clientId: 'cid',
      code: 'c',
      codeVerifier: 'v',
      redirectUri: REDIRECT,
      now: 0,
    })
    expect(tokens.account).toBe('me@example.com')
  })

  it('keeps the account label when present (Dropbox)', async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        access_token: 'AT',
        refresh_token: 'RT',
        expires_in: 14400,
        account_id: 'dbid:abc',
      })) as unknown as typeof fetch
    const tokens = await runExchange(fetchImpl, {
      cfg: DROPBOX_OAUTH,
      clientId: 'k',
      code: 'c',
      codeVerifier: 'v',
      redirectUri: REDIRECT,
      now: 0,
    })
    expect(tokens.account).toBe('dbid:abc')
  })

  it('fails closed when no refresh_token is returned', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ access_token: 'AT', expires_in: 3600 })) as unknown as typeof fetch
    await expect(
      runExchange(fetchImpl, {
        cfg: GDRIVE_OAUTH,
        clientId: 'cid',
        code: 'c',
        codeVerifier: 'v',
        redirectUri: REDIRECT,
        now: 0,
      }),
    ).rejects.toThrow(/no refresh_token/)
  })

  it('surfaces a provider error body', async () => {
    const fetchImpl = (async () =>
      jsonResponse(
        { error: 'invalid_grant', error_description: 'bad code' },
        false,
        400,
      )) as unknown as typeof fetch
    await expect(
      runExchange(fetchImpl, {
        cfg: GDRIVE_OAUTH,
        clientId: 'cid',
        code: 'c',
        codeVerifier: 'v',
        redirectUri: REDIRECT,
        now: 0,
      }),
    ).rejects.toThrow(/bad code/)
  })

  it('fails closed when the token response has no access_token', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ refresh_token: 'RT', expires_in: 3600 })) as unknown as typeof fetch
    await expect(
      runExchange(fetchImpl, {
        cfg: GDRIVE_OAUTH,
        clientId: 'cid',
        code: 'c',
        codeVerifier: 'v',
        redirectUri: REDIRECT,
        now: 0,
      }),
    ).rejects.toThrow(/no access_token/)
  })

  it('falls back to error code, then HTTP status, when no description is present', async () => {
    const onlyCode = (async () =>
      jsonResponse({ error: 'invalid_grant' }, false, 400)) as unknown as typeof fetch
    await expect(
      runExchange(onlyCode, {
        cfg: GDRIVE_OAUTH,
        clientId: 'cid',
        code: 'c',
        codeVerifier: 'v',
        redirectUri: REDIRECT,
        now: 0,
      }),
    ).rejects.toThrow(/invalid_grant/)

    const noBody = (async () => jsonResponse({}, false, 503)) as unknown as typeof fetch
    await expect(
      runExchange(noBody, {
        cfg: GDRIVE_OAUTH,
        clientId: 'cid',
        code: 'c',
        codeVerifier: 'v',
        redirectUri: REDIRECT,
        now: 0,
      }),
    ).rejects.toThrow(/HTTP 503/)
  })

  it('ignores a non-string email claim in the id_token', async () => {
    const payload = btoa(JSON.stringify({ email: 12345 }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    const fetchImpl = (async () =>
      jsonResponse({
        access_token: 'AT',
        refresh_token: 'RT',
        expires_in: 3600,
        id_token: `h.${payload}.s`,
      })) as unknown as typeof fetch
    const tokens = await runExchange(fetchImpl, {
      cfg: GDRIVE_OAUTH,
      clientId: 'cid',
      code: 'c',
      codeVerifier: 'v',
      redirectUri: REDIRECT,
      now: 0,
    })
    expect(tokens.account).toBeUndefined()
  })

  it('fails with an OAuthError when the token endpoint returns non-JSON', async () => {
    const fetchImpl = (async () =>
      new Response('<html>502 Bad Gateway</html>', { status: 502 })) as unknown as typeof fetch
    await expect(
      runExchange(fetchImpl, {
        cfg: GDRIVE_OAUTH,
        clientId: 'cid',
        code: 'c',
        codeVerifier: 'v',
        redirectUri: REDIRECT,
        now: 0,
      }),
    ).rejects.toThrow(/non-JSON/)
  })

  it('ignores a single-segment id_token (no payload) and falls back to no account', async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        access_token: 'AT',
        refresh_token: 'RT',
        expires_in: 3600,
        id_token: 'not-a-jwt',
      })) as unknown as typeof fetch
    const tokens = await runExchange(fetchImpl, {
      cfg: GDRIVE_OAUTH,
      clientId: 'cid',
      code: 'c',
      codeVerifier: 'v',
      redirectUri: REDIRECT,
      now: 0,
    })
    expect(tokens.account).toBeUndefined()
  })

  it('ignores an id_token whose payload is not valid base64/JSON (decode throws)', async () => {
    // '@@@@' is present as the payload segment but atob() rejects it → caught → undefined
    const fetchImpl = (async () =>
      jsonResponse({
        access_token: 'AT',
        refresh_token: 'RT',
        expires_in: 3600,
        id_token: 'head.@@@@.sig',
      })) as unknown as typeof fetch
    const tokens = await runExchange(fetchImpl, {
      cfg: GDRIVE_OAUTH,
      clientId: 'cid',
      code: 'c',
      codeVerifier: 'v',
      redirectUri: REDIRECT,
      now: 0,
    })
    expect(tokens.account).toBeUndefined()
  })

  it('defaults expiry to 1h when expires_in is omitted', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ access_token: 'AT', refresh_token: 'RT' })) as unknown as typeof fetch
    const tokens = await runExchange(fetchImpl, {
      cfg: DROPBOX_OAUTH,
      clientId: 'k',
      code: 'c',
      codeVerifier: 'v',
      redirectUri: REDIRECT,
      now: 1_000,
    })
    expect(tokens.expiresAt).toBe(1_000 + 3_600_000)
  })
})

describe('refreshAccessToken', () => {
  it('posts the refresh grant and returns a new access token', async () => {
    let body = ''
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      body = String(init?.body)
      return jsonResponse({ access_token: 'AT2', expires_in: 3600 })
    }) as unknown as typeof fetch
    const out = await runRefresh(fetchImpl, {
      cfg: GDRIVE_OAUTH,
      clientId: 'cid',
      refreshToken: 'RT',
      now: 5_000,
    })
    expect(out).toEqual({ accessToken: 'AT2', expiresAt: 5_000 + 3_600_000 })
    const params = new URLSearchParams(body)
    expect(params.get('grant_type')).toBe('refresh_token')
    expect(params.get('refresh_token')).toBe('RT')
    expect(params.has('client_secret')).toBe(false)
  })

  it('defaults expiry to 1h when expires_in is omitted', async () => {
    const fetchImpl = (async () => jsonResponse({ access_token: 'AT2' })) as unknown as typeof fetch
    const out = await runRefresh(fetchImpl, {
      cfg: GDRIVE_OAUTH,
      clientId: 'cid',
      refreshToken: 'RT',
      now: 2_000,
    })
    expect(out).toEqual({ accessToken: 'AT2', expiresAt: 2_000 + 3_600_000 })
  })

  it('fails closed when the refresh response has no access_token', async () => {
    const fetchImpl = (async () => jsonResponse({ expires_in: 3600 })) as unknown as typeof fetch
    await expect(
      runRefresh(fetchImpl, { cfg: GDRIVE_OAUTH, clientId: 'cid', refreshToken: 'RT', now: 0 }),
    ).rejects.toThrow(/no access_token/)
  })
})

describe('isTokenExpired', () => {
  it('is true within the skew window', () => {
    expect(isTokenExpired(100_000, 100_000 - 30_000, 60_000)).toBe(true)
  })
  it('is false comfortably before expiry', () => {
    expect(isTokenExpired(100_000, 0, 60_000)).toBe(false)
  })
  it('uses a 60s default skew', () => {
    expect(isTokenExpired(100_000, 100_000 - 59_000)).toBe(true)
    expect(isTokenExpired(100_000, 100_000 - 61_000)).toBe(false)
  })
})

describe('postToken transport failure', () => {
  it('maps a token-endpoint transport failure to OAuthError (context: token-endpoint)', async () => {
    const throwing = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    const err = await Effect.runPromise(
      exchangeCode({
        cfg: GDRIVE_OAUTH,
        clientId: 'cid',
        code: 'c',
        codeVerifier: 'v',
        redirectUri: REDIRECT,
        now: 0,
      }).pipe(Effect.provide(makeFetchServiceLive(throwing)), Effect.flip),
    )
    expect(err).toBeInstanceOf(OAuthError)
    expect(err.context).toBe('token-endpoint')
  })
})
