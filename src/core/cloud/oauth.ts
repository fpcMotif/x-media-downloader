import { Data, Effect } from 'effect'
import { FetchService } from '../fetch-service'
import { boundedDiagnosticText, MAX_DIAGNOSTIC_TEXT_LENGTH } from '../diagnostic-text'
import { MAX_CLOUD_ACCOUNT_LENGTH, MAX_OAUTH_TOKEN_LENGTH } from '../schema/settings'
import { controlRecord, controlSafeInteger, optionalControlString } from './control-json'
import { readControlJson } from './http'
import { cloudDeadline, cloudTime } from './time'
import type { OAuthConfig, OAuthTokens } from './types'

/**
 * OAuth 2.0 Authorization Code + PKCE for a Chrome MV3 extension (ADR-0013 §4).
 * Pure helpers (verifier/challenge/auth-URL/redirect-parse) are I/O-free and
 * unit-tested; `exchangeCode`/`refreshAccessToken` take an injected `fetch`
 * (the aria2/convex port convention) so they test without the network. No
 * client secret anywhere — PKCE replaces it; an extension bundle can't keep one.
 */
export class OAuthError extends Data.TaggedError('OAuthError')<{
  readonly message: string
  readonly context?:
    | 'malformed-url'
    | 'consent-failed'
    | 'state-mismatch'
    | 'no-code'
    | 'no-token'
    | 'non-json'
    | 'invalid-token-response'
    | 'token-endpoint'
    | 'no-offline-grant'
}> {}

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
    throw new OAuthError({ message: 'malformed redirect url', context: 'malformed-url' })
  }
  // Providers return params on the query string for the code flow.
  const p = u.searchParams
  const err = p.get('error')
  if (err !== null)
    throw new OAuthError({ message: `consent failed: ${err}`, context: 'consent-failed' })
  const state = p.get('state')
  if (state !== expectedState)
    throw new OAuthError({ message: 'state mismatch (possible CSRF)', context: 'state-mismatch' })
  const code = p.get('code')
  if (code === null || code === '')
    throw new OAuthError({ message: 'no authorization code in redirect', context: 'no-code' })
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

const decodeTokenResponse = (value: unknown): TokenResponse => {
  const record = controlRecord(value, 'token response')
  const accessToken = optionalControlString(
    record.access_token,
    'token response access_token',
    MAX_OAUTH_TOKEN_LENGTH,
  )
  const refreshToken = optionalControlString(
    record.refresh_token,
    'token response refresh_token',
    MAX_OAUTH_TOKEN_LENGTH,
  )
  const accountId = optionalControlString(
    record.account_id,
    'token response account_id',
    MAX_CLOUD_ACCOUNT_LENGTH,
  )
  const idToken = optionalControlString(
    record.id_token,
    'token response id_token',
    MAX_OAUTH_TOKEN_LENGTH,
  )
  const error = optionalControlString(
    record.error,
    'token response error',
    MAX_DIAGNOSTIC_TEXT_LENGTH,
  )
  const errorDescription = optionalControlString(
    record.error_description,
    'token response error_description',
    MAX_DIAGNOSTIC_TEXT_LENGTH,
  )
  return {
    ...(accessToken === undefined ? {} : { access_token: accessToken }),
    ...(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
    ...(record.expires_in === undefined
      ? {}
      : { expires_in: controlSafeInteger(record.expires_in, 'token response expires_in') }),
    ...(accountId === undefined ? {} : { account_id: accountId }),
    ...(idToken === undefined ? {} : { id_token: idToken }),
    ...(error === undefined ? {} : { error }),
    ...(errorDescription === undefined ? {} : { error_description: errorDescription }),
  }
}

/** Best-effort `email` claim from a Google id_token (JWT). Never throws. */
function emailFromIdToken(idToken: string | undefined): string | undefined {
  if (idToken === undefined) return undefined
  try {
    const payload = idToken.split('.')[1]
    if (payload === undefined) return undefined
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    const claims = controlRecord(JSON.parse(json), 'id_token claims')
    return optionalControlString(claims.email, 'id_token email', MAX_CLOUD_ACCOUNT_LENGTH)
  } catch {
    return undefined
  }
}

/** The non-empty `access_token` from a token response, or fail with `ctx`. */
const requireAccessToken = (json: TokenResponse, ctx: string): Effect.Effect<string, OAuthError> =>
  json.access_token === undefined || json.access_token === ''
    ? new OAuthError({ message: `${ctx} had no access_token`, context: 'no-token' })
    : Effect.succeed(json.access_token)

const tokenExpiry = (
  now: number,
  expiresIn: number | undefined,
): Effect.Effect<number, OAuthError> => {
  const seconds = expiresIn ?? 3600
  if (seconds > Math.floor(Number.MAX_SAFE_INTEGER / 1000))
    return new OAuthError({
      message: 'token response expires_in is out of range',
      context: 'invalid-token-response',
    })
  try {
    return Effect.succeed(cloudDeadline(cloudTime(now, 'token issue time'), seconds * 1000))
  } catch {
    return new OAuthError({
      message: 'token response expiry is invalid',
      context: 'invalid-token-response',
    })
  }
}

/** POST a token grant and validate the envelope (ADR-0017: reads `FetchService`). */
const postToken = (
  cfg: OAuthConfig,
  body: Record<string, string>,
): Effect.Effect<TokenResponse, OAuthError, FetchService> =>
  Effect.gen(function* () {
    const http = yield* FetchService
    const res = yield* http
      .fetch(cfg.tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString(),
      })
      .pipe(
        Effect.catchTag(
          'FetchError',
          (e) => new OAuthError({ message: e.message, context: 'token-endpoint' }),
        ),
      )
    const json = yield* Effect.tryPromise({
      try: async () => decodeTokenResponse(await readControlJson(res)),
      catch: (error) =>
        new OAuthError({
          message:
            error instanceof SyntaxError
              ? `token endpoint returned non-JSON (HTTP ${res.status})`
              : `token endpoint returned invalid JSON (HTTP ${res.status})`,
          context: error instanceof SyntaxError ? 'non-json' : 'invalid-token-response',
        }),
    })
    if (!res.ok || json.error !== undefined)
      return yield* new OAuthError({
        message: boundedDiagnosticText(
          json.error_description ?? json.error ?? `token endpoint HTTP ${res.status}`,
        ),
        context: 'token-endpoint',
      })
    return json
  })

