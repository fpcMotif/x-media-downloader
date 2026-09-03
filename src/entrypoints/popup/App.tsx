import { useEffect, useRef, useState } from 'preact/hooks'
import { getSettings, setSettings } from '@/packages/settings'
import { DOWNLOAD_MODES } from '@/packages/download/strategy'
import { CLEAR_AFTER_DOWNLOAD } from '@/packages/clear/copy'
import { adapterForUrl } from '@/core/adapters/registry'
import type { PlatformAdapter } from '@/core/adapters/types'
import type { MembershipScope } from '@/packages/clear/clearer'
import { formatReleaseSummaryLine } from '@/packages/clear/correlate'
import type { MetricsSnapshot, Settings } from '@/packages/schema'
import { cn } from '@/lib/utils'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Progress } from '@/components/ui/progress'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { LayersIcon, CheckIcon } from '@/components/icons'
import { fetchCaptureSummary, type CaptureSummary } from '@/components/capture-export'
import { plural } from '@/components/capture-copy'
import { ConfirmStrip } from '@/components/confirm-strip'
import {
  RELEASE_WORD,
  RELEASE_PAGE_CONFIRM_LABEL,
  RELEASE_LIST_CONFIRM_LABEL,
  TURN_ON_RELEASE_LABEL,
  releasePageConfirm,
  releaseListConfirm,
  releasedPageResult,
  releasedListResult,
  turnOnReleaseConfirm,
  drainResult,
  type DrainResult,
  sweepResult,
  hoverGrabLine,
  wholePostLine,
  firstRunBody,
  modifierLabel,
  secondModifierLabel,
  PAGE_UNREACHABLE,
  NO_ACTIVE_TAB,
  isPersistentStatus,
} from '@/components/action-copy'
import { tabContext, tabScope, isXContext, contextLabel, type TabContext } from './context'
import { planClearSeed } from '@/packages/clear/seed'
import type { Scope } from '@/packages/clear/ledger'
import { recordOpen, markDone, shouldShowIntro, type FirstRunState } from './first-run'
import { CaptureQuickActions } from './capture-quick-actions'

const KB = 1000
const MB = 1_000_000

function fmtRate(bps: number): string {
  if (bps <= 0) return '-'
  if (bps >= MB) return `${(bps / MB).toFixed(1)} MB/s`
  return `${Math.round(bps / KB)} KB/s`
}

