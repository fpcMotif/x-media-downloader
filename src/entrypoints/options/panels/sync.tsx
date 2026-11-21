import { useEffect, useState } from 'preact/hooks'
import { Option, Schema } from 'effect'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '@/theme/tokens.stylex'
import { convexOriginPattern } from '@/packages/sync/convex'
import type { SyncStatus } from '@/packages/sync/status'
import { FETCHED_HOST_PATTERNS } from '@/packages/download/fetched-strategy'
import type { CloudProviderId } from '@/packages/cloud/types'
import { PROVIDERS } from '@/packages/cloud/provider'
import { describeUploadSummary, type CloudUploadStatus } from '@/packages/cloud/status'
import { hasLiveCloudDestination, saveToDiskToggleDelta } from '@/packages/settings/coupling'
import { Button } from '@/components/ui/button'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { inputValue, PanelHeader, Section, type PanelProps } from '../ui'
import { offersGrantRequest, useOriginGrant } from '@/components/use-origin-grant'

const styles = stylex.create({
  // Shared 'min-h-10' override used by every options action Button below.
  minH10: { minHeight: '2.5rem' },
  selfStart: { alignSelf: 'flex-start' },
  // 'flex flex-wrap items-center gap-2' button rows.
  flexWrapRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.5rem' },
  // Base of every status <p>: 'text-sm leading-snug text-pretty' — leading-snug
  // (1.375) always wins over text-sm's own line-height. Combine with one of
  // the color-* variants below (later argument wins per property).
  statusText: { fontSize: '0.875rem', lineHeight: '1.375', textWrap: 'pretty' },
  colorSuccess: { color: tokens['--success'] },
  colorDestructive: { color: tokens['--destructive'] },
  colorMuted: { color: tokens['--muted-foreground'] },
  // 'text-[13px] font-medium text-success' span — text-[13px] sets fontSize
  // only, line-height stays inherited.
  grantedText: { fontSize: '13px', fontWeight: 500, color: tokens['--success'] },
  redirectCode: {
    fontFamily: tokens['--font-mono'],
    fontSize: '0.75rem',
    lineHeight: tokens['--text-xs--line-height'],
    wordBreak: 'break-all',
    color: tokens['--muted-foreground'],
  },
  // CloudProviderRow root: 'grid gap-3 border-l border-border pl-4' (no
  // divide-y/rows here, unlike the aria2 sub-group in saving.tsx).
  providerRoot: {
    display: 'grid',
    gap: '0.75rem',
    borderLeftStyle: 'solid',
    borderLeftWidth: '1px',
    borderColor: tokens['--border'],
    paddingLeft: '1rem',
  },
  // 'flex items-center justify-between gap-2' — shared by the provider header
  // row and the cloud-status row.
  headerRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.5rem',
  },
  // 'text-sm font-semibold' provider label.
  providerLabel: {
    fontSize: '0.875rem',
    lineHeight: tokens['--text-sm--line-height'],
    fontWeight: 600,
  },
  // 'shrink-0 text-[13px]' connection-state span; combine with a color-*.
  shrinkText13: { flexShrink: 0, fontSize: '13px' },
  // "Where do I get this?" anchor: 'rounded-sm outline-none
  // focus-visible:ring-3 focus-visible:ring-ring/50' (underline/hover come
  // from app.css's FieldDescription > a rule, untouched).
  anchorLink: {
    borderRadius: 'calc(var(--radius) - 4px)',
    outlineStyle: 'none',
    boxShadow: {
      default: null,
      ':focus-visible': '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 0 3px var(--ring), 0 0 #0000',
    },
  },
})

const RelaySetup = Schema.Struct({
  available: Schema.Boolean,
  reason: Schema.NullOr(Schema.String),
})

const decodeSyncStatus = Schema.decodeUnknownOption(
  Schema.Struct({ ok: Schema.Boolean, detail: Schema.String, pending: Schema.Number }),
)

const decodeCloudUploadStatus = Schema.decodeUnknownOption(
  Schema.Struct({
    summary: Schema.Struct({
      pending: Schema.Number,
      uploading: Schema.Number,
      succeeded: Schema.Number,
      failed: Schema.Number,
      dead: Schema.Number,
      skipped: Schema.Number,
    }),
    lastError: Schema.NullOr(Schema.String),
  }),
)

