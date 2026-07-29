import { useEffect, useRef, useState } from 'preact/hooks'
import { DOWNLOAD_MODES } from '@/core/download/strategy'
import { requestClearLog, type ClearLogOutcome } from '@/core/clear/log-client'
import { CLEAR_AFTER_DOWNLOAD } from '@/core/clear/copy'
import { platformForUrl } from '@/core/adapters/catalog'
import type { MembershipScope } from '@/core/clear/scope'
import type { Platform, Settings, SettingsUiPatch } from '@/core/schema'
import type { MetricsSnapshot } from '@/core/schema/download'
import { cn } from '@/lib/utils'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Progress } from '@/components/ui/progress'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { LayersIcon, CheckIcon } from '@/components/icons'
import { useSettingsEditor } from '@/components/use-settings-editor'
import { useAsyncAuthority } from '@/components/use-async-authority'
import { useFetchedStrategySelection } from '@/components/use-fetched-strategy-selection'
import type { CaptureSummaryResult } from '@/components/capture-export'
import { plural } from '@/components/capture-copy'
import { ConfirmStrip } from '@/components/confirm-strip'
import {
  TURN_ON_RELEASE_LABEL,
  turnOnReleaseConfirm,
  hoverGrabLine,
  wholePostLine,
  firstRunBody,
  modifierLabel,
  secondModifierLabel,
} from '@/components/action-copy'
import { tabContext, tabScope, isXContext, contextLabel, type TabContext } from './context'
import { recordOpen, markDone, shouldShowIntro, type FirstRunState } from './first-run'
import { CaptureQuickActions } from './capture-quick-actions'
import { ClearLogSection } from './clear-log-section'
import { makePopupActions, type PopupActionView, type PopupIntent } from './popup-actions'
import { useCaptureSummary } from './use-capture-summary'
import { useDownloadMonitor } from './use-download-monitor'

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

// [inline] — not in action-copy.ts's landed surface (Batch A shipped without
// an aria2-caveat builder); action-copy.ts is Batch A's file, out of this
// batch's scope to extend, so the literal lives here verbatim from spec §2.3.
const ARIA2_CAVEAT =
  'aria2 downloads are tracked, but cannot release posts because they have no Chrome download ID.'

const ROUTES: ReadonlyArray<{ url: string; label: string }> = [
  { url: 'https://x.com', label: 'x.com' },
  { url: 'https://instagram.com', label: 'instagram.com' },
  { url: 'https://threads.net', label: 'threads.net' },
]

const CLEAR_SCOPES: ReadonlyArray<{ key: keyof Settings; label: string }> = [
  { key: 'autoUnbookmarkOnSave', label: 'Bookmarks' },
  { key: 'autoUnlikeOnSave', label: 'Likes' },
  { key: 'autoNotInterestedOnSave', label: 'For You' },
]

const clearScopeSummary = (settings: Settings): string => {
  const active = CLEAR_SCOPES.filter((s) => settings[s.key]).map((s) => s.label)
  return active.length > 0 ? active.join(' · ') : 'No scopes selected'
}

// Invisible hit-slop for compact text-links (footer Settings, Edit ›,
// Archive ›) — matches the Switch idiom's after:-inset-y-3 (spec §2.8): 18px
// text + 24px slop ≈ 42px effective target.
const LINK_SLOP =
  'relative rounded-sm outline-none transition-colors after:absolute after:-inset-x-1 after:-inset-y-3 focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-[0.97]'

const openOptions = (): void => void browser.runtime.openOptionsPage()

const openOptionsSection = (hash: string): void =>
  void browser.tabs.create({
    url: `${browser.runtime.getURL('/options.html')}#${hash}`,
  })

// openOptionsPage can't carry a hash, so it always lands on Saving; the
// capture/release cards deep-link straight to their panel instead (the
// options app reads location.hash on mount to select the section).
const openCaptureArchive = (): void => openOptionsSection('capture')
const openReleaseSettings = (): void => openOptionsSection('release')

// ── Zone 1 — Context strip (§2.2, §2.3) ──

function ContextStrip({ ctx, scope }: { ctx: TabContext; scope: MembershipScope | undefined }) {
  return (
    <header className="sticky top-0 z-10 flex h-9 shrink-0 items-center gap-1.5 bg-background px-3.5 text-xs leading-snug text-muted-foreground shadow-[0_1px_0_0_var(--border)]">
      <span
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          ctx !== 'none' ? 'bg-success' : 'bg-muted-foreground/40',
        )}
      />
      <span className="truncate">{contextLabel(ctx, scope)}</span>
    </header>
  )
}

