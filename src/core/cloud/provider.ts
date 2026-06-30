import { bindFetch } from '../fetch'
import type { Settings } from '../schema'
import { authHeader } from './http'
import {
  DROPBOX_HOST_PATTERNS,
  DROPBOX_OAUTH,
  GDRIVE_HOST_PATTERNS,
  GDRIVE_OAUTH,
  type CloudProviderId,
  type OAuthConfig,
} from './types'

/**
 * The **Cloud Provider** record (CONTEXT.md): one cloud byte-upload destination
 * (ADR-0013). The single place provider identity is encoded — every dispatch site
 * reads a record from {@link PROVIDERS} instead of forking on `'gdrive' vs
 * 'dropbox'`. The byte adapters themselves are the `DriveUploader`/`DropboxUploader`
 * services (ADR-0017); the orchestrator runs them on the shared cloud runtime.
 */

/** The per-provider flat-`Settings` field layout — every token read/write,
 *  connect, and disconnect reads off this instead of repeating the field names.
 *  `folderId` is gdrive-only; its absence on Dropbox preserves the asymmetric
 *  disconnect wipe (Dropbox must NOT clear a folder field it has no concept of). */
export interface ProviderFields {
  readonly clientId: keyof Settings
  readonly accessToken: keyof Settings
  readonly refreshToken: keyof Settings
  readonly expiry: keyof Settings
  readonly account: keyof Settings
  readonly folderId?: keyof Settings
}

/** How a provider revokes its grant on disconnect, as data (ADR-0013 §4). Google
 *  revokes the refresh token via a form `token=` body; Dropbox revokes via the
 *  access token in an `Authorization` header. */
export interface RevokeRecipe {
  readonly endpoint: string
  readonly credential: 'refreshToken' | 'accessToken'
  readonly via: 'formToken' | 'authHeader'
}

/** One cloud byte-upload destination — its identity only. The byte sink is the
 *  provider's uploader service (`DriveUploader`/`DropboxUploader`), dispatched by
 *  the orchestrator on the shared cloud runtime (ADR-0017). */
export interface CloudProvider {
  readonly id: CloudProviderId
  readonly label: string
  readonly oauth: OAuthConfig
  readonly hostPatterns: ReadonlyArray<string>
  readonly fields: ProviderFields
  readonly revoke: RevokeRecipe
}

const GDRIVE_PROVIDER: CloudProvider = {
  id: 'gdrive',
  label: 'Google Drive',
  oauth: GDRIVE_OAUTH,
  hostPatterns: GDRIVE_HOST_PATTERNS,
  fields: {
    clientId: 'gdriveClientId',
    accessToken: 'gdriveAccessToken',
    refreshToken: 'gdriveRefreshToken',
    expiry: 'gdriveTokenExpiry',
    account: 'gdriveAccount',
    folderId: 'gdriveFolderId',
  },
  revoke: {
    endpoint: 'https://oauth2.googleapis.com/revoke',
    credential: 'refreshToken',
    via: 'formToken',
  },
}

const DROPBOX_PROVIDER: CloudProvider = {
  id: 'dropbox',
  label: 'Dropbox',
  oauth: DROPBOX_OAUTH,
  hostPatterns: DROPBOX_HOST_PATTERNS,
  fields: {
    clientId: 'dropboxClientId',
    accessToken: 'dropboxAccessToken',
    refreshToken: 'dropboxRefreshToken',
    expiry: 'dropboxTokenExpiry',
    account: 'dropboxAccount',
  },
  revoke: {
    endpoint: 'https://api.dropboxapi.com/2/auth/token/revoke',
    credential: 'accessToken',
    via: 'authHeader',
  },
}

/** The provider registry — the single source of provider identity, keyed by id. */
export const PROVIDERS: Record<CloudProviderId, CloudProvider> = {
  gdrive: GDRIVE_PROVIDER,
  dropbox: DROPBOX_PROVIDER,
}

/** Best-effort revocation per a provider's {@link RevokeRecipe}. Never throws —
 *  the caller clears local tokens regardless; skips an empty credential. */
export async function revokeViaRecipe(
  recipe: RevokeRecipe,
  tokens: { readonly accessToken: string; readonly refreshToken: string },
  fetchImpl: typeof fetch,
): Promise<void> {
  const credential = recipe.credential === 'refreshToken' ? tokens.refreshToken : tokens.accessToken
  if (credential === '') return
  const doFetch = bindFetch(fetchImpl)
  try {
    if (recipe.via === 'formToken') {
      await doFetch(recipe.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: credential }).toString(),
      })
    } else {
      await doFetch(recipe.endpoint, { method: 'POST', headers: authHeader(credential) })
    }
  } catch {
    /* best-effort; local clear proceeds regardless */
  }
}