const decodeOkReply = Schema.decodeUnknownOption(Schema.Struct({ ok: Schema.Boolean }))

const decodeDetailReply = Schema.decodeUnknownOption(Schema.Struct({ detail: Schema.String }))

const replyDetail = (reply: Option.Option<{ readonly detail: string }>): string =>
  Option.match(reply, {
    onNone: () => 'The extension background did not respond.',
    onSome: (r) => r.detail,
  })

const readRedirectUrl = (): string => {
  try {
    return browser.identity.getRedirectURL()
  } catch {
    return ''
  }
}

const retryUploads = async (): Promise<void> => {
  await browser.runtime.sendMessage({ _tag: 'CloudRetryRequest' }).catch(() => {})
}

export function SyncPanel({ settings, update, reload }: PanelProps) {
  const redirectUrl = readRedirectUrl()
  const [testingSync, setTestingSync] = useState(false)
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null)
  const [cloudStatus, setCloudStatus] = useState<CloudUploadStatus | null>(null)
  const [connecting, setConnecting] = useState<CloudProviderId | 'none'>('none')
  const [connectMsg, setConnectMsg] = useState('')
  const [relaySetup, setRelaySetup] = useState<typeof RelaySetup.Type | null>(null)
  const [checkingRelay, setCheckingRelay] = useState(false)
  const [relayMessage, setRelayMessage] = useState('')
  const checkRelay = async (): Promise<void> => {
    setCheckingRelay(true)
    try {
      const result = Schema.decodeUnknownSync(RelaySetup)(
        await browser.runtime.sendMessage({ _tag: 'RelaySetupRequest' }),
      )
      setRelaySetup(result)
      setRelayMessage(result.reason ?? 'Deployment ready. Credentials stay on your deployment.')
    } catch {
      setRelaySetup(null)
      setRelayMessage(
        'Setup check failed. Verify the deployment, host permission, and sync secret.',
      )
    } finally {
      setCheckingRelay(false)
    }
  }
  const toggleRelay = async (enabled: boolean): Promise<void> => {
    try {
      await update({
        convexDriveEnabled: enabled,
        convexDriveConnected: enabled || settings.convexDriveConnected,
        ...(enabled && { saveToDisk: false, downloadHistoryEnabled: true }),
      })
      setRelayMessage(
        enabled
          ? 'New grabs submit metadata only. Download History stays queued until Drive confirms completion.'
          : 'New grabs use your ordinary destinations. Accepted server jobs keep their original ownership and status.',
      )
    } catch {
      setRelayMessage(
        'The backend did not acknowledge this change. Your settings remain unchanged.',
      )
    }
  }

  const cloudOn = settings.cloudSyncEnabled
  const convexUrl = settings.convexUrl
  const convexSecret = settings.convexSyncSecret
  const configKey = `${convexUrl}\n${convexSecret}`
  const [syncStatusKey, setSyncStatusKey] = useState(configKey)
  if (syncStatusKey !== configKey) {
    setSyncStatusKey(configKey)
    setSyncStatus(null)
  }
  const convexAccess = useOriginGrant(cloudOn ? convexOriginPattern(convexUrl) : Option.none())
  useEffect(() => {
    if (!cloudOn) {
      setSyncStatus(null)
      return
    }
    void browser.runtime
      .sendMessage({ _tag: 'SyncStatusRequest' })
      .then((s) => setSyncStatus(Option.getOrNull(decodeSyncStatus(s))))
      .catch(() => {})
  }, [cloudOn])

  const uploadOn = settings.cloudUploadEnabled
  useEffect(() => {
    if (!uploadOn) {
      setCloudStatus(null)
      return undefined
    }
    const poll = (): void => {
      void browser.runtime
        .sendMessage({ _tag: 'CloudStatusRequest' })
        .then((s) => setCloudStatus(Option.getOrNull(decodeCloudUploadStatus(s))))
        .catch(() => {})
    }
    poll()
    const handle = setInterval(poll, 2000)
    return () => clearInterval(handle)
  }, [uploadOn])

  const testConvexConnection = async (): Promise<void> => {
    setTestingSync(true)
    try {
      const res = await browser.runtime.sendMessage({ _tag: 'SyncTestRequest' })
      setSyncStatus(Option.getOrNull(decodeSyncStatus(res)))
    } catch {
      setSyncStatus({ ok: false, detail: 'The extension background did not respond.', pending: 0 })
    } finally {
      setTestingSync(false)
    }
  }

  // Grant the provider API + twimg source origins from THIS click (user gesture),
  // then run the PKCE flow in the background SW (it survives this tab losing focus).
  const connectProvider = async (
    provider: CloudProviderId,
    clientId: string,
    clientSecret: string,
  ): Promise<void> => {
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
      const res = decodeDetailReply(
        await browser.runtime
          .sendMessage({ _tag: 'CloudConnectRequest', provider, clientId, clientSecret })
          .catch(() => null),
      )
      await reload()
      setConnectMsg(replyDetail(res))
    } finally {
      setConnecting('none')
    }
  }

  const disconnectProvider = async (provider: CloudProviderId): Promise<void> => {
    const result = await browser.runtime
      .sendMessage({ _tag: 'CloudDisconnectRequest', provider })
      .catch(() => null)
    await reload()
    if (!Option.exists(decodeOkReply(result), (r) => r.ok)) {
      const message =
        'Disconnect was not acknowledged. Backend authorization may still be active; retry before closing the browser.'
      setConnectMsg(message)
      setRelayMessage(message)
      return
    }
    setConnectMsg(`Disconnected ${PROVIDERS[provider].label}.`)
    if (provider === 'gdrive')
      setRelayMessage(
        'Backend Drive authorization was disconnected. Accepted job status remains available.',
      )
  }

  const backfillUploads = async (): Promise<void> => {
    setConnectMsg('Queuing past downloads…')
    const res = decodeDetailReply(
      await browser.runtime.sendMessage({ _tag: 'CloudBackfillRequest' }).catch(() => null),
    )
    setConnectMsg(replyDetail(res))
  }

  return (
    <>
      <PanelHeader title="Sync" />

      <Section title="Cloud upload">
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="cloudUploadEnabled">Upload to Drive or Dropbox</FieldLabel>
          </FieldContent>
          <Switch
            id="cloudUploadEnabled"
            checked={settings.cloudUploadEnabled}
            onCheckedChange={(checked: boolean) => void update({ cloudUploadEnabled: checked })}
          />
        </Field>

        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="saveToDisk">Save to this computer</FieldLabel>
            <FieldDescription>Turn off to keep new grabs in the cloud only</FieldDescription>
          </FieldContent>
          <Switch
            id="saveToDisk"
            checked={settings.saveToDisk}
            disabled={
              settings.saveToDisk &&
              !settings.convexDriveEnabled &&
              !hasLiveCloudDestination(settings)
            }
            onCheckedChange={(checked: boolean) =>
              void update(saveToDiskToggleDelta(checked, settings))
            }
          />
        </Field>

        {settings.cloudUploadEnabled && (
          <>
            {redirectUrl !== '' && (
              <Field>
                <FieldLabel>Redirect URL</FieldLabel>
                <code {...stylex.props(styles.redirectCode)}>{redirectUrl}</code>
                <FieldDescription>
                  Register it in your Google or Dropbox app console
                </FieldDescription>
              </Field>
            )}
            <CloudProviderRow
              key={`gdrive:${settings.gdriveClientId}:${settings.gdriveClientSecret}`}
              provider="gdrive"
              clientId={settings.gdriveClientId}
              clientSecret={settings.gdriveClientSecret}
              connected={settings.gdriveRefreshToken !== ''}
              account={settings.gdriveAccount}
              connecting={connecting === 'gdrive'}
              uploadEnabled={settings.gdriveUploadEnabled}
              onUploadToggle={(checked: boolean) => void update({ gdriveUploadEnabled: checked })}
              onConnect={(clientId, clientSecret) =>
                void connectProvider('gdrive', clientId, clientSecret)
              }
              onDisconnect={() => void disconnectProvider('gdrive')}
            />
            <CloudProviderRow
              key={`dropbox:${settings.dropboxClientId}`}
              provider="dropbox"
              clientId={settings.dropboxClientId}
              clientSecret=""
              connected={settings.dropboxRefreshToken !== ''}
              account={settings.dropboxAccount}
              connecting={connecting === 'dropbox'}
              uploadEnabled={settings.dropboxUploadEnabled}
              onUploadToggle={(checked: boolean) => void update({ dropboxUploadEnabled: checked })}
              onConnect={(clientId, clientSecret) =>
                void connectProvider('dropbox', clientId, clientSecret)
              }
              onDisconnect={() => void disconnectProvider('dropbox')}
            />
            {(settings.gdriveRefreshToken !== '' || settings.dropboxRefreshToken !== '') && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                sx={[styles.minH10, styles.selfStart]}
                onClick={() => void backfillUploads()}
              >
                Back up past downloads
              </Button>
            )}
            {connectMsg && (
              <p {...stylex.props(styles.statusText, styles.colorMuted)}>{connectMsg}</p>
            )}
            {cloudStatus && (
              <div {...stylex.props(styles.headerRow)}>
                <p
                  {...stylex.props(
                    styles.statusText,
                    cloudStatus.lastError ? styles.colorDestructive : styles.colorMuted,
                  )}
                >
                  {cloudStatus.lastError ?? describeUploadSummary(cloudStatus.summary)}
                </p>
                {(cloudStatus.summary.dead > 0 || cloudStatus.summary.failed > 0) && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    sx={styles.minH10}
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

      <Section title="Metadata sync">
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="cloudSyncEnabled">Sync to Convex</FieldLabel>
            <FieldDescription>
              Metadata only, never files. Needs your Convex deployment.
            </FieldDescription>
          </FieldContent>
          <Switch
            id="cloudSyncEnabled"
            checked={settings.cloudSyncEnabled}
            onCheckedChange={(checked: boolean) =>
              void update({
                cloudSyncEnabled: checked,
                ...(checked &&
                  settings.cloudDeviceId === '' && { cloudDeviceId: crypto.randomUUID() }),
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
                placeholder="https://<deployment>.convex.cloud"
                value={settings.convexUrl}
                onChange={(e: Event) => void update({ convexUrl: inputValue(e) })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="convexSyncSecret">Sync secret</FieldLabel>
              <Input
                id="convexSyncSecret"
                type="password"
                placeholder="must match the deployment's SYNC_SHARED_SECRET"
                value={settings.convexSyncSecret}
                onChange={(e: Event) => void update({ convexSyncSecret: inputValue(e) })}
              />
            </Field>
            <div {...stylex.props(styles.flexWrapRow)}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                sx={styles.minH10}
                disabled={
                  testingSync || settings.convexUrl === '' || settings.convexSyncSecret === ''
                }
                onClick={() => void testConvexConnection()}
              >
                {testingSync ? 'Testing…' : 'Test connection'}
              </Button>
              {offersGrantRequest(convexAccess.grant) && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  sx={styles.minH10}
                  onClick={() => void convexAccess.request()}
                >
                  Grant access
                </Button>
              )}
              {convexAccess.grant === 'granted' && (
                <span {...stylex.props(styles.grantedText)}>access granted</span>
              )}
            </div>
            {syncStatus && (
              <p
                {...stylex.props(
                  styles.statusText,
                  syncStatus.ok ? styles.colorSuccess : styles.colorDestructive,
                )}
              >
                {syncStatus.detail}
              </p>
            )}
          </>
        )}
      </Section>

      <Section title="Experimental: Drive uploads through Convex" collapsed>
        <Button
          type="button"
          variant="outline"
          disabled={checkingRelay}
          onClick={() => void checkRelay()}
        >
          {checkingRelay ? 'Checking deployment…' : 'Check deployment setup'}
        </Button>
        <output {...stylex.props(styles.statusText, styles.colorMuted)}>{relayMessage}</output>
        <div {...stylex.props(styles.headerRow)}>
          <div>
            <label htmlFor="convexDriveEnabled" {...stylex.props(styles.providerLabel)}>
              Use Convex for Drive uploads
            </label>
            <p id="convexDriveDescription" {...stylex.props(styles.statusText, styles.colorMuted)}>
              Drive uploads run on your deployment and finish after the browser closes. Needs Drive
              upload on. Turns on History and turns off Save to this computer.
            </p>
          </div>
          <Switch
            id="convexDriveEnabled"
            aria-describedby="convexDriveDescription"
            checked={settings.convexDriveEnabled}
            disabled={
              !settings.convexDriveEnabled &&
              (!relaySetup?.available ||
                !settings.cloudUploadEnabled ||
                !settings.gdriveUploadEnabled)
            }
            onCheckedChange={(checked: boolean) => void toggleRelay(checked)}
          />
        </div>
        {settings.convexDriveConnected && (
          <Button type="button" variant="outline" onClick={() => void disconnectProvider('gdrive')}>
            Disconnect backend Drive
          </Button>
        )}
      </Section>
    </>
  )
}

function CloudProviderRow({
  provider,
  clientId,
  clientSecret,
  connected,
  account,
  connecting,
  uploadEnabled,
  onUploadToggle,
  onConnect,
  onDisconnect,
}: {
  provider: CloudProviderId
  clientId: string
  clientSecret: string
  connected: boolean
  account: string
  connecting: boolean
  uploadEnabled: boolean
  onUploadToggle: (checked: boolean) => void
  onConnect: (clientId: string, clientSecret: string) => void
  onDisconnect: () => void
}) {
  const label = PROVIDERS[provider].label
  const idLabel = provider === 'gdrive' ? 'OAuth client ID' : 'App key'
  // A provider whose record declares a `clientSecret` field is NOT a public
  // client — Google's Web application client rejects a secret-free PKCE exchange.
  // The field's absence (Dropbox) is what hides this input.
  const needsSecret = PROVIDERS[provider].fields.clientSecret !== undefined
  // Client id lives in local draft state and rides with Connect — the panel never
  // writes it to the settings blob (single-writer, ADR-0005). Seed from the
  // persisted value and resync when it changes (e.g. after a successful connect).
  const [draft, setDraft] = useState(clientId)
  const [secretDraft, setSecretDraft] = useState(clientSecret)
  return (
    <div {...stylex.props(styles.providerRoot)}>
      <div {...stylex.props(styles.headerRow)}>
        <span {...stylex.props(styles.providerLabel)}>{label}</span>
        {connected ? (
          <span {...stylex.props(styles.shrinkText13, styles.colorSuccess)}>
            {account !== '' ? account : 'connected'}
          </span>
        ) : (
          <span {...stylex.props(styles.shrinkText13, styles.colorMuted)}>Not connected</span>
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
            {...stylex.props(styles.anchorLink)}
          >
            Where do I get this? →
          </a>
        </FieldDescription>
      </Field>
      {needsSecret && (
        <Field>
          <FieldLabel htmlFor={`${provider}ClientSecret`}>Client secret</FieldLabel>
          <Input
            id={`${provider}ClientSecret`}
            type="password"
            placeholder="GOCSPX-…"
            value={secretDraft}
            onChange={(e: Event) => setSecretDraft(inputValue(e))}
          />
          <FieldDescription>Required by Google. Stays in this browser.</FieldDescription>
        </Field>
      )}
      <div {...stylex.props(styles.flexWrapRow)}>
        <Button
          type="button"
          variant={connected ? 'outline' : 'default'}
          size="sm"
          sx={styles.minH10}
          disabled={connecting || draft === ''}
          onClick={() => onConnect(draft, secretDraft)}
        >
          {connecting ? 'Connecting…' : connected ? 'Reconnect' : 'Connect'}
        </Button>
        {connected && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            sx={styles.minH10}
            onClick={onDisconnect}
          >
            Disconnect
          </Button>
        )}
      </div>
      {/* Pause is NOT disconnect (issue #95): tokens and the account label
          stay, queued/in-flight jobs keep draining, only new uploads stop.
          Pausing the last live destination while Cloud-only is on forces
          Save to this computer back on (settings-service backstop). */}
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor={`${provider}UploadEnabled`}>Upload</FieldLabel>
          <FieldDescription>Off pauses new uploads and stays connected</FieldDescription>
        </FieldContent>
        <Switch
          id={`${provider}UploadEnabled`}
          checked={uploadEnabled}
          onCheckedChange={onUploadToggle}
        />
      </Field>
    </div>
  )
}
