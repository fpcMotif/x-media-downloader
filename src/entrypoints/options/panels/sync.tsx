import { useEffect, useState } from 'preact/hooks'
import { Option } from 'effect'
import { cn } from '@/lib/utils'
import { convexOriginPattern } from '@/packages/sync/convex'
import type { SyncStatus } from '@/packages/sync/status'
import { FETCHED_HOST_PATTERNS } from '@/packages/download/fetched-strategy'
import type { CloudProviderId } from '@/packages/cloud/types'
import { PROVIDERS } from '@/packages/cloud/provider'
import { describeUploadSummary, type CloudUploadStatus } from '@/packages/cloud/status'
import { Button } from '@/components/ui/button'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { PanelHeader, Section, type PanelProps } from '../ui'

const retryUploads = async (): Promise<void> => {
  await browser.runtime.sendMessage({ _tag: 'CloudRetryRequest' }).catch(() => {})
}

/** The live value of the `<input>` that fired `e` — narrows `EventTarget | null`
 *  instead of asserting it, since every caller below binds this to a real
 *  `HTMLInputElement`'s `onChange`. */
const inputValue = (e: Event): string =>
  e.target instanceof HTMLInputElement ? e.target.value : ''

function SyncDetailsSection({
  settings,
  update,
  convexGranted,
  syncStatus,
  testingSync,
  onTestConnection,
  onRequestAccess,
}: {
  settings: PanelProps['settings']
  update: PanelProps['update']
  convexGranted: boolean | null
  syncStatus: SyncStatus | null
  testingSync: boolean
  onTestConnection: () => Promise<void>
  onRequestAccess: () => Promise<void>
}) {
  return (
    <>
      <Field>
        <FieldLabel htmlFor="convexUrl">Convex deployment URL</FieldLabel>
        <Input
          id="convexUrl"
          placeholder="https://<deployment>.convex.cloud"
          value={settings.convexUrl}
          onChange={(e: Event) => void update({ convexUrl: inputValue(e) })}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="convexSyncSecret">Sync secret (required)</FieldLabel>
        <Input
          id="convexSyncSecret"
          type="password"
          placeholder="must match the deployment's SYNC_SHARED_SECRET"
          value={settings.convexSyncSecret}
          onChange={(e: Event) => void update({ convexSyncSecret: inputValue(e) })}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-10"
          disabled={testingSync || settings.convexUrl === '' || settings.convexSyncSecret === ''}
          onClick={() => void onTestConnection()}
        >
          {testingSync ? 'Testing…' : 'Test connection'}
        </Button>
        {convexGranted === false && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="min-h-10"
            onClick={() => void onRequestAccess()}
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
  )
}

function UploadDetailsSection({
  settings,
  connecting,
  connectMsg,
  cloudStatus,
  onConnect,
  onDisconnect,
  onBackfill,
  onRetry,
}: {
  settings: PanelProps['settings']
  connecting: CloudProviderId | null
  connectMsg: string
  cloudStatus: CloudUploadStatus | null
  onConnect: (provider: CloudProviderId, clientId: string) => Promise<void>
  onDisconnect: (provider: CloudProviderId) => Promise<void>
  onBackfill: () => Promise<void>
  onRetry: () => Promise<void>
}) {
  const hasConnectedProviders =
    settings.gdriveRefreshToken !== '' || settings.dropboxRefreshToken !== ''

  return (
    <>
      <FieldDescription className="text-pretty">
        Uploads run automatically as you download — there's no separate step. Use “Back up past
        downloads” to sync media you saved earlier.
      </FieldDescription>
      <CloudProviderRow
        provider="gdrive"
        clientId={settings.gdriveClientId}
        connected={settings.gdriveRefreshToken !== ''}
        account={settings.gdriveAccount}
        connecting={connecting === 'gdrive'}
        onConnect={(clientId) => void onConnect('gdrive', clientId)}
        onDisconnect={() => void onDisconnect('gdrive')}
      />
      <CloudProviderRow
        provider="dropbox"
        clientId={settings.dropboxClientId}
        connected={settings.dropboxRefreshToken !== ''}
        account={settings.dropboxAccount}
        connecting={connecting === 'dropbox'}
        onConnect={(clientId) => void onConnect('dropbox', clientId)}
        onDisconnect={() => void onDisconnect('dropbox')}
      />
      {hasConnectedProviders && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-10 self-start"
          onClick={() => void onBackfill()}
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
              onClick={() => void onRetry()}
            >
              Retry failed
            </Button>
          )}
        </div>
      )}
    </>
  )
}

export function SyncPanel({ settings, update, reload }: PanelProps) {
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
      .then((s: SyncStatus | null) => setSyncStatus(s ?? null))
      .catch(() => {})
  }, [cloudOn])
  useEffect(() => {
    setSyncStatus(null)
  }, [convexUrl, convexSecret])

  const uploadOn = settings.cloudUploadEnabled
  useEffect(() => {
    if (!uploadOn) {
      setCloudStatus(null)
      return undefined
    }
    const poll = (): void => {
      void browser.runtime
        .sendMessage({ _tag: 'CloudStatusRequest' })
        .then((s: CloudUploadStatus | null) => setCloudStatus(s ?? null))
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
      const res: SyncStatus | null = await browser.runtime.sendMessage({ _tag: 'SyncTestRequest' })
      setSyncStatus(res ?? null)
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
      const res: { ok?: boolean; detail?: string } | null = await browser.runtime
        .sendMessage({ _tag: 'CloudConnectRequest', provider, clientId })
        .catch(() => null)
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
    const res: { detail?: string } | null = await browser.runtime
      .sendMessage({ _tag: 'CloudBackfillRequest' })
      .catch(() => null)
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
          <SyncDetailsSection
            settings={settings}
            update={update}
            convexGranted={convexGranted}
            syncStatus={syncStatus}
            testingSync={testingSync}
            onTestConnection={testConvexConnection}
            onRequestAccess={requestConvexAccess}
          />
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
            checked={settings.cloudUploadEnabled}
            onCheckedChange={(checked: boolean) => void update({ cloudUploadEnabled: checked })}
          />
        </Field>

        {settings.cloudUploadEnabled && (
          <UploadDetailsSection
            settings={settings}
            connecting={connecting}
            connectMsg={connectMsg}
            cloudStatus={cloudStatus}
            onConnect={connectProvider}
            onDisconnect={disconnectProvider}
            onBackfill={backfillUploads}
            onRetry={retryUploads}
          />
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
          placeholder={provider === 'gdrive' ? 'xxxx.apps.googleusercontent.com' : 'your app key'}
          value={draft}
          onChange={(e: Event) => setDraft(inputValue(e))}
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
          disabled={connecting || draft === ''}
          onClick={() => onConnect(draft)}
        >
          {connecting ? 'Connecting…' : connected ? 'Reconnect' : 'Connect'}
        </Button>
        {connected && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-10"
            onClick={onDisconnect}
          >
            Disconnect
          </Button>
        )}
      </div>
    </div>
  )
}