/** Exchange an authorization code for tokens (PKCE: code_verifier, no secret). */
export function exchangeCode(input: {
  readonly cfg: OAuthConfig
  readonly clientId: string
  readonly code: string
  readonly codeVerifier: string
  readonly redirectUri: string
  readonly now: number
}): Effect.Effect<OAuthTokens, OAuthError, FetchService> {
  return Effect.gen(function* () {
    const json = yield* postToken(input.cfg, {
      client_id: input.clientId,
      code: input.code,
      code_verifier: input.codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: input.redirectUri,
    })
    const accessToken = yield* requireAccessToken(json, 'token response')
    if (json.refresh_token === undefined || json.refresh_token === '')
      // Without a refresh token the connection dies in ~1 hour; treat as a setup
      // error (Google: needs access_type=offline+prompt=consent; Dropbox: offline).
      return yield* new OAuthError({
        message: 'no refresh_token — reconnect and grant offline access',
        context: 'no-offline-grant',
      })
    const account = emailFromIdToken(json.id_token) ?? json.account_id
    const expiresAt = yield* tokenExpiry(input.now, json.expires_in)
    return {
      accessToken,
      refreshToken: json.refresh_token,
      expiresAt,
      ...(account !== undefined ? { account } : {}),
    }
  })
}

/** Refresh an access token from the stored refresh token (no new refresh token). */
export function refreshAccessToken(input: {
  readonly cfg: OAuthConfig
  readonly clientId: string
  readonly refreshToken: string
  readonly now: number
}): Effect.Effect<
  { readonly accessToken: string; readonly expiresAt: number },
  OAuthError,
  FetchService
> {
  return Effect.gen(function* () {
    const json = yield* postToken(input.cfg, {
      client_id: input.clientId,
      refresh_token: input.refreshToken,
      grant_type: 'refresh_token',
    })
    const accessToken = yield* requireAccessToken(json, 'refresh response')
    const expiresAt = yield* tokenExpiry(input.now, json.expires_in)
    return { accessToken, expiresAt }
  })
}

/** Whether a token expires within `skewMs` of `now` (refresh proactively). */
export const isTokenExpired = (expiresAt: number, now: number, skewMs = 60_000): boolean =>
  !Number.isSafeInteger(expiresAt) ||
  expiresAt < 0 ||
  !Number.isSafeInteger(now) ||
  now < 0 ||
  !Number.isSafeInteger(skewMs) ||
  skewMs < 0 ||
  now >= Math.max(0, expiresAt - skewMs)

// Provider grant revocation on disconnect moved to the Cloud Provider record as a
// data `RevokeRecipe` + `revokeViaRecipe` executor (core/cloud/provider.ts).