function fmtBytes(bytes: number): string {
  if (bytes <= 0) return '-'
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`
  if (bytes >= KB) return `${Math.round(bytes / KB)} KB`
  return `${bytes} B`
}

// Poll the download monitor briskly while a batch is live, but back off when
// idle — the snapshot is only surfaced when total > 0, so a 1s round-trip to
// the SW every second is wasted work for an open popup with no batch running.
const POLL_ACTIVE_MS = 1000
const POLL_IDLE_MS = 3000

// [inline] — not in action-copy.ts's landed surface (Batch A shipped without
// an aria2-caveat builder); action-copy.ts is Batch A's file, out of this
// batch's scope to extend, so the literal lives here verbatim from spec §2.3.
const ARIA2_CAVEAT =
  "aria2 hand-offs can't be verified — posts download but aren't released (use Direct or Fetched)."

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

/** Whether `value` is one of `DOWNLOAD_MODES`' own values — reuses that array (the
 *  single source of truth for the strategy vocabulary) instead of asserting. */
const isDownloadStrategy = (value: string): value is Settings['downloadStrategy'] =>
  DOWNLOAD_MODES.some((mode) => mode.value === value)

// Invisible hit-slop for compact text-links (footer Settings, Edit ›,
// Archive ›) — matches the Switch idiom's after:-inset-y-3 (spec §2.8): 18px
// text + 24px slop ≈ 42px effective target.
const LINK_SLOP =
  'relative rounded-sm outline-none transition-colors after:absolute after:-inset-x-1 after:-inset-y-3 focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-[0.97]'

/** What a page action hands its caller — a named contract (not an anonymous object
 *  literal type) so the `{ busy, run }` returned below keeps its inferred shape
 *  instead of widening through an inline annotation. */
interface PageActionHandle {
  readonly busy: boolean
  readonly run: () => Promise<void>
}

/** A page action that messages the active tab's content script and turns the
 *  reply into a status line. Owns its own busy state and the query-tab → send
 *  → format → error skeleton, writing the result into a shared `setMsg` slot
 *  so siblings never leave a stale line; ConfirmStrip gates *when* `run` is
 *  invoked (JSX-level, spec §2.6) — this hook no longer knows about confirm. */
function usePageAction<R>(config: {
  request: { _tag: string }
  format: (res: R | null) => string
  /** Cluster-scoped status-line setter (downloadMsg or releaseMsg) — cleared
   *  on run start, set on completion/error. */
  setMsg: (m: string | null) => void
}): PageActionHandle {
  const [busy, setBusy] = useState(false)

  const run = async (): Promise<void> => {
    setBusy(true)
    config.setMsg(null)
    try {
      const [tab] = await browser.tabs.query({
        active: true,
        currentWindow: true,
      })
      if (tab?.id === undefined) {
        config.setMsg(NO_ACTIVE_TAB)
        return
      }
      // `browser.tabs.sendMessage`'s reply types as `any` (the polyfill has no way to
      // know the content script's response shape), so this is a plain annotation, not
      // a cast: `any` is assignable to any declared type without an assertion.
      const res: R | null = await browser.tabs.sendMessage(tab.id, config.request)
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

/**
 * Release diagnostics summary (ticket #66) — "12 released · 12 flips · 0
 * mismatches" at a glance, independent of `MonitorZone`'s own gating: it
 * renders whenever `metrics.releaseDiagnostics` is present, whether or not a
 * download batch happens to be active right now (a Release run can finish
 * well after its downloads did). All arithmetic lives in
 * `formatReleaseSummaryLine` (packages/clear/correlate.ts, unit-tested) — this
 * component only renders the string and picks a color.
 */
function ReleaseSummaryZone({
  summary,
}: {
  readonly summary: NonNullable<MetricsSnapshot['releaseDiagnostics']>
}) {
  const hasMismatch = summary.serverRejects + summary.reAddFingerprints + summary.reappearances > 0
  return (
    <section
      aria-label="Release diagnostics summary"
      className="animate-in fade-in slide-in-from-top-1 border-t border-border px-3.5 py-2.5 duration-[220ms] ease-[var(--xmd-ease)]"
    >
      <p
        className={cn(
          'font-mono text-xs leading-snug tabular-nums',
          hasMismatch ? 'text-destructive' : 'text-muted-foreground',
        )}
      >
        {formatReleaseSummaryLine(summary)}
        {hasMismatch && ' · see the export'}
      </p>
    </section>
  )
}

// ── Zone 3 — Stage (§2.2, §2.3) ──

function StageZone({
  ctx,
  onXTab,
  willClear,
  aria2Caveat,
  drainBusy,
  sweepBusy,
  onDrain,
  onSweep,
  downloadMsg,
  mod,
  mod2,
}: {
  ctx: TabContext
  onXTab: boolean
  willClear: boolean
  aria2Caveat: boolean
  drainBusy: boolean
  sweepBusy: boolean
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
          disabled={!onXTab || drainBusy}
          onClick={onDrain}
        >
          {drainBusy
            ? 'Queuing…'
            : willClear
              ? 'Download + release this page'
              : 'Download this page'}
        </button>

        <button
          type="button"
          data-slot="button"
          className="flex h-10 w-full items-center justify-center gap-1.5 rounded-[var(--xmd-radius-3)] text-xs font-medium text-foreground/80 outline-none transition-colors hover:bg-muted active:scale-[0.97] focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
          disabled={!onXTab || sweepBusy}
          onClick={onSweep}
        >
          <LayersIcon className="size-3.5" />
          {sweepBusy ? 'Sweeping…' : 'One by one'}
        </button>

        {willClear && (
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="size-1.5 shrink-0 rounded-full bg-destructive" />
            Release after download is on
          </p>
        )}
        {aria2Caveat && (
          <p className="text-pretty text-[11px] text-muted-foreground">{ARIA2_CAVEAT}</p>
        )}

        <output
          aria-live="polite"
          aria-atomic="true"
          className="block text-pretty text-xs leading-snug text-muted-foreground"
        >
          {downloadMsg}
        </output>
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

// ── Zone 4 — Release cluster (§2.2, §2.3, §2.4) — X tabs only ──

function ReleaseTrigger({
  label,
  busy,
  onClick,
}: {
  label: string
  busy: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      data-slot="button"
      disabled={busy}
      className="flex min-h-10 items-center rounded-[var(--xmd-radius-3)] px-1 text-[13px] font-medium text-destructive outline-none transition-colors hover:bg-destructive/10 active:scale-[0.97] focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
      onClick={onClick}
    >
      {label}
    </button>
  )
}

function ReleaseCluster({
  onListPage,
  releaseMsg,
  releasePageBusy,
  releaseListBusy,
  onReleasePage,
  onReleaseList,
}: {
  onListPage: boolean
  releaseMsg: string | null
  releasePageBusy: boolean
  releaseListBusy: boolean
  onReleasePage: () => void
  onReleaseList: () => void
}) {
  const [expanded, setExpanded] = useState(false)

  return (
    <section aria-label="Release" className="grid gap-2 border-t border-border px-3.5 py-4">
      <span className="text-[11px] font-semibold tracking-wide text-muted-foreground">
        Release without downloading
      </span>

      {onListPage ? (
        <div className="grid gap-1">
          <ConfirmStrip
            sentence={releasePageConfirm}
            confirmLabel={RELEASE_PAGE_CONFIRM_LABEL}
            kind="one-shot"
            onConfirm={onReleasePage}
          >
            {(arm) => (
              <ReleaseTrigger label="Release this page…" busy={releasePageBusy} onClick={arm} />
            )}
          </ConfirmStrip>
          <ConfirmStrip
            sentence={releaseListConfirm}
            confirmLabel={RELEASE_LIST_CONFIRM_LABEL}
            kind="one-shot"
            typedWord={RELEASE_WORD.toLowerCase()}
            onConfirm={onReleaseList}
          >
            {(arm) => (
              <ReleaseTrigger
                label="Release the whole list…"
                busy={releaseListBusy}
                onClick={arm}
              />
            )}
          </ConfirmStrip>
        </div>
      ) : (
        <div className="grid gap-1">
          <button
            type="button"
            data-slot="button"
            aria-expanded={expanded}
            className="flex min-h-10 items-center justify-between rounded-[var(--xmd-radius-3)] px-1 text-[13px] font-medium text-destructive outline-none transition-colors hover:bg-destructive/10 active:scale-[0.97] focus-visible:ring-3 focus-visible:ring-ring/50"
            onClick={() => setExpanded((v) => !v)}
          >
            Release
            <span aria-hidden="true" className="relative inline-grid size-3 place-items-center">
              <span
                className={cn(
                  'col-start-1 row-start-1 transition-[opacity,transform] duration-[180ms] ease-[var(--xmd-ease)]',
                  expanded ? 'scale-100 opacity-100' : 'scale-90 opacity-0',
                )}
              >
                ⌃
              </span>
              <span
                className={cn(
                  'col-start-1 row-start-1 transition-[opacity,transform] duration-[180ms] ease-[var(--xmd-ease)]',
                  expanded ? 'scale-90 opacity-0' : 'scale-100 opacity-100',
                )}
              >
                ›
              </span>
            </span>
          </button>
          {expanded && (
            <div className="animate-in fade-in slide-in-from-top-1 duration-[220ms] ease-[var(--xmd-ease)]">
              <ConfirmStrip
                sentence={releasePageConfirm}
                confirmLabel={RELEASE_PAGE_CONFIRM_LABEL}
                kind="one-shot"
                onConfirm={onReleasePage}
              >
                {(arm) => (
                  <ReleaseTrigger label="Release this page…" busy={releasePageBusy} onClick={arm} />
                )}
              </ConfirmStrip>
            </div>
          )}
        </div>
      )}

      <output
        aria-live="polite"
        aria-atomic="true"
        className="block text-pretty text-xs leading-snug text-muted-foreground"
      >
        {releaseMsg}
      </output>
    </section>
  )
}

// ── Zone 5 — Preferences (§2.2, §2.3) — global, rows suppressed per platform ──

function PreferencesZone({
  ctx,
  settings,
  update,
  captureSummary,
}: {
  ctx: TabContext
  settings: Settings
  update: (patch: Partial<Settings>) => Promise<void>
  captureSummary: CaptureSummary | null
}) {
  const isMetaContext = ctx === 'instagram' || ctx === 'threads'
  const tweets = captureSummary?.tweets ?? 0

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
            if (isDownloadStrategy(value)) void update({ downloadStrategy: value })
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
  const [settings, setSettingsState] = useState<Settings | null>(null)
  const [saved, setSaved] = useState(false)
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null)
  const [tabAdapter, setTabAdapter] = useState<PlatformAdapter | undefined>(undefined)
  const [ctx, setCtx] = useState<TabContext>('none')
  const [scope, setScope] = useState<MembershipScope | undefined>(undefined)
  // Cluster-scoped status lines (§2.6) — a download-cluster result can never
  // overwrite the release cluster's line, and vice versa.
  const [downloadMsg, setDownloadMsg] = useState<string | null>(null)
  const [releaseMsg, setReleaseMsg] = useState<string | null>(null)
  const [captureSummary, setCaptureSummary] = useState<CaptureSummary | null>(null)
  const [introState, setIntroState] = useState<FirstRunState | null>(null)

  // Whether the last Stage download action completed without hitting an
  // actionable error (page unreachable / no active tab) — read right after
  // `run()` resolves to decide whether it counts as the "Stage action
  // completes successfully once" first-run dismissal trigger (spec §2.2).
  // A ref (not state) because it must be readable synchronously the instant
  // the triggering promise settles, not after the next render.
  const downloadOkRef = useRef(false)
  const trackDownloadMsg = (m: string | null): void => {
    // Actionable errors (the persist-list) are exactly the lines that must NOT count
    // as a completed Stage action — enumerated via the predicate so a new one (the
    // drain's own DOWNLOAD_REQUEST_FAILED) can't silently start dismissing the strip.
    downloadOkRef.current = m !== null && !isPersistentStatus(m)
    setDownloadMsg(m)
  }

  // Whether a Stage action will ALSO release. Asks the real gate — planClearSeed
  // with an empty batch runs exactly its skip checks and nothing else — instead
  // of re-deriving from settings, so the popup cannot drift from core again (it
  // had: the no-scopes gate was missing, and with every release-scope toggle
  // off the button still claimed "+ release"). The hook path (primary button,
  // red dot, drain copy) respects the per-scope toggles; a sweep brings its own
  // list scope and releases even with all hook toggles off (seed.test.ts pins
  // that asymmetry). Computed before the loading early-return so the action
  // hooks below (which must run unconditionally) can close over it.
  const willRelease = (sweep?: { scope: Scope }): boolean =>
    settings !== null &&
    planClearSeed({
      requests: [],
      mediaById: new Map(),
      ...(sweep !== undefined ? { sweep } : {}),
      settings,
    }).decision === 'seed'
  const willClear = willRelease()
  const willClearSweep = scope !== undefined ? willRelease({ scope }) : willClear
  const aria2Caveat = settings?.clearOnSave === true && settings.downloadStrategy === 'aria2'

  // The reply is terminal (it settles after the background answers), so `busy` — the
  // "Queuing…" label — now covers the real hand-off, and the status line reports what
  // was ADMITTED rather than what was detected.
  const drain = usePageAction<DrainResult>({
    request: { _tag: 'DrainPageRequest' },
    format: (res) => drainResult(res, willClear),
    setMsg: trackDownloadMsg,
  })

  const sweep = usePageAction<{ queued?: number; skipped?: number; reason?: string }>({
    request: { _tag: 'SweepPageRequest' },
    format: (res) => sweepResult(res, willClearSweep),
    setMsg: trackDownloadMsg,
  })

  // Manual one-shot release: un-bookmark / un-like every post currently on the
  // X page, via the content script (the same click path that works by hand).
  // Page-scoped: the content script derives bookmark-vs-like from the list URL
  // itself, so this carries no scope payload. The WHOLE reply reaches the
  // formatter (not just `cleared`): off a list page the handler refuses with
  // `reason: 'not-list-page'`, and a count-only format rendered that refusal as
  // "Released 0 posts on this page." — the off-list disclosure's only control
  // (spec §2.2) reporting success for an action that never ran.
  const releasePage = usePageAction<{ cleared?: number; reason?: string }>({
    request: { _tag: 'ClearVisibleRequest' },
    format: (res) => releasedPageResult(res),
    setMsg: setReleaseMsg,
  })

  // Whole-list release: auto-scroll the entire Likes/Bookmarks list and
  // un-like / un-bookmark every post — heavier and irreversible, gated by the
  // typed-word Confirm Strip and to list pages only.
  const releaseList = usePageAction<{ cleared?: number; reason?: string }>({
    request: { _tag: 'ClearWholeListRequest' },
    format: (res) => releasedListResult(res),
    setMsg: setReleaseMsg,
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
        setTabAdapter(adapterForUrl(url))
        // Recomputes the list-page check from the adapter/platform field
        // directly (ADR-0019's safety property — never an X-specific URL
        // matcher), independently of the tabAdapter assignment above; the
        // registry-backed derivation itself is unit-tested by context.test.ts.
        setCtx(tabContext(url))
        setScope(tabScope(url))
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
    void recordOpen().then(setIntroState)
  }, [])

  useEffect(() => {
    // `active` gates BOTH the state update and any rearm: the popup can close
    // before sendMessage settles, and an async completion must never schedule
    // work (or set state) after unmount.
    let active = true
    let handle: ReturnType<typeof setTimeout> | undefined

    const schedule = (delayMs: number): void => {
      if (!active) return
      handle = setTimeout(poll, delayMs)
    }

    const poll = (): void => {
      void browser.runtime
        .sendMessage({ _tag: 'MetricsRequest' })
        .then((snapshot: MetricsSnapshot | null) => {
          if (!active) return false
          setMetrics(snapshot)
          // Slow the cadence when no batch is active — the monitor (and thus the
          // snapshot) is only shown while total > 0.
          schedule(snapshot && snapshot.total > 0 ? POLL_ACTIVE_MS : POLL_IDLE_MS)
          return true
        })
        .catch(() => schedule(POLL_IDLE_MS))
    }

    poll()
    return () => {
      active = false
      clearTimeout(handle) // no-op while the first timer was never armed
    }
  }, [])

  // Cluster status lines auto-clear after 6s (§2.6) — except the actionable
  // errors in isPersistentStatus, which stay put until the next action in
  // that same cluster starts (already handled: usePageAction's `run()` clears
  // its own slot on start via `config.setMsg(null)`).
  useEffect(() => {
    if (downloadMsg === null || isPersistentStatus(downloadMsg)) return
    const timer = setTimeout(() => setDownloadMsg(null), 6000)
    return () => clearTimeout(timer)
  }, [downloadMsg])

  useEffect(() => {
    if (releaseMsg === null || isPersistentStatus(releaseMsg)) return
    const timer = setTimeout(() => setReleaseMsg(null), 6000)
    return () => clearTimeout(timer)
  }, [releaseMsg])

  // One owned "Saved" feedback timer: a newer save cancels the older timer
  // before rearming, and unmount cancels whatever is pending.
  const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    return () => clearTimeout(savedTimer.current)
  }, [])

  if (!settings) {
    return <div className="xmd-popup xmd-popup--loading">Loading...</div>
  }

  const onXTab = tabAdapter?.platform === 'x'
  const onListPage = ctx === 'x-list'
  const isMetaContext = ctx === 'instagram' || ctx === 'threads'

  const update = async (patch: Partial<Settings>): Promise<void> => {
    setSettingsState(await setSettings(patch))
    setSaved(true)
    clearTimeout(savedTimer.current)
    savedTimer.current = setTimeout(() => {
      setSaved(false)
      savedTimer.current = undefined
    }, 1200)
  }

  const dismissFirstRun = (): void => void markDone().then(setIntroState)

  const runDrain = (): void => {
    void (async () => {
      await drain.run()
      if (downloadOkRef.current) dismissFirstRun()
    })()
  }
  const runSweep = (): void => {
    void (async () => {
      await sweep.run()
      if (downloadOkRef.current) dismissFirstRun()
    })()
  }

  const resetMonitor = async (): Promise<void> => {
    const res: { ok?: boolean } | null = await browser.runtime
      .sendMessage({ _tag: 'ClearDownloadMonitorRequest' })
      .catch(() => null)
    if (res?.ok) setMetrics(null)
  }

  // Only surface the monitor for a real download batch — not for stray hover/UI
  // trace events that also ride the metrics snapshot.
  const monitor = metrics && metrics.total > 0 ? metrics : null
  // Independent of `monitor`: a Release run's diagnostics can exist (and matter)
  // well after its download batch finished, or without one having been the popup's
  // own concern at all (a manual "Release the whole list…" pass, say).
  const releaseSummary = metrics?.releaseDiagnostics ?? null

  const showFirstRun = introState !== null && isXContext(ctx) && shouldShowIntro(introState)
  const mod = modifierLabel(settings.quickGrabModifier)
  const mod2 = secondModifierLabel(settings.quickGrabModifier)

  return (
    <div className="xmd-popup">
      <ContextStrip ctx={ctx} scope={scope} />

      {showFirstRun && <FirstRunStrip mod={mod} onDismiss={dismissFirstRun} />}

      {monitor && <MonitorZone metrics={monitor} onReset={() => void resetMonitor()} />}
      {releaseSummary && <ReleaseSummaryZone summary={releaseSummary} />}

      <StageZone
        ctx={ctx}
        onXTab={onXTab}
        willClear={willClear}
        aria2Caveat={aria2Caveat}
        drainBusy={drain.busy}
        sweepBusy={sweep.busy}
        onDrain={runDrain}
        onSweep={runSweep}
        downloadMsg={downloadMsg}
        mod={mod}
        mod2={mod2}
      />

      {(ctx === 'x' || ctx === 'x-list') && (
        <ReleaseCluster
          onListPage={onListPage}
          releaseMsg={releaseMsg}
          releasePageBusy={releasePage.busy}
          releaseListBusy={releaseList.busy}
          onReleasePage={() => void releasePage.run()}
          onReleaseList={() => void releaseList.run()}
        />
      )}

      <PreferencesZone
        ctx={ctx}
        settings={settings}
        update={update}
        captureSummary={captureSummary}
      />

      {!isMetaContext && (
        <CaptureQuickActions
          summary={captureSummary}
          onCleared={() => setCaptureSummary({ tweets: 0, conversations: 0, recent: [] })}
        />
      )}

      <Footer cloudSyncEnabled={settings.cloudSyncEnabled} onOpenOptions={openOptions} />

      <output
        aria-live="polite"
        aria-atomic="true"
        className={cn(
          'pointer-events-none fixed right-3 bottom-3 transition-[opacity,transform] ease-[var(--xmd-ease)]',
          saved ? 'translate-y-0 opacity-100 duration-200' : 'translate-y-1 opacity-0 duration-150',
        )}
      >
        {saved && (
          <span className="flex items-center gap-1.5 rounded-[var(--xmd-radius-3)] border border-border bg-background px-2.5 py-1 text-xs font-medium text-success">
            <CheckIcon className="size-3" />
            Saved
          </span>
        )}
      </output>
    </div>
  )
}
