import { useEffect, useState } from 'preact/hooks'
import { Option } from 'effect'
import { cn } from '@/lib/utils'
import { convexOriginPattern } from '@/core/sync/convex'
import type { SyncStatus } from '@/core/sync/status'
import { FETCHED_HOST_PATTERNS } from '@/core/download/fetched-strategy'
import type { CloudProviderId } from '@/core/cloud/types'
import { PROVIDERS } from '@/core/cloud/provider'
import { describeUploadSummary, type CloudUploadStatus } from '@/core/cloud/status'
import { Button } from '@/components/ui/button'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { PanelHeader, Section, type PanelProps } from '../ui'

const retryUploads = async (): Promise<void> => {
  await browser.runtime.sendMessage({ _tag: 'CloudRetryRequest' }).catch(() => {})
}

export function CloudPanel({ settings, update, reload }: PanelProps) {
  const [convexGranted, setConvexGranted] = useState<boolean | null>(null)
  const [testingSync, setTestingSync] = useState(false)
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null)
  const [cloudStatus, setCloudStatus] = useState<CloudUploadStatus | null>(null)
  const [connecting, setConnecting] = useState<CloudProviderId | null>(null)
  const [connectMsg, setConnectMsg] = useState('')

  const cloudOn = settings.cloudSyncEnabled
  const convexUrl = settings.convexUrl
  const convexSecret = settings.convexSyncSecret
  useEffect(() => {
    if (!cloudOn || convexUrl === '') return
    const pattern = convexOriginPattern(convexUrl)
    if (Option.isNone(pattern)) {
      setConvexGranted(null)
      return
    }
    void browser.permissions.contains({ origins: [pattern.value] }).then(setConvexGranted)
  }, [cloudOn, convexUrl])
  useEffect(() => {
    if (!cloudOn) {
      setSyncStatus(null)
      return
    }
    void browser.runtime
      .sendMessage({ _tag: 'SyncStatusRequest' })
      .then((s) => setSyncStatus((s as SyncStatus | null) ?? null))
      .catch(() => {})
  }, [cloudOn])
  useEffect(() => {
    setSyncStatus(null)
  }, [convexUrl, convexSecret])

  const uploadOn = settings.cloudUploadEnabled
  useEffect(() => {
    if (!uploadOn) {
      setCloudStatus(null)
      return
    }
    const poll = (): void => {
      void browser.runtime
        .sendMessage({ _tag: 'CloudStatusRequest' })
        .then((s) => setCloudStatus((s as CloudUploadStatus | null) ?? null))
        .catch(() => {})
    }
    poll()
    const handle = setInterval(poll, 2000)
    return () => clearInterval(handle)
  }, [uploadOn])

  const requestConvexAccess = async (): Promise<void> => {
    const pattern = convexOriginPattern(settings.convexUrl)
    if (Option.isNone(pattern)) return
    setConvexGranted(await browser.permissions.request({ origins: [pattern.value] }))
  }

  const testConvexConnection = async (): Promise<void> => {
    setTestingSync(true)
    try {
      const res = await browser.runtime.sendMessage({ _tag: 'SyncTestRequest' })
      setSyncStatus((res as SyncStatus | null) ?? null)
    } catch {
      setSyncStatus({ ok: false, detail: 'The extension background did not respond.', pending: 0 })
    } finally {
      setTestingSync(false)
    }
  }

  // Grant the provider API + twimg source origins from THIS click (user gesture),
  // then run the PKCE flow in the background SW (it survives this tab losing focus).
  const connectProvider = async (provider: CloudProviderId, clientId: string): Promise<void> => {
    setConnecting(provider)
    setConnectMsg('')
    try {
      const origins = [...PROVIDERS[provider].hostPatterns, ...FETCHED_HOST_PATTERNS]
      const granted = await browser.permissions.request({ origins }).catch(() => false)
      if (!granted) {
        setConnectMsg(
          'Access denied — the upload needs permission to reach the provider and X media.',
        )
        return
      }
      const res = (await browser.runtime
        .sendMessage({ _tag: 'CloudConnectRequest', provider, clientId })
        .catch(() => null)) as { ok?: boolean; detail?: string } | null
      await reload()
      setConnectMsg(res?.detail ?? 'The extension background did not respond.')
    } finally {
      setConnecting(null)
    }
  }

  const disconnectProvider = async (provider: CloudProviderId): Promise<void> => {
    await browser.runtime.sendMessage({ _tag: 'CloudDisconnectRequest', provider }).catch(() => {})
    await reload()
    setConnectMsg(`Disconnected ${PROVIDERS[provider].label}.`)
  }

  const backfillUploads = async (): Promise<void> => {
    setConnectMsg('Queuing past downloads…')
    const res = (await browser.runtime
      .sendMessage({ _tag: 'CloudBackfillRequest' })
      .catch(() => null)) as { detail?: string } | null
    setConnectMsg(res?.detail ?? 'The extension background did not respond.')
  }

  return (
    <>
      <PanelHeader
        title="Cloud"
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
            onCheckedChange={(checked: boolean) =>
              void update({
                cloudSyncEnabled: checked,
                ...(checked && settings.cloudDeviceId === ''
                  ? { cloudDeviceId: crypto.randomUUID() }
                  : {}),
              })
            }
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
                  'text-sm leading-snug',
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
            <FieldDescription>
              Uploads run automatically as you download — there's no separate step. Use “Back up
              past downloads” to sync media you saved earlier.
            </FieldDescription>
            <CloudProviderRow
              provider="gdrive"
              clientId={settings.gdriveClientId}
              connected={settings.gdriveRefreshToken !== ''}
              account={settings.gdriveAccount}
              connecting={connecting === 'gdrive'}
              onConnect={(clientId) => void connectProvider('gdrive', clientId)}
              onDisconnect={() => void disconnectProvider('gdrive')}
            />
            <CloudProviderRow
              provider="dropbox"
              clientId={settings.dropboxClientId}
              connected={settings.dropboxRefreshToken !== ''}
              account={settings.dropboxAccount}
              connecting={connecting === 'dropbox'}
              onConnect={(clientId) => void connectProvider('dropbox', clientId)}
              onDisconnect={() => void disconnectProvider('dropbox')}
            />
            {(settings.gdriveRefreshToken !== '' || settings.dropboxRefreshToken !== '') && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() => void backfillUploads()}
              >
                Back up past downloads
              </Button>
            )}
            {connectMsg && (
              <p className="text-sm leading-snug text-muted-foreground">{connectMsg}</p>
            )}
            {cloudStatus && (
              <div className="flex items-center justify-between gap-2">
                <p
                  className={cn(
                    'text-sm leading-snug',
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
  connecting,
  onConnect,
  onDisconnect,
}: {
  provider: CloudProviderId
  clientId: string
  connected: boolean
  account: string
  connecting: boolean
  onConnect: (clientId: string) => void
  onDisconnect: () => void
}) {
  const label = PROVIDERS[provider].label
  const idLabel = provider === 'gdrive' ? 'OAuth client ID' : 'App key'
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
          disabled={connecting || draft === ''}
          onClick={() => onConnect(draft)}
        >
          {connecting ? 'Connecting…' : connected ? 'Reconnect' : 'Connect'}
        </Button>
        {connected && (
          <Button type="button" variant="outline" size="sm" onClick={onDisconnect}>
            Disconnect
          </Button>
        )}
      </div>
    </div>
  )
}
