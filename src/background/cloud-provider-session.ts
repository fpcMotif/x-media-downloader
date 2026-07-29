import {
  buildAuthUrl,
  computeCodeChallenge,
  generateCodeVerifier,
  isTokenExpired,
  parseAuthRedirect,
  randomState,
} from '../core/cloud/oauth'
import { PROVIDERS, revokeViaRecipe } from '../core/cloud/provider'
import type {
  BlobAttemptAdvance,
  CloudProviderId,
  OAuthConfig,
  OAuthTokens,
  RemoteAttempt,
  UploadInput,
} from '../core/cloud/types'
import type { UploadJob } from '../core/cloud/upload-job'
import { boundedDiagnosticText } from '../core/diagnostic-text'
import { CLOUD_PROVIDERS, type Settings } from '../core/schema'
import type { SettingsWriter } from './settings-writer'

export interface ProviderRuntime {
  prepareBlobAttempt(input: {
    readonly provider: CloudProviderId
    readonly jobId: string
    readonly ownerKey: string
    readonly accessToken: string
    readonly upload: UploadInput
  }): Promise<RemoteAttempt>
  advanceBlobAttempt(input: {
    readonly provider: CloudProviderId
    readonly accessToken: string
    readonly rootFolderId?: string
    readonly upload: UploadInput
    readonly attempt: RemoteAttempt
  }): Promise<BlobAttemptAdvance>
  resolveDriveRoot(accessToken: string): Promise<string>
  exchangeCode(input: {
    readonly cfg: OAuthConfig
    readonly clientId: string
    readonly code: string
    readonly codeVerifier: string
    readonly redirectUri: string
    readonly now: number
  }): Promise<OAuthTokens>
  refreshAccessToken(input: {
    readonly cfg: OAuthConfig
    readonly clientId: string
    readonly refreshToken: string
    readonly now: number
  }): Promise<{ readonly accessToken: string; readonly expiresAt: number }>
}

export interface AuthFlowPort {
  getRedirectUrl(): string
  launchFlow(url: string): Promise<string | undefined>
}

export interface ProviderOwner {
  readonly provider: CloudProviderId
  readonly generation: number
  readonly clientId: string
  readonly refreshToken: string
  readonly account: string
}

export interface ProviderCredentialSnapshot {
  readonly provider: CloudProviderId
  readonly clientId: string
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiry: number
  readonly account: string
  readonly folderId?: string
}

export interface ConnectOwnershipCommit {
  readonly kind: 'connect'
  readonly provider: CloudProviderId
  readonly generation: number
  readonly after: ProviderCredentialSnapshot
}

export interface DisconnectOwnershipCommit {
  readonly kind: 'disconnect'
  readonly provider: CloudProviderId
  readonly generation: number
  readonly revoke: (before: ProviderCredentialSnapshot) => Promise<void>
}

export interface CloudProviderSession {
  readonly beginIntent: (provider: CloudProviderId) => number
  readonly generation: (provider: CloudProviderId) => number
  readonly isPending: (provider: CloudProviderId) => boolean
  readonly isConnected: (settings: Settings, provider: CloudProviderId) => boolean
  readonly owners: (settings: Settings) => ReadonlyArray<ProviderOwner>
  readonly stillOwns: (settings: Settings, owner: ProviderOwner) => boolean
  /** A provider 401 invalidates a locally-future token before its next attempt. */
  readonly invalidateAccessToken: (owner: ProviderOwner) => Promise<void>
  readonly prepareAttempt: (job: UploadJob, owner: ProviderOwner) => Promise<RemoteAttempt>
  readonly advanceAttempt: (job: UploadJob, owner: ProviderOwner) => Promise<BlobAttemptAdvance>
  readonly connect: (
    provider: CloudProviderId,
    clientId: string,
    commit: (input: ConnectOwnershipCommit) => Promise<boolean>,
  ) => Promise<{ ok: boolean; detail: string; account?: string }>
  readonly disconnect: (
    provider: CloudProviderId,
    commit: (input: DisconnectOwnershipCommit) => Promise<boolean>,
  ) => Promise<{ ok: boolean }>
}

