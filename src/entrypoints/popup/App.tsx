import { useEffect, useState } from 'preact/hooks'
import { Option } from 'effect'
import { getSettings, setSettings } from '@/core/settings'
import { DOWNLOAD_MODES } from '@/core/download/strategy'
import { CLEAR_AFTER_DOWNLOAD } from '@/core/clear/copy'
import { pageScope } from '@/core/clear/clearer'
import { isXUrl } from '@/core/adapters/x'
import type { MetricsSnapshot, Settings } from '@/core/schema'
import { cn } from '@/lib/utils'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Progress } from '@/components/ui/progress'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { LayersIcon, EraserIcon, CheckIcon } from '@/components/icons'
import { fetchCaptureSummary, type CaptureSummary } from '@/components/capture-export'
import { CaptureQuickActions } from './capture-quick-actions'

function fmtRate(bps: number): string {
  if (bps <= 0) return '-'
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} MB/s`
  return `${Math.round(bps / 1000)} KB/s`
}

function fmtBytes(bytes: number): string {
  if (bytes <= 0) return '-'
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  if (bytes >= 1000) return `${Math.round(bytes / 1000)} KB`
  return `${bytes} B`
}

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`

// Poll the download monitor briskly while a batch is live, but back off when
// idle — the snapshot is only surfaced when total > 0, so a 1s round-trip to
// the SW every second is wasted work for an open popup with no batch running.
const POLL_ACTIVE_MS = 1000
const POLL_IDLE_MS = 3000

const PAGE_UNREACHABLE = 'Could not reach the page — reload the X tab and try again.'

const CLEAR_SCOPES: ReadonlyArray<{ key: keyof Settings; label: string }> = [
  { key: 'autoUnbookmarkOnSave', label: 'Bookmarks' },
  { key: 'autoUnlikeOnSave', label: 'Likes' },
  { key: 'autoNotInterestedOnSave', label: 'For You' },
]

const clearScopeSummary = (settings: Settings): string => {
  const active = CLEAR_SCOPES.filter((s) => settings[s.key]).map((s) => s.label)
  return active.length > 0 ? active.join(' · ') : 'No scopes selected'
}

/** A worklist button that messages the active tab's content script and turns the
 *  reply into a status line. Owns its own busy state and the shared confirm →
 *  query-tab → send → format → error skeleton, writing the result into a shared
 *  `setMsg` slot so siblings never leave a stale line; each caller supplies the
 *  optional confirm copy, the message tag, the result→string mapper, and setMsg. */
function usePageAction<R>(config: {
  /** Confirm prompt to show before running; omit (undefined) to skip the gate. */
  confirm?: string | undefined
  request: { _tag: string }
  format: (res: R | null) => string
  /** Shared status-line setter — cleared on run start, set on completion/error, so
   *  only the most recent action's message shows (never a stale sibling button's). */
  setMsg: (m: string | null) => void
}): { busy: boolean; run: () => Promise<void> } {
  const [busy, setBusy] = useState(false)

  const run = async (): Promise<void> => {
    if (config.confirm !== undefined && !confirm(config.confirm)) return
    setBusy(true)
    config.setMsg(null)
    try {
      const [tab] = await browser.tabs.query({
        active: true,
        currentWindow: true,
      })
      if (tab?.id === undefined) {
        config.setMsg('No active tab.')
        return
      }
      const res = (await browser.tabs.sendMessage(tab.id, config.request)) as R | null
      config.setMsg(config.format(res))
    } catch {
      config.setMsg(PAGE_UNREACHABLE)
    } finally {
      setBusy(false)
    }
  }

  return { busy, run }
}

const openOptions = (): void => void browser.runtime.openOptionsPage()

const openOptionsSection = (hash: string): void =>
  void browser.tabs.create({ url: `${browser.runtime.getURL('/options.html')}#${hash}` })

// openOptionsPage can't carry a hash, so it always lands on General; the capture
// card deep-links straight to the Knowledge Capture panel instead (the options
// app reads location.hash on mount to select the section).
const openCaptureArchive = (): void => openOptionsSection('capture')
const openClearingSettings = (): void => openOptionsSection('clearing')

