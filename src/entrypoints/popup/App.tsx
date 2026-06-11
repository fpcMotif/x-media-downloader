import type { ComponentChildren } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { getSettings, setSettings } from '../../core/settings'
import { aria2OriginPattern } from '../../core/download/aria2'
import type { MetricsSnapshot, Settings } from '../../core/schema'

function fmtRate(bps: number): string {
  if (bps <= 0) return '-'
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} MB/s`
  return `${Math.round(bps / 1000)} KB/s`
}

const modeOptions = [
  { value: 'direct', label: 'Direct', hint: 'Chrome downloads' },
  { value: 'fetched', label: 'Fetched', hint: 'Verify files' },
  { value: 'aria2', label: 'aria2', hint: 'External engine' },
] as const satisfies ReadonlyArray<{
  readonly value: Settings['downloadStrategy']
  readonly label: string
  readonly hint: string
}>

export function App() {
  const [settings, setSettingsState] = useState<Settings | null>(null)
  const [saved, setSaved] = useState(false)
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null)
  const [aria2Granted, setAria2Granted] = useState<boolean | null>(null)
  const [onXTab, setOnXTab] = useState(false)
  const [activeTabId, setActiveTabId] = useState<number | undefined>(undefined)
  const [clearFeedback, setClearFeedback] = useState<'media' | 'monitor' | null>(null)

  useEffect(() => {
    void getSettings().then(setSettingsState)
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        const tabs = await browser.tabs.query({ active: true, currentWindow: true })
        const tab = tabs[0]
        if (!tab) return
        setActiveTabId(tab.id)
        setOnXTab(/https?:\/\/(x|twitter)\.com\//.test(tab.url ?? ''))
      } catch {
        /* permission unavailable; the action stays disabled */
      }
    })()
  }, [])

  const strategy = settings?.downloadStrategy
  const rpcUrl = settings?.aria2RpcUrl
  useEffect(() => {
    if (strategy !== 'aria2' || rpcUrl === undefined) return
    const pattern = aria2OriginPattern(rpcUrl)
    if (pattern === null) {
      setAria2Granted(null)
      return
    }
    void browser.permissions.contains({ origins: [pattern] }).then(setAria2Granted)
  }, [strategy, rpcUrl])

  useEffect(() => {
    const poll = (): void => {
      void browser.runtime
        .sendMessage({ _tag: 'MetricsRequest' })
        .then((m) => setMetrics(m as MetricsSnapshot))
        .catch(() => {})
    }
    poll()
    const handle = setInterval(poll, 1000)
    return () => clearInterval(handle)
  }, [])

  if (!settings) {
    return <div class="xmd-popup xmd-popup--loading">Loading...</div>
  }

  const showFeedback = (kind: 'media' | 'monitor'): void => {
    setClearFeedback(kind)
    setTimeout(() => setClearFeedback(null), 1500)
  }

  const clearDetectedMedia = async (): Promise<void> => {
    if (activeTabId === undefined) return
    try {
      await browser.tabs.sendMessage(activeTabId, {
        _tag: 'ClearDetectedMediaRequest',
        rescanVisible: true,
      })
      showFeedback('media')
    } catch {
      /* tab may not have content script active */
    }
  }

  const clearMonitor = async (): Promise<void> => {
    const res = await browser.runtime
      .sendMessage({ _tag: 'ClearDownloadMonitorRequest' })
      .catch(() => null)
    if ((res as { ok?: boolean } | null)?.ok) {
      setMetrics(null)
      showFeedback('monitor')
    }
  }

  const update = async (patch: Partial<Settings>): Promise<void> => {
    setSettingsState(await setSettings(patch))
    setSaved(true)
    setTimeout(() => setSaved(false), 1200)
  }

  const requestAria2Access = async (): Promise<void> => {
    const pattern = aria2OriginPattern(settings.aria2RpcUrl)
    if (pattern === null) return
    setAria2Granted(await browser.permissions.request({ origins: [pattern] }))
  }

  const monitor = metrics && metrics.total > 0 ? metrics : null
  const monitorDone = monitor ? monitor.completed + monitor.failed : 0
  const monitorPct = monitor ? Math.min(100, Math.round((monitorDone / monitor.total) * 100)) : 0
  const canClearMonitor = monitor !== null && monitor.active === 0

  return (
    <div class="xmd-popup">
      <header class="xmd-popup-header">
        <div>
          <span class="xmd-popup-title">X Media Downloader</span>
          <p class="xmd-popup-subtitle">
            {onXTab ? 'Ready on this X tab' : 'Open X or Twitter to scan media'}
          </p>
        </div>
        <span class={`xmd-status-pill${saved ? ' xmd-status-pill--saved' : ''}`}>
          {saved ? 'Saved' : 'Local only'}
        </span>
      </header>

      <main class="xmd-popup-main">
        <section class="xmd-quick-actions" aria-label="Quick actions">
          <button
            type="button"
            class="xmd-primary-button"
            disabled={!onXTab || activeTabId === undefined}
            onClick={() => void clearDetectedMedia()}
          >
            <span>{clearFeedback === 'media' ? 'Media refreshed' : 'Find new media'}</span>
            <small>{onXTab ? 'Clear stale picks and rescan' : 'Requires an X tab'}</small>
          </button>
          {monitor && (
            <button
              type="button"
              class="xmd-secondary-button"
              disabled={!canClearMonitor}
              title={!canClearMonitor ? 'Downloads still active' : undefined}
              onClick={() => void clearMonitor()}
            >
              <span>
                {!canClearMonitor
                  ? 'Active'
                  : clearFeedback === 'monitor'
                    ? 'Monitor cleared'
                    : 'Clear monitor'}
              </span>
              <small>{!canClearMonitor ? 'Wait for downloads' : 'Reset old progress'}</small>
            </button>
          )}
        </section>

        {monitor && (
          <section class="xmd-monitor" aria-label="Download monitor">
            <div class="xmd-monitor-head">
              <div>
                <span class="xmd-section-kicker">Download monitor</span>
                <strong>
                  {monitorDone}/{monitor.total} done
                </strong>
              </div>
              <span class="xmd-monitor-percent tabular-nums">{monitorPct}%</span>
            </div>
            <progress
              class="xmd-progress"
              aria-label="Download progress"
              value={monitorPct}
              max={100}
            />
            <dl class="xmd-stat-grid">
              <Stat label="Active" value={`${monitor.active}/${monitor.concurrencyCap}`} />
              <Stat label="Speed" value={fmtRate(monitor.throughputBps)} />
              <Stat
                label="ETA"
                value={monitor.etaSeconds === undefined ? '-' : `${Math.ceil(monitor.etaSeconds)}s`}
              />
              {monitor.failed > 0 && <Stat label="Failed" value={String(monitor.failed)} />}
              {monitor.retries > 0 && <Stat label="Retries" value={String(monitor.retries)} />}
            </dl>
          </section>
        )}

        <Section title="Save defaults" description="Names and sidecars for new downloads.">
          <Field label="Filename template" hint="{handle} {tweetId} {index} {ext} {type} {date}">
            <input
              class="xmd-popup-control w-full"
              aria-label="Filename template"
              value={settings.filenameTemplate}
              onChange={(e) =>
                void update({ filenameTemplate: (e.target as HTMLInputElement).value })
              }
            />
          </Field>
          <label class="xmd-check-row">
            <input
              type="checkbox"
              aria-label="Save metadata sidecar"
              checked={settings.sidecarMetadata}
              onChange={(e) =>
                void update({ sidecarMetadata: (e.target as HTMLInputElement).checked })
              }
            />
            <span>
              <strong>Save metadata sidecar</strong>
              <small>.json next to each media file</small>
            </span>
          </label>
        </Section>

        <Section
          title="Bookmarks & Likes archive"
          description="The Archive button on /i/bookmarks and your Likes page saves media plus a per-tweet history record. Already-archived tweets are skipped."
        >
          <label class="xmd-check-row">
            <input
              type="checkbox"
              aria-label="Archive tweet text"
              checked={settings.archiveIncludeText}
              onChange={(e) =>
                void update({ archiveIncludeText: (e.target as HTMLInputElement).checked })
              }
            />
            <span>
              <strong>Include tweet text</strong>
              <small>Save the tweet's text in its history record</small>
            </span>
          </label>
          <Field
            label="Links to keep"
            hint="Scholarly: arXiv, DOI, Springer, Cambridge, Oxford & other publishers"
          >
            <select
              class="xmd-popup-control w-full"
              aria-label="Links to keep"
              value={settings.archiveLinkScope}
              onChange={(e) =>
                void update({
                  archiveLinkScope: (e.target as HTMLSelectElement)
                    .value as Settings['archiveLinkScope'],
                })
              }
            >
              <option value="all">All links</option>
              <option value="scholarly">Scholarly only</option>
              <option value="none">None</option>
            </select>
          </Field>
          <label class="xmd-check-row">
            <input
              type="checkbox"
              aria-label="Remove bookmark or like after save"
              checked={settings.archiveRemoveAfterSave}
              onChange={(e) =>
                void update({ archiveRemoveAfterSave: (e.target as HTMLInputElement).checked })
              }
            />
            <span>
              <strong>Remove bookmark / like after save</strong>
              <small>Clicks X's own button once saved. Opt-in; off by default</small>
            </span>
          </label>
        </Section>

        <Section title="Speed" description="Keep direct mode conservative; raise only when needed.">
          <div class="xmd-inline-fields">
            <Field label="Concurrent downloads">
              <input
                type="number"
                min={1}
                max={10}
                class="xmd-popup-control xmd-number-input text-center tabular-nums"
                aria-label="Concurrent downloads"
                value={settings.downloadConcurrency}
                onChange={(e) =>
                  void update({
                    downloadConcurrency: Number((e.target as HTMLInputElement).value) || 1,
                  })
                }
              />
            </Field>
            {settings.downloadStrategy === 'aria2' && (
              <Field label="aria2 split">
                <input
                  type="number"
                  min={1}
                  max={16}
                  class="xmd-popup-control xmd-number-input text-center tabular-nums"
                  aria-label="aria2 split"
                  value={settings.aria2Split}
                  onChange={(e) =>
                    void update({ aria2Split: Number((e.target as HTMLInputElement).value) || 1 })
                  }
                />
              </Field>
            )}
          </div>
        </Section>

        <Section title="Download mode" description="Direct is the safest default.">
          <div class="xmd-mode-picker" aria-label="Download mode">
            {modeOptions.map((option) => {
              const selected = settings.downloadStrategy === option.value
              return (
                <label
                  key={option.value}
                  class={`xmd-mode-button${selected ? ' xmd-mode-button--selected' : ''}`}
                >
                  <input
                    class="xmd-mode-input"
                    type="radio"
                    name="downloadStrategy"
                    value={option.value}
                    checked={selected}
                    aria-label={`Download mode: ${option.label}`}
                    onChange={() => void update({ downloadStrategy: option.value })}
                  />
                  <span>{option.label}</span>
                  <small>{option.hint}</small>
                </label>
              )
            })}
          </div>

          {settings.downloadStrategy === 'aria2' && (
            <div class="xmd-mode-details">
              <Field label="RPC URL">
                <input
                  class="xmd-popup-control w-full"
                  aria-label="aria2 RPC URL"
                  value={settings.aria2RpcUrl}
                  onChange={(e) =>
                    void update({ aria2RpcUrl: (e.target as HTMLInputElement).value })
                  }
                />
              </Field>
              <Field label="RPC secret">
                <input
                  type="password"
                  class="xmd-popup-control w-full"
                  aria-label="aria2 RPC secret"
                  value={settings.aria2Secret}
                  onChange={(e) =>
                    void update({ aria2Secret: (e.target as HTMLInputElement).value })
                  }
                />
              </Field>
              <Field label="Download directory">
                <input
                  class="xmd-popup-control w-full"
                  aria-label="aria2 download directory"
                  placeholder="aria2 default"
                  value={settings.aria2Dir}
                  onChange={(e) => void update({ aria2Dir: (e.target as HTMLInputElement).value })}
                />
              </Field>
              {aria2Granted === false && (
                <button
                  type="button"
                  class="xmd-primary-button xmd-primary-button--compact w-full"
                  onClick={() => void requestAria2Access()}
                >
                  <span>Grant localhost access</span>
                </button>
              )}
              {aria2Granted === true && <p class="xmd-inline-success">localhost access granted</p>}
            </div>
          )}
        </Section>

        <Section title="Assist">
          <label class="xmd-check-row">
            <input
              type="checkbox"
              aria-label="Authenticated fallback"
              checked={settings.authFallbackEnabled}
              onChange={(e) =>
                void update({ authFallbackEnabled: (e.target as HTMLInputElement).checked })
              }
            />
            <span>
              <strong>Authenticated fallback</strong>
              <small>Opt-in only</small>
            </span>
          </label>

          <label class="xmd-check-row">
            <input
              type="checkbox"
              aria-label="Quick Grab"
              checked={settings.quickGrabEnabled}
              onChange={(e) =>
                void update({ quickGrabEnabled: (e.target as HTMLInputElement).checked })
              }
            />
            <span>
              <strong>Hover quick grab</strong>
              <small>Hold modifier to grab one photo</small>
            </span>
          </label>

          {settings.quickGrabEnabled && (
            <Field label="Quick grab modifier">
              <select
                class="xmd-popup-control w-full"
                aria-label="Quick grab modifier"
                value={settings.quickGrabModifier}
                onChange={(e) =>
                  void update({
                    quickGrabModifier: (e.target as HTMLSelectElement)
                      .value as Settings['quickGrabModifier'],
                  })
                }
              >
                <option value="alt">Alt / Option</option>
                <option value="shift">Shift</option>
                <option value="ctrl">Control</option>
                <option value="meta">Cmd / Win</option>
              </select>
            </Field>
          )}
        </Section>
      </main>

      <footer class="xmd-popup-footer">No telemetry. No remote downloader.</footer>
    </div>
  )
}

function Section({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: ComponentChildren
}) {
  return (
    <section class="xmd-section">
      <div class="xmd-section-head">
        <div>
          <span class="xmd-section-title">{title}</span>
          {description && <p>{description}</p>}
        </div>
      </div>
      <div class="xmd-section-body">{children}</div>
    </section>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ComponentChildren
}) {
  return (
    <div class="xmd-field">
      <label>{label}</label>
      {children}
      {hint && <p>{hint}</p>}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  )
}