export const providerCredentialsFor = (
  settings: Readonly<Settings>,
  provider: CloudProviderId,
): ProviderCredentialSnapshot => {
  const fields = PROVIDERS[provider].fields
  return {
    provider,
    clientId: settings[fields.clientId],
    accessToken: settings[fields.accessToken],
    refreshToken: settings[fields.refreshToken],
    expiry: settings[fields.expiry],
    account: settings[fields.account],
    ...(fields.folderId === undefined ? {} : { folderId: settings[fields.folderId] }),
  }
}

const tokensFor = providerCredentialsFor

export const sameProviderCredentials = (
  left: ProviderCredentialSnapshot,
  right: ProviderCredentialSnapshot,
): boolean =>
  left.provider === right.provider &&
  left.clientId === right.clientId &&
  left.accessToken === right.accessToken &&
  left.refreshToken === right.refreshToken &&
  left.expiry === right.expiry &&
  left.account === right.account &&
  left.folderId === right.folderId

export const providerCredentialsPatch = (
  credentials: ProviderCredentialSnapshot,
): Readonly<Partial<Settings>> => {
  const fields = PROVIDERS[credentials.provider].fields
  return {
    [fields.clientId]: credentials.clientId,
    [fields.accessToken]: credentials.accessToken,
    [fields.refreshToken]: credentials.refreshToken,
    [fields.expiry]: credentials.expiry,
    [fields.account]: credentials.account,
    ...(fields.folderId === undefined ? {} : { [fields.folderId]: credentials.folderId ?? '' }),
  }
}

