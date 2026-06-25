import { bindFetch } from '../fetch'
import type { OAuthConfig, OAuthTokens } from './types'

/**
 * OAuth 2.0 Authorization Code + PKCE for a Chrome MV3 extension (ADR-0013 §4).
 * Pure helpers (verifier/challenge/auth-URL/redirect-parse) are I/O-free and
 * unit-tested; `exchangeCode`/`refreshAccessToken` take an injected `fetch`
 * (the aria2/convex port convention) so they test without the network. No
 * client secret anywhere — PKCE replaces it; an extension bundle can't keep one.
 */
export class OAuthError extends Error {
  readonly _tag = 'OAuthError'
  constructor(reason: string) {
    super(reason)
    this.name = 'OAuthError'
  }
}

/** base64url (no padding) of raw bytes. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** A high-entropy PKCE code_verifier (43–128 chars; 32 random bytes → 43 chars). */
export function generateCodeVerifier(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))
}

/** code_challenge = base64url(SHA-256(verifier)), method S256. */
export async function computeCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64UrlEncode(new Uint8Array(digest))
}

/** Random CSRF state. */
export function randomState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)))
}

/** Build the provider authorization URL for `launchWebAuthFlow`. */
export function buildAuthUrl(
  cfg: OAuthConfig,
  params: {
    readonly clientId: string
    readonly redirectUri: string
    readonly codeChallenge: string
    readonly state: string
  },
): string {
  const u = new URL(cfg.authEndpoint)
  const q = u.searchParams
  q.set('client_id', params.clientId)
  q.set('redirect_uri', params.redirectUri)
  q.set('response_type', 'code')
  q.set('scope', cfg.scope)
  q.set('code_challenge', params.codeChallenge)
  q.set('code_challenge_method', 'S256')
  q.set('state', params.state)
  for (const [k, v] of Object.entries(cfg.extraAuthParams)) q.set(k, v)
  return u.toString()
}

/** Extract the authorization `code` from the redirect URL, after verifying `state`.
 *  Throws {@link OAuthError} on a provider error, state mismatch, or missing code. */
export function parseAuthRedirect(redirectUrl: string, expectedState: string): { code: string } {
  let u: URL
  try {
    u = new URL(redirectUrl)
  } catch {
    throw new OAuthError('malformed redirect url')
  }
  // Providers return params on the query string for the code flow.
  const p = u.searchParams
  const err = p.get('error')
  if (err !== null) throw new OAuthError(`consent failed: ${err}`)
  const state = p.get('state')
  if (state !== expectedState) throw new OAuthError('state mismatch (possible CSRF)')
  const code = p.get('code')
  if (code === null || code === '') throw new OAuthError('no authorization code in redirect')
  return { code }
}

interface TokenResponse {
  readonly access_token?: string
  readonly refresh_token?: string
  readonly expires_in?: number
  /** Dropbox: the account id. */
  readonly account_id?: string
  /** Google (with `openid email` scope): a JWT whose `email` claim labels the account. */
  readonly id_token?: string
  readonly error?: string
  readonly error_description?: string
}

/** Best-effort `email` claim from a Google id_token (JWT). Never throws. */
function emailFromIdToken(idToken: string | undefined): string | undefined {
  if (idToken === undefined) return undefined
  try {
    const payload = idToken.split('.')[1]
    if (payload === undefined) return undefined
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    const claims = JSON.parse(json) as { email?: string }
    return typeof claims.email === 'string' ? claims.email : undefined
  } catch {
    return undefined
  }
}

/** Return the non-empty `access_token` from a token response, or throw with `ctx`. */
function requireAccessToken(json: TokenResponse, ctx: string): string {
  if (json.access_token === undefined || json.access_token === '') {
    throw new OAuthError(`${ctx} had no access_token`)
  }
  return json.access_token
}

async function postToken(
  cfg: OAuthConfig,
  fetchImpl: typeof fetch,
  body: Record<string, string>,
): Promise<TokenResponse> {
  const doFetch = bindFetch(fetchImpl)
  const res = await doFetch(cfg.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  })
  let json: TokenResponse
  try {
    json = (await res.json()) as TokenResponse
  } catch {
    throw new OAuthError(`token endpoint returned non-JSON (HTTP ${res.status})`)
  }
  if (!res.ok || json.error !== undefined) {
    throw new OAuthError(
      json.error_description ?? json.error ?? `token endpoint HTTP ${res.status}`,
    )
  }
  return json
}

/** Exchange an authorization code for tokens (PKCE: code_verifier, no secret). */
export async function exchangeCode(input: {
  readonly cfg: OAuthConfig
  readonly clientId: string
  readonly code: string
  readonly codeVerifier: string
  readonly redirectUri: string
  readonly fetchImpl: typeof fetch
  readonly now: number
}): Promise<OAuthTokens> {
  const json = await postToken(input.cfg, input.fetchImpl, {
    client_id: input.clientId,
    code: input.code,
    code_verifier: input.codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: input.redirectUri,
  })
  const accessToken = requireAccessToken(json, 'token response')
  if (json.refresh_token === undefined || json.refresh_token === '') {
    // Without a refresh token the connection dies in ~1 hour; treat as a setup
    // error (Google: needs access_type=offline+prompt=consent; Dropbox: offline).
    throw new OAuthError('no refresh_token — reconnect and grant offline access')
  }
  const account = emailFromIdToken(json.id_token) ?? json.account_id
  return {
    accessToken,
    refreshToken: json.refresh_token,
    expiresAt: input.now + (json.expires_in ?? 3600) * 1000,
    ...(account !== undefined ? { account } : {}),
  }
}

/** Refresh an access token from the stored refresh token (no new refresh token). */
export async function refreshAccessToken(input: {
  readonly cfg: OAuthConfig
  readonly clientId: string
  readonly refreshToken: string
  readonly fetchImpl: typeof fetch
  readonly now: number
}): Promise<{ readonly accessToken: string; readonly expiresAt: number }> {
  const json = await postToken(input.cfg, input.fetchImpl, {
    client_id: input.clientId,
    refresh_token: input.refreshToken,
    grant_type: 'refresh_token',
  })
  const accessToken = requireAccessToken(json, 'refresh response')
  return { accessToken, expiresAt: input.now + (json.expires_in ?? 3600) * 1000 }
}

/** Whether a token expires within `skewMs` of `now` (refresh proactively). */
export const isTokenExpired = (expiresAt: number, now: number, skewMs = 60_000): boolean =>
  now >= expiresAt - skewMs

// Provider grant revocation on disconnect moved to the Cloud Provider record as a
// data `RevokeRecipe` + `revokeViaRecipe` executor (core/cloud/provider.ts).