export function App() {
  const [settings, setSettingsState] = useState<Settings | null>(null)
  const [saved, setSaved] = useState(false)
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null)
  const [onXTab, setOnXTab] = useState(false)
  const [onListPage, setOnListPage] = useState(false)
  // One shared status line for the page actions, so the most recent action's
  // result always shows instead of an earlier action's stale message.
  const [actionMsg, setActionMsg] = useState<string | null>(null)
  const [clearFeedback, setClearFeedback] = useState(false)
  const [captureSummary, setCaptureSummary] = useState<CaptureSummary | null>(null)

  // Whether a worklist action will ALSO clear: "Clear after download" is on AND
  // the strategy is byte-verifiable (aria2 hand-offs are excluded). Drives the
  // primary button's label and the confirm() gating — when off, the actions
  // just download. Computed before the loading early-return so the action hooks
  // below (which must run unconditionally) can close over it.
  const willClear =
    settings !== null && settings.clearOnSave && settings.downloadStrategy !== 'aria2'
  const noClearHint = settings?.clearOnSave
    ? 'aria2 hand-offs can’t be verified — posts download but aren’t removed (use Direct or Fetched to clear).'
    : 'Turn on “Clear after download” below to also remove each from this list.'

  // Manual one-shot clear: un-bookmark / un-like every post currently on the X
  // page, via the content script (the same click path that works by hand).
  // Page-scoped: the content script derives bookmark-vs-like from the list URL
  // itself, so this carries no scope payload (the per-scope toggles live in
  // Settings and govern the download-driven clear, not this manual button).
  const clearVisible = usePageAction<{ cleared?: number }>({
    confirm: 'Un-like / un-bookmark every post currently on this page? This cannot be undone.',
    request: { _tag: 'ClearVisibleRequest' },
    format: (res) => `Cleared ${plural(res?.cleared ?? 0, 'post')} on this page.`,
    setMsg: setActionMsg,
  })

  // Whole-list clear: auto-scroll the entire Likes/Bookmarks list and un-like /
  // un-bookmark every post — heavier and irreversible, so it carries the strongest
  // confirm and is gated to list pages.
  const clearWholeList = usePageAction<{ cleared?: number; reason?: string }>({
    confirm:
      'Un-like / un-bookmark EVERY post on this list by scrolling through all of it? ' +
      'This can affect hundreds of posts and cannot be undone.',
    request: { _tag: 'ClearWholeListRequest' },
    format: (res) => {
      if (res?.reason === 'not-list-page') return 'Open a Likes or Bookmarks list to clear it.'
      const n = res?.cleared ?? 0
      return n === 0
        ? 'No posts to clear on this list.'
        : `Cleared ${plural(n, 'post')} across the list.`
    },
    setMsg: setActionMsg,
  })

  // "Download this page (all at once)": fire every detected post into the queue.
  const drain = usePageAction<{ count?: number }>({
    confirm: willClear
      ? 'Download every post on this page and remove it from this list (un-like on Likes, un-bookmark on Bookmarks) as its media finishes?'
      : undefined,
    request: { _tag: 'DrainPageRequest' },
    format: (res) => {
      const n = res?.count ?? 0
      return n === 0
        ? 'No media detected yet — scroll to load posts, then try again.'
        : willClear
          ? `Downloading ${plural(n, 'item')} — each post clears as it finishes.`
          : `Downloading ${plural(n, 'item')}.`
    },
    setMsg: setActionMsg,
  })

  // Durable one-by-one sweep: hand this list's posts to the background, which
  // queues each download. Progress is saved; scroll to load more and run again.
  const sweep = usePageAction<{
    queued?: number
    skipped?: number
    reason?: string
  }>({
    confirm: willClear
      ? 'Go down this page one post at a time — download each, then remove it from THIS list (un-like on Likes, un-bookmark on Bookmarks) once its media truly finishes?'
      : undefined,
    request: { _tag: 'SweepPageRequest' },
    setMsg: setActionMsg,
    format: (res) => {
      if (res?.reason === 'not-list-page')
        return 'Open a Likes or Bookmarks page — the sweep only runs on a list.'
      if (res?.reason === 'context')
        return 'Reload the X tab (the extension was updated), then try again.'
      const q = res?.queued ?? 0
      const s = res?.skipped ?? 0
      return q === 0 && s === 0
        ? 'No new media detected — scroll to load posts, then run again.'
        : willClear
          ? `Queued ${plural(q, 'post')}${s > 0 ? `, skipped ${s} already cleared` : ''}. Each removes itself from this list as its download finishes — scroll and run again.`
          : `Queued ${plural(q, 'post')} for download. ${noClearHint}`
    },
  })

  useEffect(() => {
    void getSettings().then(setSettingsState)
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        const tabs = await browser.tabs.query({
          active: true,
          currentWindow: true,
        })
        const tab = tabs[0]
        if (!tab) return
        const url = tab.url ?? ''
        setOnXTab(isXUrl(url))
        try {
          setOnListPage(isXUrl(url) && Option.isSome(pageScope(new URL(url).pathname)))
        } catch {
          setOnListPage(false)
        }
      } catch {
        /* permission unavailable; the action stays disabled */
      }
    })()
  }, [])

  useEffect(() => {
    // limit 3: enough for the popup's own trimmed recent-conversation disclosure
    // (CaptureQuickActions) without paying for the full archive-browser payload.
    void fetchCaptureSummary(3).then(setCaptureSummary)
  }, [])

  useEffect(() => {
    let handle: ReturnType<typeof setTimeout>
    const poll = (): void => {
      void browser.runtime
        .sendMessage({ _tag: 'MetricsRequest' })
        .then((m) => {
          const snapshot = m as MetricsSnapshot | null
          setMetrics(snapshot)
          // Slow the cadence when no batch is active — the monitor (and thus the
          // snapshot) is only shown while total > 0.
          const next = snapshot && snapshot.total > 0 ? POLL_ACTIVE_MS : POLL_IDLE_MS
          handle = setTimeout(poll, next)
          return next
        })
        .catch(() => {
          handle = setTimeout(poll, POLL_IDLE_MS)
        })
    }
    poll()
    return () => clearTimeout(handle)
  }, [])

  if (!settings) {
    return <div className="xmd-popup xmd-popup--loading">Loading...</div>
  }

  const update = async (patch: Partial<Settings>): Promise<void> => {
    setSettingsState(await setSettings(patch))
    setSaved(true)
    setTimeout(() => setSaved(false), 1200)
  }

  const clearMonitor = async (): Promise<void> => {
    const res = await browser.runtime
      .sendMessage({ _tag: 'ClearDownloadMonitorRequest' })
      .catch(() => null)
    if ((res as { ok?: boolean } | null)?.ok) {
      setMetrics(null)
      setClearFeedback(true)
      setTimeout(() => setClearFeedback(false), 1500)
    }
  }

  // Only surface the monitor for a real download batch — not for stray hover/UI
  // trace events that also ride the metrics snapshot.
  const monitor = metrics && metrics.total > 0 ? metrics : null
  const monitorDone = monitor ? monitor.completed + monitor.failed : 0
  const monitorPct = monitor ? Math.min(100, Math.round((monitorDone / monitor.total) * 100)) : 0
  const canClearMonitor = monitor !== null && monitor.active === 0
  const metaLine = monitor
    ? [
        monitor.throughputBps > 0 ? fmtRate(monitor.throughputBps) : null,
        monitor.etaSeconds !== undefined ? `${Math.ceil(monitor.etaSeconds)}s left` : null,
        monitor.bytesTotal > 0
          ? `${fmtBytes(monitor.bytesReceived)} / ${fmtBytes(monitor.bytesTotal)}`
          : null,
        monitor.failed > 0 ? `${plural(monitor.failed, 'failed')}` : null,
        monitor.retries > 0 ? `${plural(monitor.retries, 'retry')}` : null,
      ]
        .filter((part): part is string => part !== null)
        .join(' · ')
    : ''

  return (
    <div className="xmd-popup">
      <header className="sticky top-0 z-10 flex h-11 items-center justify-between gap-3 border-b border-border bg-background px-3.5">
        <span className="truncate text-[13px] leading-tight font-semibold tracking-tight">
          X Media Downloader
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-xs leading-snug text-muted-foreground">
          <span
            className={cn(
              'size-1.5 rounded-full',
              onXTab ? 'bg-success' : 'bg-muted-foreground/40',
            )}
          />
          {onXTab ? 'Ready on this X tab' : 'Open X or Twitter'}
        </span>
      </header>

      <main className="flex flex-col gap-5 px-3.5 py-4">
        {monitor && (
          <section aria-label="Download monitor" className="grid gap-2 border-b border-border pb-4">
            <div className="flex items-end justify-between gap-3">
              <div className="flex items-baseline gap-1.5">
                <span className="font-mono text-2xl leading-none font-semibold tabular-nums">
                  {monitorDone}/{monitor.total}
                </span>
                <span className="text-xs text-muted-foreground">saved</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-slot="button"
                  className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50"
                  disabled={!canClearMonitor}
                  title={!canClearMonitor ? 'Downloads still active' : undefined}
                  onClick={() => void clearMonitor()}
                >
                  {!canClearMonitor ? 'Active' : clearFeedback ? 'Cleared' : 'Clear'}
                </button>
                <span className="font-mono text-base leading-none font-semibold tabular-nums text-primary">
                  {monitorPct}%
                </span>
              </div>
            </div>
            <Progress value={monitorPct} aria-label="Download progress" className="h-[3px]" />
            {metaLine !== '' && (
              <p className="font-mono text-xs leading-snug text-muted-foreground">{metaLine}</p>
            )}
          </section>
        )}

        <div className="grid gap-4">
          <div className={cn('grid gap-2', !onXTab && 'opacity-45')}>
            <button
              type="button"
              data-slot="button"
              className="h-11 w-full rounded-[var(--xmd-radius-2)] bg-primary text-sm font-semibold text-primary-foreground transition-colors active:scale-[0.97] hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
              disabled={!onXTab || drain.busy}
              onClick={() => void drain.run()}
            >
              {drain.busy
                ? 'Draining…'
                : willClear
                  ? 'Download + clear this page'
                  : 'Download this page'}
            </button>

            <div className="grid grid-cols-3 gap-1.5">
              <button
                type="button"
                data-slot="button"
                className="flex h-8 items-center justify-center gap-1 rounded-[var(--xmd-radius-3)] text-xs font-medium text-foreground/80 transition-colors active:scale-[0.97] hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
                disabled={!onXTab || sweep.busy}
                onClick={() => void sweep.run()}
              >
                <LayersIcon className="size-3.5" />
                {sweep.busy ? 'Sweeping…' : 'One by one'}
              </button>
              <button
                type="button"
                data-slot="button"
                className="flex h-8 items-center justify-center gap-1 rounded-[var(--xmd-radius-3)] text-xs font-medium text-foreground/80 transition-colors active:scale-[0.97] hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
                disabled={!onXTab || clearVisible.busy}
                onClick={() => void clearVisible.run()}
              >
                <EraserIcon className="size-3.5" />
                {clearVisible.busy ? 'Clearing…' : 'Clear page'}
              </button>
              <button
                type="button"
                data-slot="button"
                className="flex h-8 items-center justify-center gap-1 rounded-[var(--xmd-radius-3)] text-xs font-medium text-destructive transition-colors active:scale-[0.97] hover:bg-destructive/10 disabled:pointer-events-none disabled:opacity-50"
                disabled={!onListPage || clearWholeList.busy}
                title={!onListPage ? 'Open a Likes or Bookmarks list' : undefined}
                onClick={() => void clearWholeList.run()}
              >
                {clearWholeList.busy ? 'Clearing…' : 'Clear list…'}
              </button>
            </div>
            {actionMsg && <p className="text-xs leading-snug text-muted-foreground">{actionMsg}</p>}
          </div>

          {!onXTab && (
            <p className="text-xs leading-snug text-muted-foreground">
              Works on Likes, Bookmarks, and list pages
            </p>
          )}

          <div className="grid gap-4 border-t border-border pt-4">
            <div className="grid gap-1.5">
              <span className="text-[11px] font-semibold tracking-wide text-muted-foreground">
                Mode
              </span>
              <ToggleGroup
                type="single"
                variant="outline"
                spacing={0}
                className="w-full rounded-[var(--xmd-radius-3)]"
                aria-label="Download mode"
                value={settings.downloadStrategy}
                onValueChange={(value: string) => {
                  if (value)
                    void update({
                      downloadStrategy: value as Settings['downloadStrategy'],
                    })
                }}
              >
                {DOWNLOAD_MODES.map((option) => (
                  <ToggleGroupItem
                    key={option.value}
                    value={option.value}
                    aria-label={`Download mode: ${option.label}`}
                    title={option.hint}
                    className="h-8 flex-1 rounded-[var(--xmd-radius-4)] text-[13px]"
                  >
                    {option.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>

            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="clearOnSave">{CLEAR_AFTER_DOWNLOAD.label}</FieldLabel>
                {settings.clearOnSave ? (
                  <FieldDescription className="font-mono">
                    {clearScopeSummary(settings)} ·{' '}
                    <button
                      type="button"
                      data-slot="button"
                      className="font-sans text-primary transition-colors active:scale-[0.97] hover:underline"
                      onClick={openClearingSettings}
                    >
                      Edit ›
                    </button>
                  </FieldDescription>
                ) : (
                  <FieldDescription>{CLEAR_AFTER_DOWNLOAD.description}</FieldDescription>
                )}
              </FieldContent>
              <Switch
                id="clearOnSave"
                aria-label="Clear after download"
                checked={settings.clearOnSave}
                onCheckedChange={(checked: boolean) => void update({ clearOnSave: checked })}
              />
            </Field>

            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="captureEnabled">Capture tweets</FieldLabel>
                <FieldDescription className="flex items-center gap-1.5">
                  <span className="font-mono">{plural(captureSummary?.tweets ?? 0, 'tweet')}</span>
                  <button
                    type="button"
                    data-slot="button"
                    className="text-primary transition-colors active:scale-[0.97] hover:underline"
                    onClick={openCaptureArchive}
                  >
                    Archive ›
                  </button>
                </FieldDescription>
              </FieldContent>
              <Switch
                id="captureEnabled"
                aria-label="Capture tweets"
                checked={settings.captureEnabled}
                onCheckedChange={(checked: boolean) => void update({ captureEnabled: checked })}
              />
            </Field>

            <CaptureQuickActions
              summary={captureSummary}
              onCleared={() => setCaptureSummary({ tweets: 0, conversations: 0, recent: [] })}
            />
          </div>
        </div>
      </main>

      <footer className="flex items-center justify-between gap-2 border-t border-border px-3.5 py-3 text-xs leading-snug text-muted-foreground">
        <span>
          {settings.cloudSyncEnabled
            ? 'Cloud sync on · metadata only'
            : 'No remote telemetry · local only'}
        </span>
        <button
          type="button"
          data-slot="button"
          onClick={openOptions}
          className="font-semibold text-primary transition-colors active:scale-[0.97] hover:underline"
        >
          Settings
        </button>
      </footer>

      <div
        aria-live="polite"
        className={cn(
          'pointer-events-none fixed right-3 bottom-3 transition-all duration-200',
          saved ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0',
        )}
      >
        <span className="flex items-center gap-1.5 rounded-[var(--xmd-radius-3)] border border-border bg-background px-2.5 py-1 text-xs font-medium text-success">
          <CheckIcon className="size-3" />
          Saved
        </span>
      </div>
    </div>
  )
}