export const providerOwnerKey = async (
  credentials: Pick<
    ProviderCredentialSnapshot,
    'provider' | 'clientId' | 'refreshToken' | 'account'
  >,
): Promise<string | null> => {
  if (credentials.clientId === '' || credentials.refreshToken === '') return null
  const material = [
    credentials.provider,
    String(credentials.clientId.length),
    credentials.clientId,
    String(credentials.refreshToken.length),
    credentials.refreshToken,
    String(credentials.account.length),
    credentials.account,
  ].join('\u0000')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export const makeCloudProviderSession = (deps: {
  readonly getSettings: () => Promise<Settings>
  readonly settingsWriter: SettingsWriter
  readonly runtime: ProviderRuntime
  readonly authFlow: AuthFlowPort
  readonly fetchImpl: typeof fetch
  readonly now: () => number
}): CloudProviderSession => {
  const generations = new Map<CloudProviderId, number>(
    CLOUD_PROVIDERS.map((provider) => [provider, 0]),
  )
  const pendingIntents = new Map<CloudProviderId, number>()
  const lastTokenClock = new Map<CloudProviderId, number>()
  const beginIntent = (provider: CloudProviderId): number => {
    const generation = (generations.get(provider) ?? 0) + 1
    generations.set(provider, generation)
    pendingIntents.set(provider, generation)
    lastTokenClock.delete(provider)
    return generation
  }
  const settleIntent = (provider: CloudProviderId, generation: number): void => {
    if (pendingIntents.get(provider) === generation) pendingIntents.delete(provider)
  }
  const getGeneration = (provider: CloudProviderId): number => generations.get(provider) ?? 0
  const isPending = (provider: CloudProviderId): boolean => pendingIntents.has(provider)
  const isConnected = (settings: Settings, provider: CloudProviderId): boolean => {
    const tokens = tokensFor(settings, provider)
    return tokens.clientId !== '' && tokens.refreshToken !== ''
  }
  const owners = (settings: Settings): ReadonlyArray<ProviderOwner> =>
    CLOUD_PROVIDERS.filter(
      (provider) => !pendingIntents.has(provider) && isConnected(settings, provider),
    ).map((provider) => {
      const tokens = tokensFor(settings, provider)
      return {
        provider,
        generation: generations.get(provider) ?? 0,
        clientId: tokens.clientId,
        refreshToken: tokens.refreshToken,
        account: tokens.account,
      }
    })
  const stillOwns = (settings: Settings, owner: ProviderOwner): boolean => {
    const tokens = tokensFor(settings, owner.provider)
    return (
      settings.cloudUploadEnabled &&
      !pendingIntents.has(owner.provider) &&
      generations.get(owner.provider) === owner.generation &&
      tokens.clientId === owner.clientId &&
      tokens.refreshToken === owner.refreshToken &&
      tokens.account === owner.account
    )
  }

  const freshAccessToken = async (
    settings: Settings,
    owner: ProviderOwner,
    now: number,
  ): Promise<string> => {
    const provider = owner.provider
    const tokens = tokensFor(settings, provider)
    const previousNow = lastTokenClock.get(provider)
    const clockUntrusted = previousNow === undefined || now < previousNow
    if (tokens.accessToken !== '' && !clockUntrusted && !isTokenExpired(tokens.expiry, now)) {
      lastTokenClock.set(provider, now)
      return tokens.accessToken
    }
    const refreshed = await deps.runtime.refreshAccessToken({
      cfg: PROVIDERS[provider].oauth,
      clientId: tokens.clientId,
      refreshToken: tokens.refreshToken,
      now,
    })
    const fields = PROVIDERS[provider].fields
    const persisted = await deps.settingsWriter.updateWhen(
      (current) => {
        const currentTokens = tokensFor(current, provider)
        return (
          generations.get(provider) === owner.generation &&
          current.cloudUploadEnabled &&
          isConnected(current, provider) &&
          currentTokens.clientId === owner.clientId &&
          currentTokens.refreshToken === owner.refreshToken &&
          currentTokens.account === owner.account
        )
      },
      {
        [fields.accessToken]: refreshed.accessToken,
        [fields.expiry]: refreshed.expiresAt,
      },
    )
    if (!persisted.applied)
      throw new Error(
        `${PROVIDERS[provider].label} was disconnected while refreshing its access token.`,
      )
    lastTokenClock.set(provider, now)
    return refreshed.accessToken
  }

  const invalidateAccessToken = async (owner: ProviderOwner): Promise<void> => {
    lastTokenClock.delete(owner.provider)
    const fields = PROVIDERS[owner.provider].fields
    await deps.settingsWriter.updateWhen((current) => stillOwns(current, owner), {
      [fields.accessToken]: '',
      [fields.expiry]: 0,
    })
  }

  const driveRoot = async (
    accessToken: string,
    settings: Settings,
    owner: ProviderOwner,
  ): Promise<string | undefined> => {
    if (owner.provider !== 'gdrive') return undefined
    let rootId = settings.gdriveFolderId
    if (rootId === '') {
      rootId = await deps.runtime.resolveDriveRoot(accessToken)
      const persisted = await deps.settingsWriter.updateWhen(
        (current) =>
          stillOwns(current, owner) && tokensFor(current, 'gdrive').accessToken === accessToken,
        { gdriveFolderId: rootId },
      )
      if (!persisted.applied)
        throw new Error('Google Drive was disconnected while resolving its upload folder.')
    }
    return rootId
  }

  const withCurrentSession = async <T>(
    job: UploadJob,
    owner: ProviderOwner,
    run: (input: {
      readonly accessToken: string
      readonly ownerKey: string
      readonly settings: Settings
    }) => Promise<T>,
  ): Promise<T> => {
    if (job.provider !== owner.provider)
      throw new Error('Cloud provider owner does not match the upload job.')
    const settings = await deps.getSettings()
    if (!stillOwns(settings, owner))
      throw new Error(`${PROVIDERS[job.provider].label} connection changed before upload.`)
    const accessToken = await freshAccessToken(settings, owner, deps.now())
    const current = await deps.getSettings()
    const after = tokensFor(current, job.provider)
    if (!stillOwns(current, owner) || after.accessToken !== accessToken)
      throw new Error(`${PROVIDERS[job.provider].label} connection changed before upload.`)
    const ownerKey = await providerOwnerKey(owner)
    if (ownerKey === null)
      throw new Error(`${PROVIDERS[job.provider].label} connection identity is missing.`)
    if (job.remoteAttempt !== undefined && job.remoteAttempt.ownerKey !== ownerKey)
      throw new Error(`${PROVIDERS[job.provider].label} attempt belongs to another connection.`)
    const result = await run({ accessToken, ownerKey, settings: current })
    if (!stillOwns(await deps.getSettings(), owner))
      throw new Error(`${PROVIDERS[job.provider].label} connection changed during upload.`)
    return result
  }

  const prepareAttempt = (job: UploadJob, owner: ProviderOwner): Promise<RemoteAttempt> =>
    withCurrentSession(job, owner, async ({ accessToken, ownerKey }) => {
      const attempt = await deps.runtime.prepareBlobAttempt({
        provider: job.provider,
        jobId: job.jobId,
        ownerKey,
        accessToken,
        upload: { url: job.url, target: job.target },
      })
      if (attempt.kind !== job.provider || attempt.ownerKey !== ownerKey)
        throw new Error(`${PROVIDERS[job.provider].label} prepared invalid upload identity.`)
      return attempt
    })

  const advanceAttempt = (job: UploadJob, owner: ProviderOwner): Promise<BlobAttemptAdvance> =>
    withCurrentSession(job, owner, async ({ accessToken, settings }) => {
      if (job.remoteAttempt === undefined)
        throw new Error(`${PROVIDERS[job.provider].label} upload identity was not persisted.`)
      const rootFolderId = await driveRoot(accessToken, settings, owner)
      return await deps.runtime.advanceBlobAttempt({
        provider: job.provider,
        accessToken,
        ...(rootFolderId === undefined ? {} : { rootFolderId }),
        upload: { url: job.url, target: job.target },
        attempt: job.remoteAttempt,
      })
    })

  const connect = async (
    provider: CloudProviderId,
    clientId: string,
    commit: (input: ConnectOwnershipCommit) => Promise<boolean>,
  ): Promise<{ ok: boolean; detail: string; account?: string }> => {
    const generation = beginIntent(provider)
    try {
      const cfg = PROVIDERS[provider].oauth
      const redirectUri = deps.authFlow.getRedirectUrl()
      const verifier = generateCodeVerifier()
      const challenge = await computeCodeChallenge(verifier)
      const state = randomState()
      const authUrl = buildAuthUrl(cfg, {
        clientId,
        redirectUri,
        codeChallenge: challenge,
        state,
      })
      if (generations.get(provider) !== generation)
        return {
          ok: false,
          detail: `${PROVIDERS[provider].label} connection was superseded.`,
        }
      const redirect = await deps.authFlow.launchFlow(authUrl)
      if (redirect === undefined || redirect === '')
        return { ok: false, detail: 'Authorization was cancelled.' }
      const { code } = parseAuthRedirect(redirect, state)
      const issuedAt = deps.now()
      const tokens = await deps.runtime.exchangeCode({
        cfg,
        clientId,
        code,
        codeVerifier: verifier,
        redirectUri,
        now: issuedAt,
      })
      if (generations.get(provider) !== generation)
        return {
          ok: false,
          detail: `${PROVIDERS[provider].label} connection was superseded.`,
        }
      const committed = await commit({
        kind: 'connect',
        provider,
        generation,
        after: {
          provider,
          clientId,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiry: tokens.expiresAt,
          account: tokens.account ?? '',
          ...(PROVIDERS[provider].fields.folderId === undefined ? {} : { folderId: '' }),
        },
      })
      if (!committed)
        return {
          ok: false,
          detail: `${PROVIDERS[provider].label} connection was superseded.`,
        }
      lastTokenClock.set(provider, issuedAt)
      return {
        ok: true,
        detail: `Connected ${PROVIDERS[provider].label}.`,
        ...(tokens.account !== undefined ? { account: tokens.account } : {}),
      }
    } catch (error) {
      return {
        ok: false,
        detail: boundedDiagnosticText(error instanceof Error ? error.message : String(error)),
      }
    } finally {
      settleIntent(provider, generation)
    }
  }

  const disconnect = async (
    provider: CloudProviderId,
    commit: (input: DisconnectOwnershipCommit) => Promise<boolean>,
  ): Promise<{ ok: boolean }> => {
    const generation = beginIntent(provider)
    try {
      return {
        ok: await commit({
          kind: 'disconnect',
          provider,
          generation,
          revoke: async (before) =>
            await revokeViaRecipe(PROVIDERS[provider].revoke, before, deps.fetchImpl),
        }),
      }
    } finally {
      settleIntent(provider, generation)
    }
  }

  return {
    beginIntent,
    generation: getGeneration,
    isPending,
    isConnected,
    owners,
    stillOwns,
    invalidateAccessToken,
    prepareAttempt,
    advanceAttempt,
    connect,
    disconnect,
  }
}
