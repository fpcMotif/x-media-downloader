import { useEffect, useRef, useState } from 'preact/hooks'
import { Option } from 'effect'
import { cn } from '@/lib/utils'
import { convexOriginPattern } from '@/core/sync/convex'
import { FETCHED_HOST_PATTERNS } from '@/core/download/fetched-strategy'
import type { CloudProviderId } from '@/core/cloud/types'
import { PROVIDERS } from '@/core/cloud/provider'
import { requestCloudBackfill, requestCloudConnect, requestCloudStatus } from '@/core/cloud/client'
import { requestSyncStatus, requestSyncTest } from '@/core/sync/client'
import { describeUploadSummary, type CloudUploadStatus } from '@/core/cloud/status'
import type { SyncStatus } from '@/core/sync/status'
import { expectReply, safeSend } from '@/core/messaging'
import { Button } from '@/components/ui/button'
import { useAsyncAuthority } from '@/components/use-async-authority'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { PanelHeader, Section, type PanelProps } from '../ui'

const CLOUD_STATUS_POLL_MS = 2_000

const retryUploads = async (): Promise<void> => {
  await safeSend(() => browser.runtime.sendMessage({ _tag: 'CloudRetryRequest' }))
}

type ProviderIntent = 'connecting' | 'disconnecting'

const isExactDisconnectSuccess = (reply: unknown): reply is { readonly ok: true } => {
  if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) return false
  const keys = Reflect.ownKeys(reply)
  return keys.length === 1 && keys[0] === 'ok' && (reply as { readonly ok?: unknown }).ok === true
}

