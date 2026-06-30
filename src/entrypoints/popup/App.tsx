import { useEffect, useState } from 'preact/hooks'
import { Option } from 'effect'
import { getSettings, setSettings } from '@/core/settings'
import { DOWNLOAD_MODES } from '@/core/download/strategy'
import { CLEAR_AFTER_DOWNLOAD } from '@/core/clear/copy'
import { pageScope } from '@/core/clear/clearer'
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
import {
  fetchCaptureSummary,
  runCaptureExport,
  type CaptureExportKind,
  type CaptureSummary,
} from '@/components/capture-export'

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

export function App() {
  const [settings, setSettingsState] = useState<Settings | null>(null)
  const [saved, setSaved] = useState(false)
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null)
  const [history, setHistory] = useState<ReadonlyArray<DownloadRecord>>([])
  const [onXTab, setOnXTab] = useState(false)
  const [onListPage, setOnListPage] = useState(false)
  // One shared status line for the page actions, so the most recent action's
  // result always shows instead of an earlier action's stale message.
  const [actionMsg, setActionMsg] = useState<string | null>(null)
  const [clearFeedback, setClearFeedback] = useState(false)
  const [captureSummary, setCaptureSummary] = useState<CaptureSummary | null>(null)
  const [captureMsg, setCaptureMsg] = useState<string | null>(null)

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
    void fetchHistory().then(setHistory)
  }, [])

  useEffect(() => {
    void fetchCaptureSummary().then(setCaptureSummary)
  }, [])

  const exportHarvest = async (): Promise<void> => {
    const outcome = await runCaptureExport('jsonl')
    setCaptureMsg(outcome.detail)
    setTimeout(() => setCaptureMsg(null), 5000)
  }

  const exportConvo = async (kind: CaptureExportKind, conversationId: string): Promise<void> => {
    const outcome = await runCaptureExport(kind, conversationId)
    setCaptureMsg(outcome.detail)
    setTimeout(() => setCaptureMsg(null), 5000)
  }

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

  const clearLocalHistory = async (): Promise<void> => {
    if (!confirm('Delete the local download history? Files already saved to disk are untouched.'))
      return
    await browser.runtime.sendMessage({ _tag: 'ClearHistoryRequest' }).catch(() => {})
    setHistory([])
  }

  const clearLocalHarvest = async (): Promise<void> => {
    if (!confirm('Delete the entire harvested-tweet archive? This cannot be undone.')) return
    await browser.runtime.sendMessage({ _tag: 'ClearCaptureRequest' }).catch(() => {})
    setCaptureSummary({ tweets: 0, conversations: 0, recent: [] })
    setCaptureMsg(null)
  }

  // Only surface the monitor for a real download batch — not for stray hover/UI
  // trace events that also ride the metrics snapshot.
  const monitor = metrics && metrics.total > 0 ? metrics : null
  const monitorDone = monitor ? monitor.completed + monitor.failed : 0
  const monitorPct = monitor ? Math.min(100, Math.round((monitorDone / monitor.total) * 100)) : 0
  const canClearMonitor = monitor !== null && monitor.active === 0
  const recent = settings.downloadHistoryEnabled ? history.slice(0, 3) : []
  const harvested = captureSummary?.recent ?? []

  return (
    <div className="xmd-popup">
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
            onClick={openOptions}
          >
            <GearIcon className="size-4" />
          </Button>
        </div>
      </header>

      <main className="flex flex-col gap-2.5 px-3.5 py-3">
        {monitor && (
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
                    value={
                      monitor.etaSeconds === undefined ? '-' : `${Math.ceil(monitor.etaSeconds)}s`
                    }
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
        )}

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
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className="w-full gap-1.5"
              disabled={!onListPage || clearWholeList.busy}
              title={!onListPage ? 'Open a Likes or Bookmarks list' : undefined}
              onClick={() => void clearWholeList.run()}
            >
              <EraserIcon className="size-3.5" />
              {clearWholeList.busy ? 'Clearing entire list…' : 'Clear entire list (no download)'}
            </Button>
            {actionMsg && <p className="text-xs leading-snug text-muted-foreground">{actionMsg}</p>}
          </CardContent>
        </Card>

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
            {settings.clearOnSave && (
              <div className="grid gap-2">
                <span className="text-[11px] font-semibold tracking-wide text-muted-foreground">
                  CLEAR FROM
                </span>
                <ScopeToggle
                  id="autoUnbookmarkOnSave"
                  label="Bookmarks (un-bookmark)"
                  checked={settings.autoUnbookmarkOnSave}
                  onChange={(v) => void update({ autoUnbookmarkOnSave: v })}
                />
                <ScopeToggle
                  id="autoUnlikeOnSave"
                  label="Likes (un-like)"
                  checked={settings.autoUnlikeOnSave}
                  onChange={(v) => void update({ autoUnlikeOnSave: v })}
                />
                <ScopeToggle
                  id="autoNotInterestedOnSave"
                  label="For You (Not interested)"
                  checked={settings.autoNotInterestedOnSave}
                  onChange={(v) => void update({ autoNotInterestedOnSave: v })}
                />
              </div>
            )}
          </CardContent>
        </Card>

        <Card size="sm" aria-label="Knowledge Capture">
          <CardHeader className="gap-0.5">
            <CardTitle className="text-[13px] font-semibold">Knowledge Capture</CardTitle>
            <CardDescription className="text-xs leading-snug">
              {captureSummary?.tweets ?? 0} tweets · {captureSummary?.conversations ?? 0}{' '}
              conversations harvested locally
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2.5">
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="captureEnabled">Harvest tweets</FieldLabel>
                <FieldDescription>Save the text and metadata of tweets you view</FieldDescription>
              </FieldContent>
              <Switch
                id="captureEnabled"
                aria-label="Harvest tweets"
                checked={settings.captureEnabled}
                onCheckedChange={(checked: boolean) => void update({ captureEnabled: checked })}
              />
            </Field>

            {harvested.length > 0 && (
              <ol className="grid gap-1.5" aria-label="Harvested conversations">
                {harvested.map((c) => (
                  <li
                    key={c.conversationId}
                    className="flex items-center justify-between gap-2 text-xs"
                  >
                    <div className="grid min-w-0 gap-0.5">
                      <span className="truncate font-medium">@{c.rootHandle}</span>
                      <span className="truncate text-muted-foreground">{c.rootText}</span>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void exportConvo('tree', c.conversationId)}
                      >
                        Tree
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void exportConvo('markdown', c.conversationId)}
                      >
                        MD
                      </Button>
                    </div>
                  </li>
                ))}
              </ol>
            )}

            <Button
              type="button"
              variant="outline"
              className="h-9 w-full gap-2"
              disabled={(captureSummary?.tweets ?? 0) === 0}
              onClick={() => void exportHarvest()}
            >
              <DownloadIcon className="size-4" />
              Export all (JSONL)
            </Button>
            {captureMsg && (
              <p className="text-xs leading-snug text-muted-foreground">{captureMsg}</p>
            )}
          </CardContent>
        </Card>

        <Card size="sm" aria-label="Local data">
          <CardHeader className="gap-0.5">
            <CardTitle className="text-[13px] font-semibold">Local data</CardTitle>
            <CardDescription className="text-xs leading-snug">
              Wipe this extension’s stored data. Never deletes files on disk.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full gap-2"
              onClick={() => void clearLocalHistory()}
            >
              <EraserIcon className="size-4" />
              Clear download history
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full gap-2"
              onClick={() => void clearLocalHarvest()}
            >
              <EraserIcon className="size-4" />
              Clear harvest archive
            </Button>
          </CardContent>
        </Card>

        {recent.length > 0 && (
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
        )}
      </main>

      <footer className="flex items-center justify-between gap-2 border-t px-3.5 py-3 text-xs leading-snug text-muted-foreground">
        <span>
          {settings.cloudSyncEnabled
            ? 'Cloud sync on · metadata only'
            : 'No remote telemetry · local only'}
        </span>
        <button
          type="button"
          onClick={openOptions}
          className="font-semibold text-primary hover:underline"
        >
          Open settings
        </button>
      </footer>
    </div>
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

function ScopeToggle({
  id,
  label,
  checked,
  onChange,
}: {
  id: string
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
      </FieldContent>
      <Switch id={id} aria-label={label} checked={checked} onCheckedChange={onChange} />
    </Field>
  )
}
