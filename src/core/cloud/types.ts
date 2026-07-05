/**
 * Shared contract for the client-side cloud byte path (ADR-0013). Bytes go
 * extension → provider directly; nothing here touches Convex or buffers a whole
 * video. Provider adapters (`drive.ts`, `dropbox.ts`) implement `upload`; the
 * background SW orchestrates token refresh, SSRF-guarded source fetch, and the
 * UploadJob ledger (`upload-job.ts`).
 */

import { CLOUD_PROVIDERS } from '../schema'

export type CloudProviderId = (typeof CLOUD_PROVIDERS)[number]

/** OAuth 2.0 + PKCE endpoints/params for one provider. No client secret — an
 *  extension bundle cannot keep one (PKCE replaces it). */
export interface OAuthConfig {
  readonly authEndpoint: string
  readonly tokenEndpoint: string
  /** Space-delimited scope string. */
  readonly scope: string
  /** Provider-specific auth-URL params required for a refresh token
   *  (Google: access_type=offline+prompt=consent; Dropbox: token_access_type=offline). */
  readonly extraAuthParams: Readonly<Record<string, string>>
}

export interface OAuthTokens {
  readonly accessToken: string
  readonly refreshToken: string
  /** Epoch ms when the access token expires (now + expires_in·1000). */
  readonly expiresAt: number
  /** Best-effort account label (Dropbox account_id, Google email) for display. */
  readonly account?: string
}

/** Where one media item lands in the provider, derived from the local plan. */
export interface UploadTarget {
  /** Relative dest path, e.g. `twitter/tweetId_0.jpg` (mirrors the local filename). */
  readonly path: string
  /** Destination folder — the directory of the rendered local path, e.g. `twitter`
   *  (a subfolder at the Drive root / a Dropbox path segment). Empty when the
   *  filename template produced no directory, meaning "upload to the root". */
  readonly folder: string
  /** Basename, e.g. `tweetId_0.jpg`. */
  readonly filename: string
  /** Best-effort MIME hint; the source response's content-type overrides it. */
  readonly contentType: string
}

export interface UploadInput {
  /** twimg source URL — fetched only via the SSRF guard. */
  readonly url: string
  readonly target: UploadTarget
}

/** Honest, three-way outcome of one upload attempt. `sourceGone` (twimg 403/410,
 *  link-rot) is distinct from a real `failure` — it is never retried as a fault. */
export type UploadOutcome =
  | {
      readonly kind: 'success'
      readonly bytes: number
      readonly remotePath: string
      readonly remoteId?: string
    }
  | { readonly kind: 'sourceGone'; readonly reason: string }
  | {
      readonly kind: 'failure'
      readonly reason: string
      /** Provider HTTP status when the failure was a `CloudHttpError` — lets the
       *  popup classifier dispatch structurally instead of regexing `reason`. */
      readonly status?: number
    }

/** A provider-agnostic byte sink. The Drive/Dropbox adapters each satisfy this
 *  via a factory that captures provider deps (token, fetch, folder cache) in a
 *  closure, so the upload call site never forks on the provider. */
export interface CloudDestination {
  readonly upload: (input: UploadInput) => Promise<UploadOutcome>
}

/** Bytes ≤ this are buffered and sent in one request; larger media is streamed.
 *  The streaming path is entered when `size === null || size > SIMPLE_MAX_BYTES`,
 *  independent of each provider's chunk size (RESUMABLE_CHUNK / SESSION_CHUNK) —
 *  those equal this value only by coincidence. */
export const SIMPLE_MAX_BYTES = 8 * 1024 * 1024

export const GDRIVE_OAUTH: OAuthConfig = {
  authEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  // Full Drive (ADR-0013, product decision 2026-06-19). One-line downgrade to
  // the non-sensitive 'https://www.googleapis.com/auth/drive.file' later.
  // `openid email` yields an id_token so we can show the account email.
  scope: 'openid email https://www.googleapis.com/auth/drive',
  extraAuthParams: { access_type: 'offline', prompt: 'consent' },
}

export const DROPBOX_OAUTH: OAuthConfig = {
  authEndpoint: 'https://www.dropbox.com/oauth2/authorize',
  tokenEndpoint: 'https://api.dropboxapi.com/oauth2/token',
  // Least privilege (ADR-0013 §5). The account label comes from the token
  // response's account_id, which Dropbox returns without account_info.read.
  scope: 'files.content.write',
  extraAuthParams: { token_access_type: 'offline' },
}

/** Optional host permissions requested at connect time (ADR-0013 §6). */
export const GDRIVE_HOST_PATTERNS = [
  'https://www.googleapis.com/*',
  'https://oauth2.googleapis.com/*',
] as const

export const DROPBOX_HOST_PATTERNS = [
  'https://api.dropboxapi.com/*',
  'https://content.dropboxapi.com/*',
  'https://www.dropbox.com/*',
] as const

/** Best-effort MIME from a file extension — a hint only; the source response's
 *  content-type takes precedence in the adapters. */
export function guessMime(ext: string): string {
  const e = ext.toLowerCase().replace(/^\./, '')
  if (e === 'jpg' || e === 'jpeg') return 'image/jpeg'
  if (e === 'png') return 'image/png'
  if (e === 'webp') return 'image/webp'
  if (e === 'gif') return 'image/gif'
  if (e === 'mp4') return 'video/mp4'
  if (e === 'mov') return 'video/quicktime'
  return 'application/octet-stream'
}
