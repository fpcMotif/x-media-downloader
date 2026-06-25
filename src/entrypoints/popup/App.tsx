import { useEffect, useState } from 'preact/hooks'
import { getSettings, setSettings } from '@/core/settings'
import { DOWNLOAD_MODES } from '@/core/download/strategy'
import { CLEAR_AFTER_DOWNLOAD } from '@/core/clear/copy'
import { isXUrl } from '@/core/adapters/x'
import type { MetricsSnapshot, Settings } from '@/core/schema'
import type { DownloadRecord } from '@/core/history/record'
import { fetchHistory, formatRecord } from './history-section'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Progress } from '@/components/ui/progress'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { DownloadIcon, EraserIcon, GearIcon, LayersIcon } from '@/components/icons'

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

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`

// Poll the download monitor briskly while a batch is live, but back off when
// idle — the snapshot is only surfaced when total > 0, so a 1s round-trip to
// the SW every second is wasted work for an open popup with no batch running.
const POLL_ACTIVE_MS = 1000
const POLL_IDLE_MS = 3000

const PAGE_UNREACHABLE = 'Could not reach the page — reload the X tab and try again.'

/** A worklist button that messages the active tab's content script and turns the
 *  reply into a status line. Owns its own busy/message state and the shared
 *  confirm → query-tab → send → format → error skeleton; each caller supplies
 *  only the optional confirm copy, the message tag, and a result→string mapper. */
function usePageAction<R>(config: {
  /** Confirm prompt to show before running; omit (undefined) to skip the gate. */
  confirm?: string | undefined
  request: { _tag: string }
  format: (res: R | null) => string
}): { busy: boolean; msg: string | null; run: () => Promise<void> } {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const run = async (): Promise<void> => {
    if (config.confirm !== undefined && !confirm(config.confirm)) return
    setBusy(true)
    setMsg(null)
    try {
      const [tab] = await browser.tabs.query({
        active: true,
        currentWindow: true,
      })
      if (tab?.id === undefined) {
        setMsg('No active tab.')
        return
      }
      const res = (await browser.tabs.sendMessage(tab.id, config.request)) as R | null
      setMsg(config.format(res))
    } catch {
      setMsg(PAGE_UNREACHABLE)
    } finally {
      setBusy(false)
    }
  }

  return { busy, msg, run }
}

const openOptions = (): void => void browser.runtime.openOptionsPage()

export function App() {
  const [settings, setSettingsState] = useState<Settings | null>(null)
  const [saved, setSaved] = useState(false)
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null)
  const [history, setHistory] = useState<ReadonlyArray<DownloadRecord>>([])
  const [onXTab, setOnXTab] = useState(false)
  const [clearFeedback, setClearFeedback] = useState(false)

  // Whether a worklist action will ALSO clear: "Clear after download" is on AND
  // the strategy is byte-verifiable (aria2 hand-offs are excluded). Drives the
  // button labels, copy, and the confirm() gating — when off, the actions just
  // download. Computed before the loading early-return so the action hooks below
  // (which must run unconditionally) can close over it.
  const willClear =
    settings !== null && settings.clearOnSave && settings.downloadStrategy !== 'aria2'
  const noClearHint = settings?.clearOnSave
    ? 'aria2 hand-offs can’t be verified — posts download but aren’t removed (use Direct or Fetched to clear).'
    : 'Turn on “Clear after download” in Settings to also remove each from this list.'

  // Manual one-shot clear: un-bookmark / un-like every post currently on the X
  // page, via the content script (the same click path that works by hand).
  // Page-scoped: the content script derives bookmark-vs-like from the list URL
  // itself, so this carries no scope payload (the per-scope toggles live in
  // Settings and govern the download-driven clear, not this manual button).
  const clearVisible = usePageAction<{ cleared?: number }>({
    confirm: 'Un-like / un-bookmark every post currently on this page? This cannot be undone.',
    request: { _tag: 'ClearVisibleRequest' },
    format: (res) => `Cleared ${plural(res?.cleared ?? 0, 'post')} on this page.`,
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
        setOnXTab(isXUrl(tab.url ?? ''))
      } catch {
        /* permission unavailable; the action stays disabled */
      }
    })()
  }, [])

  useEffect(() => {
    void fetchHistory().then(setHistory)
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

  const activeMode = DOWNLOAD_MODES.find((m) => m.value === settings.downloadStrategy)
  // Surface which surfaces the clear actually touches — the per-scope toggles
  // live in Settings, so enabling clear-on-save from the popup would otherwise
  // commit to hidden sub-settings silently. aria2 never clears (the action copy
  // already says so), so skip the note there.
  const clearSurfaces = [
    settings.autoUnbookmarkOnSave && 'Bookmarks',
    settings.autoUnlikeOnSave && 'Likes',
    settings.autoNotInterestedOnSave && 'the For You feed',
  ].filter((s): s is string => s !== false)
  const clearScopeNote = !willClear
    ? null
    : clearSurfaces.length === 0
      ? 'No surface selected in Settings — nothing will be removed.'
      : `Removes saved posts from ${
          clearSurfaces.length === 1
            ? clearSurfaces[0]
            : `${clearSurfaces.slice(0, -1).join(', ')} and ${clearSurfaces.at(-1)}`
        }.`

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
  const canClearMonitor = monitor !== null && monitor.active === 0
  const recent = settings.downloadHistoryEnabled ? history.slice(0, 3) : []

  return (
    <div className="xmd-popup">
      <Header onXTab={onXTab} saved={saved} onOpenOptions={openOptions} />

      <main className="flex flex-col gap-2.5 px-3.5 py-3">
        {monitor && (
          <DownloadMonitor
            monitor={monitor}
            canClearMonitor={canClearMonitor}
            clearFeedback={clearFeedback}
            clearMonitor={clearMonitor}
          />
        )}

        <PageActions
          onXTab={onXTab}
          drain={drain}
          sweep={sweep}
          clearVisible={clearVisible}
          willClear={willClear}
        />

        <ModeSettings
          settings={settings}
          update={update}
          activeMode={activeMode}
          clearScopeNote={clearScopeNote}
          onOpenOptions={openOptions}
        />

        <RecentDownloads recent={recent} />
      </main>

      <Footer cloudSyncEnabled={settings.cloudSyncEnabled} onOpenOptions={openOptions} />
    </div>
  )
}

function Header({
  onXTab,
  saved,
  onOpenOptions,
}: {
  onXTab: boolean
  saved: boolean
  onOpenOptions: () => void
}) {
  return (
    <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b bg-background/70 px-3.5 py-3 backdrop-blur-xl">
      <div className="min-w-0">
        <span className="block text-[15px] leading-tight font-bold tracking-tight text-balance">
          X Media Downloader
        </span>
        <p className="mt-0.5 flex items-center gap-1.5 text-xs leading-snug text-muted-foreground">
          <span
            className={cn(
              'size-1.5 rounded-full',
              onXTab ? 'bg-success' : 'bg-muted-foreground/40',
            )}
          />
          {onXTab ? 'Ready on this X tab' : 'Open X or Twitter to scan media'}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {saved && <Badge variant="success">Saved</Badge>}
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label="Open settings"
          title="Settings"
          onClick={onOpenOptions}
        >
          <GearIcon className="size-4" />
        </Button>
      </div>
    </header>
  )
}

function DownloadMonitor({
  monitor,
  canClearMonitor,
  clearFeedback,
  clearMonitor,
}: {
  monitor: MetricsSnapshot
  canClearMonitor: boolean
  clearFeedback: boolean
  clearMonitor: () => void
}) {
  const monitorDone = monitor.completed + monitor.failed
  const monitorPct = Math.min(100, Math.round((monitorDone / monitor.total) * 100))

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="h-9 w-full"
        disabled={!canClearMonitor}
        title={!canClearMonitor ? 'Downloads still active' : undefined}
        onClick={() => void clearMonitor()}
      >
        {!canClearMonitor
          ? 'Active — downloads running'
          : clearFeedback
            ? 'Monitor cleared'
            : 'Clear monitor'}
      </Button>

      <Card size="sm" aria-label="Download monitor">
        <CardHeader className="gap-0.5">
          <div className="flex items-start justify-between gap-3">
            <div className="grid min-w-0 gap-0.5">
              <CardDescription className="text-[11px] font-semibold text-muted-foreground">
                Download monitor
              </CardDescription>
              <CardTitle className="text-sm">
                {monitorDone}/{monitor.total} done
              </CardTitle>
            </div>
            <span className="text-[15px] leading-none font-bold tabular-nums text-primary">
              {monitorPct}%
            </span>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Progress value={monitorPct} aria-label="Download progress" className="h-1.5" />
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
            <Stat label="Active" value={`${monitor.active}/${monitor.concurrencyCap}`} />
            <Stat label="Speed" value={fmtRate(monitor.throughputBps)} />
            <Stat label="Elapsed" value={fmtDuration(monitor.elapsedMs)} />
            <Stat
              label="ETA"
              value={monitor.etaSeconds === undefined ? '-' : `${Math.ceil(monitor.etaSeconds)}s`}
            />
            <Stat
              label="Bytes"
              value={
                monitor.bytesTotal > 0
                  ? `${fmtBytes(monitor.bytesReceived)} / ${fmtBytes(monitor.bytesTotal)}`
                  : fmtBytes(monitor.bytesReceived)
              }
            />
            {monitor.failed > 0 && <Stat label="Failed" value={String(monitor.failed)} />}
            {monitor.retries > 0 && <Stat label="Retries" value={String(monitor.retries)} />}
          </dl>
        </CardContent>
      </Card>
    </>
  )
}

function PageActions({
  onXTab,
  drain,
  sweep,
  clearVisible,
  willClear,
}: {
  onXTab: boolean
  drain: { busy: boolean; msg: string | null; run: () => Promise<void> }
  sweep: { busy: boolean; msg: string | null; run: () => Promise<void> }
  clearVisible: { busy: boolean; msg: string | null; run: () => Promise<void> }
  willClear: boolean
}) {
  return (
    <Card size="sm" aria-label="On this page">
      <CardHeader className="gap-0.5">
        <CardTitle className="text-[13px] font-semibold">On this page</CardTitle>
        <CardDescription className="text-xs leading-snug">
          {onXTab
            ? 'Grab the Likes or Bookmarks list you’re viewing.'
            : 'Open an X/Twitter Likes or Bookmarks tab to use these.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2.5">
        <Button
          type="button"
          className="h-11 w-full gap-2"
          disabled={!onXTab || drain.busy}
          onClick={() => void drain.run()}
        >
          <DownloadIcon className="size-[18px]" />
          {drain.busy
            ? 'Draining…'
            : willClear
              ? 'Download + clear this page'
              : 'Download this page'}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-10 w-full gap-2"
          disabled={!onXTab || sweep.busy}
          onClick={() => void sweep.run()}
        >
          <LayersIcon className="size-4" />
          {sweep.busy
            ? 'Sweeping…'
            : willClear
              ? 'Download + clear, one by one'
              : 'Download one by one'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full gap-1.5 text-muted-foreground"
          disabled={!onXTab || clearVisible.busy}
          onClick={() => void clearVisible.run()}
        >
          <EraserIcon className="size-3.5" />
          {clearVisible.busy ? 'Clearing…' : 'Clear this page now (no download)'}
        </Button>
        {(drain.msg || sweep.msg || clearVisible.msg) && (
          <p className="text-xs leading-snug text-muted-foreground">
            {drain.msg ?? sweep.msg ?? clearVisible.msg}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function ModeSettings({
  settings,
  update,
  activeMode,
  clearScopeNote,
  onOpenOptions,
}: {
  settings: Settings
  update: (patch: Partial<Settings>) => Promise<void>
  activeMode: { label: string; value: string; hint: string } | undefined
  clearScopeNote: string | null
  onOpenOptions: () => void
}) {
  return (
    <Card size="sm" aria-label="What the actions above do">
      <CardContent className="flex flex-col gap-3 pt-3">
        <p className="text-[11px] leading-snug text-muted-foreground">
          These set what the buttons above do — they don’t download on their own.
        </p>
        <div className="grid gap-1.5">
          <span className="text-[11px] font-semibold tracking-wide text-muted-foreground">
            DOWNLOAD MODE
          </span>
          <ToggleGroup
            type="single"
            variant="outline"
            spacing={0}
            className="w-full"
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
                className="h-9 flex-1 text-[13px]"
              >
                {option.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {activeMode && (
            <p className="text-[11px] leading-snug text-muted-foreground">{activeMode.hint}</p>
          )}
        </div>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="clearOnSave">{CLEAR_AFTER_DOWNLOAD.label}</FieldLabel>
            <FieldDescription>{CLEAR_AFTER_DOWNLOAD.description}</FieldDescription>
          </FieldContent>
          <Switch
            id="clearOnSave"
            aria-label="Clear after download"
            checked={settings.clearOnSave}
            onCheckedChange={(checked: boolean) => void update({ clearOnSave: checked })}
          />
        </Field>
        {clearScopeNote && (
          <p className="text-[11px] leading-snug text-muted-foreground">
            {clearScopeNote}{' '}
            <button
              type="button"
              onClick={onOpenOptions}
              className="font-medium text-primary hover:underline"
            >
              Manage in settings
            </button>
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function RecentDownloads({ recent }: { recent: ReadonlyArray<DownloadRecord> }) {
  if (recent.length === 0) return null

  return (
    <Card size="sm" aria-label="Recent downloads">
      <CardHeader className="gap-0.5">
        <CardTitle className="text-[13px] font-semibold">Recent</CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="grid gap-1.5" aria-label="Recent downloads">
          {recent.map((r) => {
            const f = formatRecord(r)
            const variant =
              f.status === 'completed'
                ? 'success'
                : f.status === 'failed'
                  ? 'destructive'
                  : 'outline'
            return (
              <li key={r.requestId} className="flex items-center gap-2 text-xs">
                <Badge variant={variant} className="shrink-0 capitalize">
                  {f.status}
                </Badge>
                <a
                  className="truncate text-muted-foreground hover:text-foreground"
                  href={f.link}
                  target="_blank"
                  rel="noreferrer"
                >
                  {f.title}
                </a>
              </li>
            )
          })}
        </ol>
      </CardContent>
    </Card>
  )
}

function Footer({
  cloudSyncEnabled,
  onOpenOptions,
}: {
  cloudSyncEnabled: boolean
  onOpenOptions: () => void
}) {
  return (
    <footer className="flex items-center justify-between gap-2 border-t px-3.5 py-3 text-xs leading-snug text-muted-foreground">
      <span>
        {cloudSyncEnabled ? 'Cloud sync on · metadata only' : 'No remote telemetry · local only'}
      </span>
      <button
        type="button"
        onClick={onOpenOptions}
        className="font-semibold text-primary hover:underline"
      >
        Open settings
      </button>
    </footer>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  )
}