export function SyncPanel({ settings, update, reload }: PanelProps) {
  const [convexGranted, setConvexGranted] = useState<boolean | null>(null)
  const [testingSync, setTestingSync] = useState(false)
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null)
  const [cloudStatus, setCloudStatus] = useState<CloudUploadStatus | null>(null)
  const [providerIntents, setProviderIntents] = useState<
    Partial<Record<CloudProviderId, ProviderIntent>>
  >({})
  const pendingProviderIntents = useRef(new Set<CloudProviderId>())
  const [connectMsg, setConnectMsg] = useState('')
  const lifetime = useAsyncAuthority()
  const permissionAuthority = useAsyncAuthority()
  const testAuthority = useAsyncAuthority()
  const noticeAuthority = useAsyncAuthority()

  const beginProviderIntent = (provider: CloudProviderId, intent: ProviderIntent): boolean => {
    if (pendingProviderIntents.current.has(provider)) return false
    pendingProviderIntents.current.add(provider)
    if (lifetime.isMounted()) setProviderIntents((current) => ({ ...current, [provider]: intent }))
    return true
  }

  const endProviderIntent = (provider: CloudProviderId): void => {
    pendingProviderIntents.current.delete(provider)
    if (lifetime.isMounted()) setProviderIntents(({ [provider]: _intent, ...current }) => current)
  }

  const cloudOn = settings.cloudSyncEnabled
  const convexUrl = settings.convexUrl
  const convexSecret = settings.convexSyncSecret
  const syncConfig = useRef({ convexUrl, convexSecret })
  useEffect(() => {
    const epoch = permissionAuthority.begin()
    setConvexGranted(null)
    if (!cloudOn || convexUrl === '') return
    const pattern = convexOriginPattern(convexUrl)
    if (Option.isNone(pattern)) {
      setConvexGranted(null)
      return
    }
    void (async () => {
      const granted = await browser.permissions
        .contains({ origins: [pattern.value] })
        .catch(() => false)
      if (permissionAuthority.isCurrent(epoch)) setConvexGranted(granted)
    })()
  }, [cloudOn, convexUrl, permissionAuthority])
  useEffect(() => {
    testAuthority.invalidate()
    setTestingSync(false)
  }, [cloudOn, convexUrl, convexSecret, testAuthority])
  useEffect(() => {
    let cancelled = false
    const changedConfig =
      syncConfig.current.convexUrl !== convexUrl || syncConfig.current.convexSecret !== convexSecret
    syncConfig.current = { convexUrl, convexSecret }
    const setCurrentSyncStatus = (status: SyncStatus | null): void => {
      if (!cancelled) setSyncStatus(status)
    }
    if (!cloudOn || changedConfig) {
      setCurrentSyncStatus(null)
      return () => {
        cancelled = true
      }
    }
    void requestSyncStatus((request) => browser.runtime.sendMessage(request))
      .then((s) => setCurrentSyncStatus(s))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [cloudOn, convexUrl, convexSecret])

  const uploadOn = settings.cloudUploadEnabled
  useEffect(() => {
    let cancelled = false
    let nextPoll: ReturnType<typeof setTimeout> | undefined
    if (!uploadOn) {
      setCloudStatus(null)
      return () => {
        cancelled = true
      }
    }
    const poll = async (): Promise<void> => {
      try {
        const status = await requestCloudStatus((request) => browser.runtime.sendMessage(request))
        if (!cancelled) setCloudStatus(status)
      } catch {
        // A missing worker is transient. The next completion-scheduled poll retries.
      } finally {
        if (!cancelled) nextPoll = setTimeout(() => void poll(), CLOUD_STATUS_POLL_MS)
      }
    }
    void poll()
    return () => {
      cancelled = true
      if (nextPoll !== undefined) clearTimeout(nextPoll)
    }
  }, [uploadOn])

  const requestConvexAccess = async (): Promise<void> => {
    const epoch = permissionAuthority.begin()
    const pattern = convexOriginPattern(settings.convexUrl)
    if (Option.isNone(pattern)) return
    const granted = await browser.permissions
      .request({ origins: [pattern.value] })
      .catch(() => false)
    if (permissionAuthority.isCurrent(epoch)) setConvexGranted(granted)
  }

  const testConvexConnection = async (): Promise<void> => {
    const epoch = testAuthority.begin()
    setTestingSync(true)
    try {
      const status = await requestSyncTest((request) => browser.runtime.sendMessage(request))
      if (!testAuthority.isCurrent(epoch)) return
      setSyncStatus(
        status ?? { ok: false, detail: 'The extension background did not respond.', pending: 0 },
      )
    } catch {
      if (!testAuthority.isCurrent(epoch)) return
      setSyncStatus({ ok: false, detail: 'The extension background did not respond.', pending: 0 })
    } finally {
      if (testAuthority.isCurrent(epoch)) setTestingSync(false)
    }
  }

  // Grant the provider API + twimg source origins from THIS click (user gesture),
  // then run the PKCE flow in the background SW (it survives this tab losing focus).
  const connectProvider = async (provider: CloudProviderId, clientId: string): Promise<void> => {
    if (!beginProviderIntent(provider, 'connecting')) return
    const noticeEpoch = noticeAuthority.begin()
    if (noticeAuthority.isCurrent(noticeEpoch)) setConnectMsg('')
    try {
      const origins = [...PROVIDERS[provider].hostPatterns, ...FETCHED_HOST_PATTERNS]
      const granted = await browser.permissions.request({ origins }).catch(() => false)
      if (!granted) {
        if (noticeAuthority.isCurrent(noticeEpoch))
          setConnectMsg(
            'Access denied — the upload needs permission to reach the provider and X media.',
          )
        return
      }
      const res = await requestCloudConnect(
        { _tag: 'CloudConnectRequest', provider, clientId },
        (request) => browser.runtime.sendMessage(request),
      )
      await reload()
      if (noticeAuthority.isCurrent(noticeEpoch))
        setConnectMsg(res?.detail ?? 'The extension background did not respond.')
    } finally {
      endProviderIntent(provider)
    }
  }

  const disconnectProvider = async (provider: CloudProviderId): Promise<void> => {
    if (!beginProviderIntent(provider, 'disconnecting')) return
    const noticeEpoch = noticeAuthority.begin()
    if (noticeAuthority.isCurrent(noticeEpoch)) setConnectMsg('')
    try {
      const reply = expectReply(
        await safeSend(() =>
          browser.runtime.sendMessage({ _tag: 'CloudDisconnectRequest', provider }),
        ),
      )
      const disconnected = reply.status === 'ok' && isExactDisconnectSuccess(reply.reply)
      try {
        await reload()
      } catch {
        // The message outcome remains the user-visible truth; the next panel open retries reload.
      }
      if (noticeAuthority.isCurrent(noticeEpoch))
        setConnectMsg(
          disconnected
            ? `Disconnected ${PROVIDERS[provider].label}.`
            : `Could not disconnect ${PROVIDERS[provider].label}. Try again.`,
        )
    } finally {
      endProviderIntent(provider)
    }
  }

  const backfillUploads = async (): Promise<void> => {
    const noticeEpoch = noticeAuthority.begin()
    if (noticeAuthority.isCurrent(noticeEpoch)) setConnectMsg('Queuing past downloads…')
    const res = await requestCloudBackfill((request) => browser.runtime.sendMessage(request))
    if (noticeAuthority.isCurrent(noticeEpoch))
      setConnectMsg(res?.detail ?? 'The extension background did not respond.')
  }

  return (
    <>
      <PanelHeader
        title="Sync"
        description="Back up to your own cloud — opt-in, and you hold the keys."
      />

      <Section
        title="Cloud sync to Convex"
        description="Mirrors download metadata only — never file bytes. You run the deployment (ADR-0009)."
      >
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="cloudSyncEnabled">Cloud sync</FieldLabel>
            <FieldDescription>Metadata-only mirror to your Convex deployment</FieldDescription>
          </FieldContent>
          <Switch
            id="cloudSyncEnabled"
            aria-label="Cloud sync"
            checked={settings.cloudSyncEnabled}
            onCheckedChange={(checked: boolean) => void update({ cloudSyncEnabled: checked })}
          />
        </Field>

        {settings.cloudSyncEnabled && (
          <>
            <Field>
              <FieldLabel htmlFor="convexUrl">Convex deployment URL</FieldLabel>
              <Input
                id="convexUrl"
                aria-label="Convex deployment URL"
                placeholder="https://<deployment>.convex.cloud"
                value={settings.convexUrl}
                onChange={(e: Event) =>
                  void update({ convexUrl: (e.target as HTMLInputElement).value })
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="convexSyncSecret">Sync secret (required)</FieldLabel>
              <Input
                id="convexSyncSecret"
                type="password"
                aria-label="Convex sync secret"
                placeholder="must match the deployment's SYNC_SHARED_SECRET"
                value={settings.convexSyncSecret}
                onChange={(e: Event) =>
                  void update({ convexSyncSecret: (e.target as HTMLInputElement).value })
                }
              />
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-10"
                disabled={
                  testingSync || settings.convexUrl === '' || settings.convexSyncSecret === ''
                }
                onClick={() => void testConvexConnection()}
              >
                {testingSync ? 'Testing…' : 'Test connection'}
              </Button>
              {convexGranted === false && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="min-h-10"
                  onClick={() => void requestConvexAccess()}
                >
                  Grant access
                </Button>
              )}
              {convexGranted === true && (
                <span className="text-[13px] font-medium text-success">access granted</span>
              )}
            </div>
            {syncStatus && (
              <p
                className={cn(
                  'text-sm leading-snug text-pretty',
                  syncStatus.ok ? 'text-success' : 'text-destructive',
                )}
              >
                {syncStatus.detail}
              </p>
            )}
          </>
        )}
      </Section>

      <Section
        title="Cloud upload — Drive & Dropbox"
        description="Uploads the real media bytes to your own cloud. Bytes go provider-direct, never through our servers (ADR-0013)."
      >
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="cloudUploadEnabled">Upload media to cloud</FieldLabel>
            <FieldDescription>Photos + video bytes to Google Drive / Dropbox</FieldDescription>
          </FieldContent>
          <Switch
            id="cloudUploadEnabled"
            aria-label="Cloud upload"
            checked={settings.cloudUploadEnabled}
            onCheckedChange={(checked: boolean) => void update({ cloudUploadEnabled: checked })}
          />
        </Field>

        {settings.cloudUploadEnabled && (
          <>
            <FieldDescription className="text-pretty">
              Uploads run automatically as you download — there's no separate step. Use “Back up
              past downloads” to sync media you saved earlier.
            </FieldDescription>
            <CloudProviderRow
              provider="gdrive"
              clientId={settings.gdriveClientId}
              connected={settings.gdriveRefreshToken !== ''}
              account={settings.gdriveAccount}
              intent={providerIntents.gdrive}
              onConnect={(clientId) => void connectProvider('gdrive', clientId)}
              onDisconnect={() => void disconnectProvider('gdrive')}
            />
            <CloudProviderRow
              provider="dropbox"
              clientId={settings.dropboxClientId}
              connected={settings.dropboxRefreshToken !== ''}
              account={settings.dropboxAccount}
              intent={providerIntents.dropbox}
              onConnect={(clientId) => void connectProvider('dropbox', clientId)}
              onDisconnect={() => void disconnectProvider('dropbox')}
            />
            {(settings.gdriveRefreshToken !== '' || settings.dropboxRefreshToken !== '') && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-10 self-start"
                onClick={() => void backfillUploads()}
              >
                Back up past downloads
              </Button>
            )}
            {connectMsg && (
              <p className="text-sm leading-snug text-pretty text-muted-foreground">{connectMsg}</p>
            )}
            {cloudStatus && (
              <div className="flex items-center justify-between gap-2">
                <p
                  className={cn(
                    'text-sm leading-snug text-pretty',
                    cloudStatus.lastError ? 'text-destructive' : 'text-muted-foreground',
                  )}
                >
                  {cloudStatus.lastError ?? describeUploadSummary(cloudStatus.summary)}
                </p>
                {(cloudStatus.summary.dead > 0 || cloudStatus.summary.failed > 0) && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="min-h-10"
                    onClick={() => void retryUploads()}
                  >
                    Retry failed
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </Section>
    </>
  )
}

function CloudProviderRow({
  provider,
  clientId,
  connected,
  account,
  intent,
  onConnect,
  onDisconnect,
}: {
  provider: CloudProviderId
  clientId: string
  connected: boolean
  account: string
  intent: ProviderIntent | undefined
  onConnect: (clientId: string) => void
  onDisconnect: () => void
}) {
  const label = PROVIDERS[provider].label
  const idLabel = provider === 'gdrive' ? 'OAuth client ID' : 'App key'
  const pending = intent !== undefined
  // Client id lives in local draft state and rides with Connect — the panel never
  // writes it to the settings blob (single-writer, ADR-0005). Seed from the
  // persisted value and resync when it changes (e.g. after a successful connect).
  const [draft, setDraft] = useState(clientId)
  useEffect(() => {
    setDraft(clientId)
  }, [clientId])
  return (
    <div className="grid gap-3 border-l border-border pl-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold">{label}</span>
        {connected ? (
          <span className="shrink-0 text-[13px] text-success">
            {account !== '' ? account : 'connected'}
          </span>
        ) : (
          <span className="shrink-0 text-[13px] text-muted-foreground">Not connected</span>
        )}
      </div>
      <Field>
        <FieldLabel htmlFor={`${provider}ClientId`}>{idLabel}</FieldLabel>
        <Input
          id={`${provider}ClientId`}
          aria-label={`${label} ${idLabel}`}
          placeholder={provider === 'gdrive' ? 'xxxx.apps.googleusercontent.com' : 'your app key'}
          value={draft}
          disabled={pending}
          onChange={(e: Event) => setDraft((e.target as HTMLInputElement).value)}
        />
        <FieldDescription>
          <a
            href={
              provider === 'gdrive'
                ? 'https://console.cloud.google.com/apis/credentials'
                : 'https://www.dropbox.com/developers/apps'
            }
            target="_blank"
            rel="noreferrer"
            className="rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Where do I get this? →
          </a>
        </FieldDescription>
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant={connected ? 'outline' : 'default'}
          size="sm"
          className="min-h-10"
          disabled={pending || draft === ''}
          onClick={() => onConnect(draft)}
        >
          {intent === 'connecting' ? 'Connecting…' : connected ? 'Reconnect' : 'Connect'}
        </Button>
        {connected && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-10"
            disabled={pending}
            onClick={onDisconnect}
          >
            {intent === 'disconnecting' ? 'Disconnecting…' : 'Disconnect'}
          </Button>
        )}
      </div>
    </div>
  )
}