// ── Zone 1b — First-run teaching strip (§2.2, §2.3) ──

function FirstRunStrip({ mod, onDismiss }: { mod: string; onDismiss: () => void }) {
  return (
    <div className="animate-in fade-in slide-in-from-top-1 flex min-h-11 items-center gap-3 bg-muted/30 px-3.5 py-2 duration-[220ms] ease-[var(--xmd-ease)]">
      <p className="flex-1 text-pretty text-xs leading-snug text-muted-foreground">
        {firstRunBody(mod)}
      </p>
      <button
        type="button"
        data-slot="button"
        aria-label="Dismiss tip"
        className="flex size-10 shrink-0 items-center justify-center rounded-[var(--xmd-radius-3)] text-sm text-muted-foreground outline-none transition-colors hover:bg-muted active:scale-[0.97] focus-visible:ring-3 focus-visible:ring-ring/50"
        onClick={onDismiss}
      >
        ×
      </button>
    </div>
  )
}

// ── Zone 2 — Monitor (§2.3 "Monitor zone") ──

function MonitorZone({ metrics, onReset }: { metrics: MetricsSnapshot; onReset: () => void }) {
  const done = metrics.completed + metrics.failed
  const pct = Math.min(100, Math.round((done / metrics.total) * 100))
  const canReset = metrics.active === 0
  const metaLine = [
    metrics.throughputBps > 0 ? fmtRate(metrics.throughputBps) : null,
    metrics.etaSeconds !== undefined ? `${Math.ceil(metrics.etaSeconds)}s left` : null,
    metrics.bytesTotal > 0
      ? `${fmtBytes(metrics.bytesReceived)} / ${fmtBytes(metrics.bytesTotal)}`
      : null,
    metrics.failed > 0 ? plural(metrics.failed, 'failed') : null,
    metrics.retries > 0 ? plural(metrics.retries, 'retry') : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ')

  return (
    <section
      aria-label="Download monitor"
      className="animate-in fade-in slide-in-from-top-1 grid gap-2 border-t border-border px-3.5 py-4 duration-[220ms] ease-[var(--xmd-ease)]"
    >
      <div className="flex items-end justify-between gap-3">
        <div className="flex items-baseline gap-1.5">
          <span className="font-mono text-2xl leading-none font-semibold tabular-nums">
            {done}/{metrics.total}
          </span>
          <span className="text-xs text-muted-foreground">saved</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-slot="button"
            className="flex min-h-10 items-center rounded-[var(--xmd-radius-3)] px-2 -my-3 text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground active:scale-[0.97] focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
            disabled={!canReset}
            title={!canReset ? 'Downloads still active' : undefined}
            onClick={onReset}
          >
            {!canReset ? 'Active' : 'Reset'}
          </button>
          <span className="font-mono text-base leading-none font-semibold tabular-nums text-primary">
            {pct}%
          </span>
        </div>
      </div>
      <Progress value={pct} aria-label="Download progress" className="h-[3px]" />
      {metaLine !== '' && (
        <p className="font-mono text-xs leading-snug tabular-nums text-muted-foreground">
          {metaLine}
        </p>
      )}
    </section>
  )
}

// ── Zone 3 — Stage (§2.2, §2.3) ──

function StageZone({
  ctx,
  onXTab,
  downloadWillClear,
  sweepWillClear,
  aria2Caveat,
  active,
  onDrain,
  onSweep,
  downloadMsg,
  mod,
  mod2,
}: {
  ctx: TabContext
  onXTab: boolean
  downloadWillClear: boolean
  sweepWillClear: boolean
  aria2Caveat: boolean
  active: PopupActionView['active']
  onDrain: () => void
  onSweep: () => void
  downloadMsg: string | null
  mod: string
  mod2: string
}) {
  if (ctx === 'x' || ctx === 'x-list') {
    return (
      <section aria-label="Stage" className="grid gap-2 border-t border-border px-3.5 py-4">
        <button
          type="button"
          data-slot="button"
          className="h-11 w-full rounded-[var(--xmd-radius-2)] bg-primary text-sm font-semibold text-primary-foreground outline-none transition-colors hover:bg-primary/90 active:scale-[0.97] focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
          disabled={!onXTab || active !== null}
          onClick={onDrain}
        >
          {active === 'download-page'
            ? 'Queuing…'
            : downloadWillClear
              ? 'Download + release this page'
              : 'Download this page'}
        </button>

        <button
          type="button"
          data-slot="button"
          className="flex h-10 w-full items-center justify-center gap-1.5 rounded-[var(--xmd-radius-3)] text-xs font-medium text-foreground/80 outline-none transition-colors hover:bg-muted active:scale-[0.97] focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
          disabled={!onXTab || active !== null}
          onClick={onSweep}
        >
          <LayersIcon className="size-3.5" />
          {active === 'sweep-list' ? 'Sweeping…' : 'One by one'}
        </button>

        {(downloadWillClear || sweepWillClear) && (
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="size-1.5 shrink-0 rounded-full bg-destructive" />
            Release after download is on
          </p>
        )}
        {aria2Caveat && (
          <p className="text-pretty text-[11px] text-muted-foreground">{ARIA2_CAVEAT}</p>
        )}

        {downloadMsg && (
          <p aria-live="polite" className="text-pretty text-xs leading-snug text-muted-foreground">
            {downloadMsg}
          </p>
        )}
      </section>
    )
  }

  if (ctx === 'instagram' || ctx === 'threads') {
    return (
      <section aria-label="Stage" className="grid gap-1.5 border-t border-border px-3.5 py-4">
        <p className="text-pretty text-[13px]">{hoverGrabLine(mod)}</p>
        <p className="text-pretty text-[13px]">{wholePostLine(mod, mod2)}</p>
      </section>
    )
  }

  return (
    <section aria-label="Stage" className="grid gap-3 border-t border-border px-3.5 py-4">
      <p className="text-balance text-[13px] font-medium">
        Open X, Instagram, or Threads to use this extension.
      </p>
      <div className="grid">
        {ROUTES.map((r) => (
          <button
            key={r.url}
            type="button"
            data-slot="button"
            className="flex min-h-10 items-center justify-between rounded-[var(--xmd-radius-3)] px-1 text-[13px] font-medium text-foreground/80 outline-none transition-colors hover:bg-muted active:scale-[0.97] focus-visible:ring-3 focus-visible:ring-ring/50"
            onClick={() => void browser.tabs.create({ url: r.url })}
          >
            {r.label}
            <span aria-hidden="true">›</span>
          </button>
        ))}
      </div>
    </section>
  )
}

// ── Zone 4 — Preferences (§2.2, §2.3) — global, rows suppressed per platform ──

function PreferencesZone({
  ctx,
  settings,
  update,
  onSelectDownloadStrategy,
  fetchedNotice,
  captureSummary,
}: {
  ctx: TabContext
  settings: Settings
  update: (patch: SettingsUiPatch) => Promise<void>
  onSelectDownloadStrategy: (value: Settings['downloadStrategy']) => void
  fetchedNotice: string | null
  captureSummary: CaptureSummaryResult | null
}) {
  const isMetaContext = ctx === 'instagram' || ctx === 'threads'
  const summary = captureSummary?.status === 'available' ? captureSummary.summary : null
  const tweets = summary?.tweets ?? 0

  return (
    <section className="grid gap-4 border-t border-border px-3.5 py-4">
      <div className="grid gap-1.5">
        <span className="text-[11px] font-semibold tracking-wide text-muted-foreground">Mode</span>
        <ToggleGroup
          type="single"
          variant="outline"
          spacing={0}
          className="w-full rounded-[var(--xmd-radius-3)]"
          style={{ '--radius': 'var(--xmd-radius-3)' }}
          aria-label="Download mode"
          value={settings.downloadStrategy}
          onValueChange={(value: string) => {
            if (value) onSelectDownloadStrategy(value as Settings['downloadStrategy'])
          }}
        >
          {DOWNLOAD_MODES.map((option) => (
            <ToggleGroupItem
              key={option.value}
              value={option.value}
              aria-label={`Download mode: ${option.label}`}
              title={option.hint}
              className="h-10 flex-1 text-[13px]"
            >
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {fetchedNotice && (
          <p aria-live="polite" className="text-xs leading-snug text-muted-foreground">
            {fetchedNotice}
          </p>
        )}
      </div>

      {isMetaContext ? (
        <p className="text-xs leading-snug text-muted-foreground">
          Release and Capture are X-only.
        </p>
      ) : (
        <>
          <ConfirmStrip
            sentence={turnOnReleaseConfirm}
            confirmLabel={TURN_ON_RELEASE_LABEL}
            kind="pre-committed"
            onConfirm={() => void update({ clearOnSave: true })}
          >
            {(arm) => (
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor="clearOnSave">{CLEAR_AFTER_DOWNLOAD.label}</FieldLabel>
                  {settings.clearOnSave ? (
                    <FieldDescription className="font-mono">
                      {clearScopeSummary(settings)} ·{' '}
                      <button
                        type="button"
                        data-slot="button"
                        className={cn('font-sans text-primary hover:underline', LINK_SLOP)}
                        onClick={openReleaseSettings}
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
                  aria-label="Release after download"
                  checked={settings.clearOnSave}
                  onCheckedChange={(checked: boolean) => {
                    if (checked) arm()
                    else void update({ clearOnSave: false })
                  }}
                />
              </Field>
            )}
          </ConfirmStrip>

          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="captureEnabled">Capture tweets</FieldLabel>
              <FieldDescription className="flex items-center gap-1.5">
                {!settings.captureEnabled ? (
                  'Off — captures tweet text locally as you scroll.'
                ) : captureSummary === null ? (
                  'Loading archive…'
                ) : captureSummary.status === 'unavailable' ? (
                  'Archive unavailable.'
                ) : tweets > 0 ? (
                  <>
                    <span className="font-mono tabular-nums">{plural(tweets, 'tweet')}</span>
                    <button
                      type="button"
                      data-slot="button"
                      className={cn('text-primary hover:underline', LINK_SLOP)}
                      onClick={openCaptureArchive}
                    >
                      Archive ›
                    </button>
                  </>
                ) : (
                  'Capturing — nothing saved yet'
                )}
              </FieldDescription>
            </FieldContent>
            <Switch
              id="captureEnabled"
              aria-label="Capture tweets"
              checked={settings.captureEnabled}
              onCheckedChange={(checked: boolean) => void update({ captureEnabled: checked })}
            />
          </Field>
        </>
      )}
    </section>
  )
}

// ── Zone 7 — Footer (§2.3, unchanged) ──

function Footer({
  cloudSyncEnabled,
  onOpenOptions,
}: {
  cloudSyncEnabled: boolean
  onOpenOptions: () => void
}) {
  return (
    <footer className="flex items-center justify-between gap-2 border-t border-border px-3.5 py-3 text-xs leading-snug text-muted-foreground">
      <span>
        {cloudSyncEnabled ? 'Cloud sync on · metadata only' : 'No remote telemetry · local only'}
      </span>
      <button
        type="button"
        data-slot="button"
        onClick={onOpenOptions}
        className={cn('font-semibold text-primary hover:underline', LINK_SLOP)}
      >
        Settings
      </button>
    </footer>
  )
}

export function App() {
  const [fetchedNotice, setFetchedNotice] = useState<string | null>(null)
  const { load, notice: saveNotice, update, reload } = useSettingsEditor({ successMs: 1200 })
  const settings = load.settings
  const selectDownloadStrategy = useFetchedStrategySelection(update, setFetchedNotice)
  const mounted = useRef(true)
  const tabAuthority = useAsyncAuthority()
  const { metrics, reset: resetMonitor } = useDownloadMonitor()
  const [tabPlatform, setTabPlatform] = useState<Platform | undefined>(undefined)
  const [ctx, setCtx] = useState<TabContext>('none')
  const [scope, setScope] = useState<MembershipScope | undefined>(undefined)
  const { result: captureSummary, clear: clearCaptureSummary } = useCaptureSummary()
  const [clearLog, setClearLog] = useState<ClearLogOutcome | null>(null)
  const [introState, setIntroState] = useState<FirstRunState | null>(null)
  const actionsRef = useRef<ReturnType<typeof makePopupActions> | null>(null)
  if (actionsRef.current === null) {
    actionsRef.current = makePopupActions({
      tabs: browser.tabs,
      clock: {
        now: () => Date.now(),
        after: (ms, task) => {
          const timer = setTimeout(task, ms)
          return () => clearTimeout(timer)
        },
      },
      tabContext,
      markDone: async () => {
        const state = await markDone()
        if (mounted.current) setIntroState(state)
      },
    })
  }
  const actions = actionsRef.current
  const [actionView, setActionView] = useState<PopupActionView>(() => actions.inspect())

  // Release needs a verified Chrome download ID; aria2 media has none.
  const clearCapable =
    settings !== null && settings.clearOnSave && settings.downloadStrategy !== 'aria2'
  const downloadWillClear =
    settings !== null &&
    clearCapable &&
    (scope === 'bookmark'
      ? settings.autoUnbookmarkOnSave
      : scope === 'like'
        ? settings.autoUnlikeOnSave
        : settings.autoUnbookmarkOnSave ||
          settings.autoUnlikeOnSave ||
          settings.autoNotInterestedOnSave)
  // Sweep owns its explicit list scope. Per-scope automatic toggles do not revoke it.
  const sweepWillClear = clearCapable && scope !== undefined
  const aria2Caveat = settings?.clearOnSave === true && settings.downloadStrategy === 'aria2'

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    const unsubscribe = actions.subscribe(() => setActionView(actions.inspect()))
    return () => {
      unsubscribe()
      actions.dispose()
    }
  }, [actions])

  useEffect(() => {
    const epoch = tabAuthority.begin()
    void (async () => {
      try {
        const tabs = await browser.tabs.query({
          active: true,
          currentWindow: true,
        })
        if (!tabAuthority.isCurrent(epoch)) return
        const tab = tabs[0]
        if (!tab) return
        const url = tab.url ?? ''
        setTabPlatform(platformForUrl(url))
        // Recomputes the list-page check from the adapter/platform field
        // directly (ADR-0019's safety property — never an X-specific URL
        // matcher), independently of the tabPlatform assignment above; the
        // catalog-backed derivation itself is unit-tested by context.test.ts.
        setCtx(tabContext(url))
        setScope(tabScope(url))
      } catch {
        /* permission unavailable; the action stays disabled */
      }
    })()
  }, [tabAuthority])

  useEffect(() => {
    let cancelled = false
    void requestClearLog((request) => browser.runtime.sendMessage(request)).then((log) => {
      if (!cancelled && mounted.current) setClearLog(log)
      return undefined
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const state = await recordOpen()
        if (!cancelled && mounted.current) setIntroState(state)
      } catch {
        // Onboarding state cannot block the popup.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (settings === null) {
    return (
      <div className="xmd-popup xmd-popup--loading">
        {load.status === 'unavailable' ? (
          <>
            <p>Settings unavailable.</p>
            <button
              type="button"
              className="text-primary hover:underline"
              onClick={() => void reload()}
            >
              Retry
            </button>
          </>
        ) : (
          'Loading...'
        )}
      </div>
    )
  }

  const onXTab = tabPlatform === 'x'
  const isMetaContext = ctx === 'instagram' || ctx === 'threads'

  const dismissFirstRun = (): void =>
    void markDone()
      .then((state) => {
        if (mounted.current) setIntroState(state)
        return undefined
      })
      .catch(() => undefined)

  const runAction = (intent: PopupIntent): void => void actions.run(intent)

  // Only surface the monitor for a real download batch — not for stray hover/UI
  // trace events that also ride the metrics snapshot.
  const monitor = metrics && metrics.total > 0 ? metrics : null

  const showFirstRun = introState !== null && isXContext(ctx) && shouldShowIntro(introState)
  const mod = modifierLabel(settings.quickGrabModifier)
  const mod2 = secondModifierLabel(settings.quickGrabModifier)

  return (
    <div className="xmd-popup">
      <ContextStrip ctx={ctx} scope={scope} />

      {showFirstRun && <FirstRunStrip mod={mod} onDismiss={dismissFirstRun} />}

      {monitor && <MonitorZone metrics={monitor} onReset={() => void resetMonitor()} />}

      <StageZone
        ctx={ctx}
        onXTab={onXTab}
        downloadWillClear={downloadWillClear}
        sweepWillClear={sweepWillClear}
        aria2Caveat={aria2Caveat}
        active={actionView.active}
        onDrain={() => runAction({ kind: 'download-page', releaseAfter: downloadWillClear })}
        onSweep={() => runAction({ kind: 'sweep-list', releaseAfter: sweepWillClear })}
        downloadMsg={actionView.notices.download?.text ?? null}
        mod={mod}
        mod2={mod2}
      />

      <PreferencesZone
        ctx={ctx}
        settings={settings}
        update={update}
        onSelectDownloadStrategy={selectDownloadStrategy}
        fetchedNotice={fetchedNotice}
        captureSummary={captureSummary}
      />

      {!isMetaContext && (
        <CaptureQuickActions summary={captureSummary} onCleared={clearCaptureSummary} />
      )}

      <ClearLogSection log={clearLog} />

      <Footer cloudSyncEnabled={settings.cloudSyncEnabled} onOpenOptions={openOptions} />

      <div
        aria-live="polite"
        className={cn(
          'pointer-events-none fixed right-3 bottom-3 transition-[opacity,transform] ease-[var(--xmd-ease)]',
          saveNotice !== 'idle'
            ? 'translate-y-0 opacity-100 duration-200'
            : 'translate-y-1 opacity-0 duration-150',
        )}
      >
        <span
          className={cn(
            'flex items-center gap-1.5 rounded-[var(--xmd-radius-3)] border border-border bg-background px-2.5 py-1 text-xs font-medium',
            saveNotice === 'saved' ? 'text-success' : 'text-destructive',
          )}
        >
          {saveNotice === 'saved' ? <CheckIcon className="size-3" /> : null}
          {saveNotice === 'saved' ? 'Saved' : 'Save failed'}
        </span>
      </div>
    </div>
  )
}
