import { useEffect, useRef, useState, type MutableRef } from 'preact/hooks'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '@/theme/tokens.stylex'
import { getSettings, setSettings } from '@/packages/settings'
import { DOWNLOAD_MODES } from '@/packages/download/strategy'
import { CLEAR_AFTER_DOWNLOAD } from '@/packages/clear/copy'
import { adapterForUrl } from '@/core/adapters/registry'
import type { PlatformAdapter } from '@/core/adapters/types'
import type { MembershipScope } from '@/packages/clear/clearer'
import { formatReleaseSummaryLine } from '@/packages/clear/correlate'
import type { MetricsSnapshot, Settings } from '@/packages/schema'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Progress } from '@/components/ui/progress'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { LayersIcon, CheckIcon, iconSize } from '@/components/icons'
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

// ── StyleX ──
//
// Shared literals: the vendored [data-slot='button'] override (app.css, pre-
// migration) beat every utility's own transition-duration/timing-function, so
// every raw `data-slot="button"` element below hardcodes 0.16s + the ease
// curve instead of its own `transition-colors` default (150ms/cubic-bezier).
// `--xmd-ease` lives in theme/tokens.css (not tokens.stylex.ts), so it's
// written as the literal custom-property reference throughout, matching the
// ground-truth CSS's `ease-[var(--xmd-ease)]` utility.
const HOVER = '@media (hover: hover)'
const XMD_EASE = 'var(--xmd-ease)'
const BUTTON_TRANSITION_DURATION = '0.16s'
const TRANSITION_COLORS =
  'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to'
const RING_FOCUS_VISIBLE =
  '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent), 0 0 #0000'
const DESTRUCTIVE_HOVER_BG = 'color-mix(in oklab, var(--destructive) 10%, transparent)'

// `animate-in fade-in slide-in-from-top-1` — shared by FirstRunStrip,
// MonitorZone, ReleaseSummaryZone, and the expanded release panel (spec §3).
const enterFadeSlideTop1 = stylex.keyframes({
  '0%': {
    opacity: 0,
    transform: 'translate3d(0, calc(1 * 0.25rem * -1), 0) scale3d(1, 1, 1) rotate(0)',
    filter: 'blur(0)',
  },
})

const styles = stylex.create({
  // ── Popup shell (spec §7 — moved out of app.css) ──
  popup: {
    boxSizing: 'border-box',
    width: '380px',
    maxWidth: '100%',
    minHeight: '360px',
    maxHeight: '600px',
    overflowY: 'auto',
    backgroundColor: tokens['--xmd-bg'],
    color: tokens['--xmd-ink'],
    font: "13px/1.35 system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },
  loading: {
    minHeight: '360px',
    display: 'grid',
    placeItems: 'center',
    color: tokens['--xmd-muted'],
  },

  // ── Zone 1 — Context strip ──
  contextStrip: {
    position: 'sticky',
    top: 0,
    zIndex: 10,
    display: 'flex',
    height: '2.25rem',
    flexShrink: 0,
    alignItems: 'center',
    gap: '0.375rem',
    backgroundColor: tokens['--background'],
    paddingInline: '0.875rem',
    fontSize: '0.75rem',
    lineHeight: 1.375,
    color: tokens['--muted-foreground'],
    boxShadow: '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, 0 1px 0 0 var(--border)',
  },
  contextDot: {
    width: '0.375rem',
    height: '0.375rem',
    flexShrink: 0,
    borderRadius: '3.40282e38px',
  },
  contextDotOn: { backgroundColor: tokens['--success'] },
  contextDotOff: {
    backgroundColor: 'color-mix(in oklab, var(--muted-foreground) 40%, transparent)',
  },
  contextLabel: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },

  // ── Zone 1b — First-run teaching strip ──
  firstRunStrip: {
    display: 'flex',
    minHeight: '2.75rem',
    alignItems: 'center',
    gap: '0.75rem',
    backgroundColor: 'color-mix(in oklab, var(--muted) 30%, transparent)',
    paddingInline: '0.875rem',
    paddingBlock: '0.5rem',
    animationName: enterFadeSlideTop1,
    animationDuration: '0.22s',
    animationTimingFunction: XMD_EASE,
    // `duration-[220ms] ease-[…]` also set transition-duration/-timing-function
    // (with the default `transition-property: all`), so theme/colour changes
    // on these zones ease over 220ms too.
    transitionDuration: '0.22s',
    transitionTimingFunction: XMD_EASE,
    animationDelay: '0s',
    animationIterationCount: 1,
    animationDirection: 'normal',
    animationFillMode: 'none',
  },
  firstRunBodyText: {
    flex: 1,
    textWrap: 'pretty',
    fontSize: '0.75rem',
    lineHeight: 1.375,
    color: tokens['--muted-foreground'],
  },
  dismissButton: {
    display: 'flex',
    width: '2.5rem',
    height: '2.5rem',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: tokens['--xmd-radius-3'],
    fontSize: '0.875rem',
    lineHeight: tokens['--text-sm--line-height'],
    color: tokens['--muted-foreground'],
    outlineStyle: 'none',
    transitionProperty: TRANSITION_COLORS,
    transitionTimingFunction: XMD_EASE,
    transitionDuration: BUTTON_TRANSITION_DURATION,
    backgroundColor: { default: null, [HOVER]: { ':hover': tokens['--muted'] } },
    scale: { default: null, ':active': 0.97 },
    boxShadow: { default: null, ':focus-visible': RING_FOCUS_VISIBLE },
  },

  // ── Zone 2 — Monitor ──
  monitorSection: {
    display: 'grid',
    gap: '0.5rem',
    borderTopStyle: 'solid',
    borderTopWidth: '1px',
    borderColor: tokens['--border'],
    paddingInline: '0.875rem',
    paddingBlock: '1rem',
    animationName: enterFadeSlideTop1,
    animationDuration: '0.22s',
    animationTimingFunction: XMD_EASE,
    // `duration-[220ms] ease-[…]` also set transition-duration/-timing-function
    // (with the default `transition-property: all`), so theme/colour changes
    // on these zones ease over 220ms too.
    transitionDuration: '0.22s',
    transitionTimingFunction: XMD_EASE,
    animationDelay: '0s',
    animationIterationCount: 1,
    animationDirection: 'normal',
    animationFillMode: 'none',
  },
  monitorHeaderRow: {
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: '0.75rem',
  },
  monitorCountGroup: { display: 'flex', alignItems: 'baseline', gap: '0.375rem' },
  monitorCount: {
    fontFamily: tokens['--font-mono'],
    fontSize: '1.5rem',
    lineHeight: 1,
    fontWeight: 600,
    fontVariantNumeric: 'tabular-nums',
  },
  monitorSavedLabel: {
    fontSize: '0.75rem',
    lineHeight: tokens['--text-xs--line-height'],
    color: tokens['--muted-foreground'],
  },
  monitorRightGroup: { display: 'flex', alignItems: 'center', gap: '0.5rem' },
  resetButton: {
    display: 'flex',
    minHeight: '2.5rem',
    alignItems: 'center',
    borderRadius: tokens['--xmd-radius-3'],
    paddingInline: '0.5rem',
    marginBlock: '-0.75rem',
    fontSize: '0.75rem',
    lineHeight: tokens['--text-xs--line-height'],
    fontWeight: 500,
    color: { default: tokens['--muted-foreground'], [HOVER]: { ':hover': tokens['--foreground'] } },
    outlineStyle: 'none',
    transitionProperty: TRANSITION_COLORS,
    transitionTimingFunction: XMD_EASE,
    transitionDuration: BUTTON_TRANSITION_DURATION,
    scale: { default: null, ':active': 0.97 },
    boxShadow: { default: null, ':focus-visible': RING_FOCUS_VISIBLE },
    pointerEvents: { default: null, ':disabled': 'none' },
    opacity: { default: null, ':disabled': 0.5 },
  },
  monitorPercent: {
    fontFamily: tokens['--font-mono'],
    fontSize: '1rem',
    lineHeight: 1,
    fontWeight: 600,
    fontVariantNumeric: 'tabular-nums',
    color: tokens['--primary'],
  },
  monitorProgress: { height: '3px' },
  monitorMetaLine: {
    fontFamily: tokens['--font-mono'],
    fontSize: '0.75rem',
    lineHeight: 1.375,
    fontVariantNumeric: 'tabular-nums',
    color: tokens['--muted-foreground'],
  },

  // ── Release diagnostics summary ──
  releaseSummarySection: {
    borderTopStyle: 'solid',
    borderTopWidth: '1px',
    borderColor: tokens['--border'],
    paddingInline: '0.875rem',
    paddingBlock: '0.625rem',
    animationName: enterFadeSlideTop1,
    animationDuration: '0.22s',
    animationTimingFunction: XMD_EASE,
    // `duration-[220ms] ease-[…]` also set transition-duration/-timing-function
    // (with the default `transition-property: all`), so theme/colour changes
    // on these zones ease over 220ms too.
    transitionDuration: '0.22s',
    transitionTimingFunction: XMD_EASE,
    animationDelay: '0s',
    animationIterationCount: 1,
    animationDirection: 'normal',
    animationFillMode: 'none',
  },
  releaseSummaryLine: {
    fontFamily: tokens['--font-mono'],
    fontSize: '0.75rem',
    lineHeight: 1.375,
    fontVariantNumeric: 'tabular-nums',
  },
  releaseSummaryLineMismatch: { color: tokens['--destructive'] },
  releaseSummaryLineNormal: { color: tokens['--muted-foreground'] },

  // ── Zone 3 — Stage ──
  // `grid gap-2 border-t border-border px-3.5 py-4` — identical string shared
  // by StageZone's x/x-list branch and ReleaseCluster's own section.
  borderedSectionGap2: {
    display: 'grid',
    gap: '0.5rem',
    borderTopStyle: 'solid',
    borderTopWidth: '1px',
    borderColor: tokens['--border'],
    paddingInline: '0.875rem',
    paddingBlock: '1rem',
  },
  primaryCta: {
    height: '2.75rem',
    width: '100%',
    borderRadius: tokens['--xmd-radius-2'],
    fontSize: '0.875rem',
    lineHeight: tokens['--text-sm--line-height'],
    fontWeight: 600,
    color: tokens['--primary-foreground'],
    outlineStyle: 'none',
    transitionProperty: TRANSITION_COLORS,
    transitionTimingFunction: XMD_EASE,
    transitionDuration: BUTTON_TRANSITION_DURATION,
    backgroundColor: {
      default: tokens['--primary'],
      [HOVER]: { ':hover': 'color-mix(in oklab, var(--primary) 90%, transparent)' },
    },
    scale: { default: null, ':active': 0.97 },
    boxShadow: { default: null, ':focus-visible': RING_FOCUS_VISIBLE },
    pointerEvents: { default: null, ':disabled': 'none' },
    opacity: { default: null, ':disabled': 0.5 },
  },
  sweepButton: {
    display: 'flex',
    height: '2.5rem',
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.375rem',
    borderRadius: tokens['--xmd-radius-3'],
    fontSize: '0.75rem',
    lineHeight: tokens['--text-xs--line-height'],
    fontWeight: 500,
    color: 'color-mix(in oklab, var(--foreground) 80%, transparent)',
    outlineStyle: 'none',
    transitionProperty: TRANSITION_COLORS,
    transitionTimingFunction: XMD_EASE,
    transitionDuration: BUTTON_TRANSITION_DURATION,
    backgroundColor: { default: null, [HOVER]: { ':hover': tokens['--muted'] } },
    scale: { default: null, ':active': 0.97 },
    boxShadow: { default: null, ':focus-visible': RING_FOCUS_VISIBLE },
    pointerEvents: { default: null, ':disabled': 'none' },
    opacity: { default: null, ':disabled': 0.5 },
  },
  willClearLine: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.375rem',
    fontSize: '11px',
    color: tokens['--muted-foreground'],
  },
  willClearDot: {
    width: '0.375rem',
    height: '0.375rem',
    flexShrink: 0,
    borderRadius: '3.40282e38px',
    backgroundColor: tokens['--destructive'],
  },
  aria2CaveatText: { textWrap: 'pretty', fontSize: '11px', color: tokens['--muted-foreground'] },
  // `block text-pretty text-xs leading-snug text-muted-foreground` — identical
  // string shared by the download-status and release-status `<output>`s.
  statusOutput: {
    display: 'block',
    textWrap: 'pretty',
    fontSize: '0.75rem',
    lineHeight: 1.375,
    color: tokens['--muted-foreground'],
  },

  stageSectionMeta: {
    display: 'grid',
    gap: '0.375rem',
    borderTopStyle: 'solid',
    borderTopWidth: '1px',
    borderColor: tokens['--border'],
    paddingInline: '0.875rem',
    paddingBlock: '1rem',
  },
  metaHintText: { textWrap: 'pretty', fontSize: '13px' },

  stageSectionUnsupported: {
    display: 'grid',
    gap: '0.75rem',
    borderTopStyle: 'solid',
    borderTopWidth: '1px',
    borderColor: tokens['--border'],
    paddingInline: '0.875rem',
    paddingBlock: '1rem',
  },
  unsupportedHeadline: { textWrap: 'balance', fontSize: '13px', fontWeight: 500 },
  routesGrid: { display: 'grid' },
  routeButton: {
    display: 'flex',
    minHeight: '2.5rem',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: tokens['--xmd-radius-3'],
    paddingInline: '0.25rem',
    fontSize: '13px',
    fontWeight: 500,
    color: 'color-mix(in oklab, var(--foreground) 80%, transparent)',
    outlineStyle: 'none',
    transitionProperty: TRANSITION_COLORS,
    transitionTimingFunction: XMD_EASE,
    transitionDuration: BUTTON_TRANSITION_DURATION,
    backgroundColor: { default: null, [HOVER]: { ':hover': tokens['--muted'] } },
    scale: { default: null, ':active': 0.97 },
    boxShadow: { default: null, ':focus-visible': RING_FOCUS_VISIBLE },
  },

  // ── Zone 4 — Release cluster ──
  releaseTriggerButton: {
    display: 'flex',
    minHeight: '2.5rem',
    alignItems: 'center',
    borderRadius: tokens['--xmd-radius-3'],
    paddingInline: '0.25rem',
    fontSize: '13px',
    fontWeight: 500,
    color: tokens['--destructive'],
    outlineStyle: 'none',
    transitionProperty: TRANSITION_COLORS,
    transitionTimingFunction: XMD_EASE,
    transitionDuration: BUTTON_TRANSITION_DURATION,
    backgroundColor: { default: null, [HOVER]: { ':hover': DESTRUCTIVE_HOVER_BG } },
    scale: { default: null, ':active': 0.97 },
    boxShadow: { default: null, ':focus-visible': RING_FOCUS_VISIBLE },
    pointerEvents: { default: null, ':disabled': 'none' },
    opacity: { default: null, ':disabled': 0.5 },
  },
  // `text-[11px] font-semibold tracking-wide text-muted-foreground` — identical
  // string shared by ReleaseCluster's own label and PreferencesZone's "Mode".
  sectionLabel: {
    fontSize: '11px',
    fontWeight: 600,
    letterSpacing: '0.025em',
    color: tokens['--muted-foreground'],
  },
  confirmGroupGrid: { display: 'grid', gap: '0.25rem' },
  releaseExpandButton: {
    display: 'flex',
    minHeight: '2.5rem',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: tokens['--xmd-radius-3'],
    paddingInline: '0.25rem',
    fontSize: '13px',
    fontWeight: 500,
    color: tokens['--destructive'],
    outlineStyle: 'none',
    transitionProperty: TRANSITION_COLORS,
    transitionTimingFunction: XMD_EASE,
    transitionDuration: BUTTON_TRANSITION_DURATION,
    backgroundColor: { default: null, [HOVER]: { ':hover': DESTRUCTIVE_HOVER_BG } },
    scale: { default: null, ':active': 0.97 },
    boxShadow: { default: null, ':focus-visible': RING_FOCUS_VISIBLE },
  },
  chevronIconWrap: {
    position: 'relative',
    display: 'inline-grid',
    width: '0.75rem',
    height: '0.75rem',
    placeItems: 'center',
  },
  // No `data-slot="button"` on these spans — they keep their own
  // transition-[opacity,transform] duration-[180ms] timing, not the button override.
  chevronLayer: {
    gridColumnStart: 1,
    gridRowStart: 1,
    transitionProperty: 'opacity, transform',
    transitionTimingFunction: XMD_EASE,
    transitionDuration: '0.18s',
  },
  chevronVisible: { scale: '100% 100%', opacity: 1 },
  chevronHidden: { scale: '90% 90%', opacity: 0 },
  releaseExpandedPanel: {
    animationName: enterFadeSlideTop1,
    animationDuration: '0.22s',
    animationTimingFunction: XMD_EASE,
    // `duration-[220ms] ease-[…]` also set transition-duration/-timing-function
    // (with the default `transition-property: all`), so theme/colour changes
    // on these zones ease over 220ms too.
    transitionDuration: '0.22s',
    transitionTimingFunction: XMD_EASE,
    animationDelay: '0s',
    animationIterationCount: 1,
    animationDirection: 'normal',
    animationFillMode: 'none',
  },

  // ── Zone 5 — Preferences ──
  preferencesSection: {
    display: 'grid',
    gap: '1rem',
    borderTopStyle: 'solid',
    borderTopWidth: '1px',
    borderColor: tokens['--border'],
    paddingInline: '0.875rem',
    paddingBlock: '1rem',
  },
  modeGroup: { display: 'grid', gap: '0.375rem' },
  toggleGroupSx: { width: '100%', borderRadius: tokens['--xmd-radius-3'] },
  toggleGroupItemSx: { height: '2.5rem', flex: 1, fontSize: '13px', lineHeight: null },
  metaContextNote: { fontSize: '0.75rem', lineHeight: 1.375, color: tokens['--muted-foreground'] },
  fieldDescMono: { fontFamily: tokens['--font-mono'] },
  fieldDescFlex: { display: 'flex', alignItems: 'center', gap: '0.375rem' },
  monoTabularNums: { fontFamily: tokens['--font-mono'], fontVariantNumeric: 'tabular-nums' },

  // Inline `LINK_SLOP` text-links (footer Settings, Edit ›, Archive ›) — the
  // shared hit-slop/ring/press treatment, composed with each call site's own
  // color/weight/font additions.
  linkSlop: {
    position: 'relative',
    borderRadius: 'calc(var(--radius) - 4px)',
    outlineStyle: 'none',
    transitionProperty: TRANSITION_COLORS,
    transitionTimingFunction: XMD_EASE,
    transitionDuration: BUTTON_TRANSITION_DURATION,
    '::after': {
      content: '""',
      position: 'absolute',
      insetInline: '-0.25rem',
      insetBlock: '-0.75rem',
    },
    boxShadow: { default: null, ':focus-visible': RING_FOCUS_VISIBLE },
    scale: { default: null, ':active': 0.97 },
  },
  linkText: {
    color: tokens['--primary'],
    textDecorationLine: { default: null, [HOVER]: { ':hover': 'underline' } },
  },
  linkFontSans: { fontFamily: tokens['--font-sans'] },
  linkFontSemibold: { fontWeight: 600 },

  // ── Zone 7 — Footer ──
  footerBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.5rem',
    borderTopStyle: 'solid',
    borderTopWidth: '1px',
    borderColor: tokens['--border'],
    paddingInline: '0.875rem',
    paddingBlock: '0.75rem',
    fontSize: '0.75rem',
    lineHeight: 1.375,
    color: tokens['--muted-foreground'],
  },

  // ── "Saved" toast ──
  // No `data-slot="button"` here either — the toast keeps its own
  // transition-[opacity,transform] timing, not the button override.
  toastOutput: {
    pointerEvents: 'none',
    position: 'fixed',
    right: '0.75rem',
    bottom: '0.75rem',
    transitionProperty: 'opacity, transform',
    transitionTimingFunction: XMD_EASE,
  },
  toastSaved: { translate: '0 0', opacity: 1, transitionDuration: '0.2s' },
  toastNotSaved: { translate: '0 0.25rem', opacity: 0, transitionDuration: '0.15s' },
  savedBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.375rem',
    borderRadius: tokens['--xmd-radius-3'],
    borderStyle: 'solid',
    borderWidth: '1px',
    borderColor: tokens['--border'],
    backgroundColor: tokens['--background'],
    paddingInline: '0.625rem',
    paddingBlock: '0.25rem',
    fontSize: '0.75rem',
    lineHeight: tokens['--text-xs--line-height'],
    fontWeight: 500,
    color: tokens['--success'],
  },
})

// Archive ›) — matches the Switch idiom's after:-inset-y-3 (spec §2.8): 18px
// text + 24px slop ≈ 42px effective target. (StyleX: `styles.linkSlop` + `styles.linkText`.)

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

/** Compute whether a release action is viable given the current settings. */
function canRelease(settings: Settings | null, sweepScope?: { scope: Scope }): boolean {
  if (settings === null) return false
  const decision = planClearSeed({
    requests: [],
    mediaById: new Map(),
    ...(sweepScope ? { sweep: sweepScope } : {}),
    settings,
  }).decision
  return decision === 'seed'
}

/** Create an async runner that dismisses first-run UI on success. */
function createFirstRunAwareRunner(
  actionRun: () => Promise<void>,
  downloadOkRef: MutableRef<boolean>,
  dismissFirstRun: () => void,
): () => void {
  return () => {
    void (async () => {
      await actionRun()
      if (downloadOkRef.current) dismissFirstRun()
    })()
  }
}

/** Determine whether to show the active monitor (only when a batch is really running). */
function getActiveMonitor(metrics: MetricsSnapshot | null): MetricsSnapshot | null {
  if (!metrics || metrics.total === 0) return null
  return metrics
}

/** Determine if the first-run intro should be displayed. */
function shouldShowFirstRunIntro(introState: FirstRunState | null, ctx: TabContext): boolean {
  if (introState === null || !isXContext(ctx)) return false
  return shouldShowIntro(introState)
}

/**
 * Determine if a download action completed successfully (not a persistent error).
 *
 * Actionable errors (the persist-list) are exactly the lines that must NOT count
 * as a completed Stage action — enumerated via the predicate so a new one (the
 * drain's own DOWNLOAD_REQUEST_FAILED) can't silently start dismissing the strip.
 */
function isDownloadOk(msg: string | null): boolean {
  if (msg === null) return false
  return !isPersistentStatus(msg)
}

/** Determine if a context is Meta-owned (Instagram or Threads). */
function isMetaContextValue(ctx: TabContext): boolean {
  switch (ctx) {
    case 'instagram':
    case 'threads':
      return true
    default:
      return false
  }
}

/** Compute the sweep-scope-adjusted release logic. */
function getWillClearSweep(settings: Settings | null, scope: MembershipScope | undefined): boolean {
  if (scope === undefined) return canRelease(settings)
  return canRelease(settings, { scope })
}

// ── Zone 1 — Context strip (§2.2, §2.3) ──

function ContextStrip({ ctx, scope }: { ctx: TabContext; scope: MembershipScope | undefined }) {
  return (
    <header {...stylex.props(styles.contextStrip)}>
      <span
        {...stylex.props(
          styles.contextDot,
          ctx !== 'none' ? styles.contextDotOn : styles.contextDotOff,
        )}
      />
      <span {...stylex.props(styles.contextLabel)}>{contextLabel(ctx, scope)}</span>
    </header>
  )
}

// ── Zone 1b — First-run teaching strip (§2.2, §2.3) ──

function FirstRunStrip({ mod, onDismiss }: { mod: string; onDismiss: () => void }) {
  return (
    <div {...stylex.props(styles.firstRunStrip)}>
      <p {...stylex.props(styles.firstRunBodyText)}>{firstRunBody(mod)}</p>
      <button
        type="button"
        data-slot="button"
        aria-label="Dismiss tip"
        {...stylex.props(styles.dismissButton)}
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
    <section aria-label="Download monitor" {...stylex.props(styles.monitorSection)}>
      <div {...stylex.props(styles.monitorHeaderRow)}>
        <div {...stylex.props(styles.monitorCountGroup)}>
          <span {...stylex.props(styles.monitorCount)}>
            {done}/{metrics.total}
          </span>
          <span {...stylex.props(styles.monitorSavedLabel)}>saved</span>
        </div>
        <div {...stylex.props(styles.monitorRightGroup)}>
          <button
            type="button"
            data-slot="button"
            {...stylex.props(styles.resetButton)}
            disabled={!canReset}
            title={!canReset ? 'Downloads still active' : undefined}
            onClick={onReset}
          >
            {!canReset ? 'Active' : 'Reset'}
          </button>
          <span {...stylex.props(styles.monitorPercent)}>{pct}%</span>
        </div>
      </div>
      <Progress value={pct} aria-label="Download progress" sx={styles.monitorProgress} />
      {metaLine !== '' && <p {...stylex.props(styles.monitorMetaLine)}>{metaLine}</p>}
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
      {...stylex.props(styles.releaseSummarySection)}
    >
      <p
        {...stylex.props(
          styles.releaseSummaryLine,
          hasMismatch ? styles.releaseSummaryLineMismatch : styles.releaseSummaryLineNormal,
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
      <section aria-label="Stage" {...stylex.props(styles.borderedSectionGap2)}>
        <button
          type="button"
          data-slot="button"
          {...stylex.props(styles.primaryCta)}
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
          {...stylex.props(styles.sweepButton)}
          disabled={!onXTab || sweepBusy}
          onClick={onSweep}
        >
          <LayersIcon sx={iconSize.s35} />
          {sweepBusy ? 'Sweeping…' : 'One by one'}
        </button>

        {willClear && (
          <p {...stylex.props(styles.willClearLine)}>
            <span {...stylex.props(styles.willClearDot)} />
            Release after download is on
          </p>
        )}
        {aria2Caveat && <p {...stylex.props(styles.aria2CaveatText)}>{ARIA2_CAVEAT}</p>}

        <output aria-live="polite" aria-atomic="true" {...stylex.props(styles.statusOutput)}>
          {downloadMsg}
        </output>
      </section>
    )
  }

  if (ctx === 'instagram' || ctx === 'threads') {
    return (
      <section aria-label="Stage" {...stylex.props(styles.stageSectionMeta)}>
        <p {...stylex.props(styles.metaHintText)}>{hoverGrabLine(mod)}</p>
        <p {...stylex.props(styles.metaHintText)}>{wholePostLine(mod, mod2)}</p>
      </section>
    )
  }

  return (
    <section aria-label="Stage" {...stylex.props(styles.stageSectionUnsupported)}>
      <p {...stylex.props(styles.unsupportedHeadline)}>
        Open X, Instagram, or Threads to use this extension.
      </p>
      <div {...stylex.props(styles.routesGrid)}>
        {ROUTES.map((r) => (
          <button
            key={r.url}
            type="button"
            data-slot="button"
            {...stylex.props(styles.routeButton)}
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
      {...stylex.props(styles.releaseTriggerButton)}
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
    <section aria-label="Release" {...stylex.props(styles.borderedSectionGap2)}>
      <span {...stylex.props(styles.sectionLabel)}>Release without downloading</span>

      {onListPage ? (
        <div {...stylex.props(styles.confirmGroupGrid)}>
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
        <div {...stylex.props(styles.confirmGroupGrid)}>
          <button
            type="button"
            data-slot="button"
            aria-expanded={expanded}
            {...stylex.props(styles.releaseExpandButton)}
            onClick={() => setExpanded((v) => !v)}
          >
            Release
            <span aria-hidden="true" {...stylex.props(styles.chevronIconWrap)}>
              <span
                {...stylex.props(
                  styles.chevronLayer,
                  expanded ? styles.chevronVisible : styles.chevronHidden,
                )}
              >
                ⌃
              </span>
              <span
                {...stylex.props(
                  styles.chevronLayer,
                  expanded ? styles.chevronHidden : styles.chevronVisible,
                )}
              >
                ›
              </span>
            </span>
          </button>
          {expanded && (
            <div {...stylex.props(styles.releaseExpandedPanel)}>
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

      <output aria-live="polite" aria-atomic="true" {...stylex.props(styles.statusOutput)}>
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
    <section {...stylex.props(styles.preferencesSection)}>
      <div {...stylex.props(styles.modeGroup)}>
        <span {...stylex.props(styles.sectionLabel)}>Mode</span>
        <ToggleGroup
          type="single"
          variant="outline"
          spacing={0}
          sx={styles.toggleGroupSx}
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
              sx={styles.toggleGroupItemSx}
            >
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      {isMetaContext ? (
        <p {...stylex.props(styles.metaContextNote)}>Release and Capture are X-only.</p>
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
                    <FieldDescription sx={styles.fieldDescMono}>
                      {clearScopeSummary(settings)} ·{' '}
                      <button
                        type="button"
                        data-slot="button"
                        {...stylex.props(styles.linkSlop, styles.linkText, styles.linkFontSans)}
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
              <FieldDescription sx={styles.fieldDescFlex}>
                {!settings.captureEnabled ? (
                  'Off — captures tweet text locally as you scroll.'
                ) : tweets > 0 ? (
                  <>
                    <span {...stylex.props(styles.monoTabularNums)}>{plural(tweets, 'tweet')}</span>
                    <button
                      type="button"
                      data-slot="button"
                      {...stylex.props(styles.linkSlop, styles.linkText)}
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
    <footer {...stylex.props(styles.footerBar)}>
      <span>
        {cloudSyncEnabled ? 'Cloud sync on · metadata only' : 'No remote telemetry · local only'}
      </span>
      <button
        type="button"
        data-slot="button"
        onClick={onOpenOptions}
        {...stylex.props(styles.linkSlop, styles.linkText, styles.linkFontSemibold)}
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
    downloadOkRef.current = isDownloadOk(m)
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
  const willClear = canRelease(settings)
  const willClearSweep = getWillClearSweep(settings, scope)
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
    if (downloadMsg === null || isPersistentStatus(downloadMsg)) return undefined
    const timer = setTimeout(() => setDownloadMsg(null), 6000)
    return () => clearTimeout(timer)
  }, [downloadMsg])

  useEffect(() => {
    if (releaseMsg === null || isPersistentStatus(releaseMsg)) return undefined
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
    return (
      <div {...stylex.props(styles.popup, styles.loading)} data-xmd-popup="loading">
        Loading...
      </div>
    )
  }

  const onXTab = tabAdapter?.platform === 'x'
  const onListPage = ctx === 'x-list'
  const isMetaContext = isMetaContextValue(ctx)

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

  const runDrain = createFirstRunAwareRunner(() => drain.run(), downloadOkRef, dismissFirstRun)
  const runSweep = createFirstRunAwareRunner(() => sweep.run(), downloadOkRef, dismissFirstRun)

  const resetMonitor = async (): Promise<void> => {
    const res: { ok?: boolean } | null = await browser.runtime
      .sendMessage({ _tag: 'ClearDownloadMonitorRequest' })
      .catch(() => null)
    // Only clear if the reset was acknowledged as successful
    if (!res?.ok) return
    setMetrics(null)
  }

  // Only surface the monitor for a real download batch — not for stray hover/UI
  // trace events that also ride the metrics snapshot.
  const monitor = getActiveMonitor(metrics)
  // Independent of `monitor`: a Release run's diagnostics can exist (and matter)
  // well after its download batch finished, or without one having been the popup's
  // own concern at all (a manual "Release the whole list…" pass, say).
  const releaseSummary = metrics?.releaseDiagnostics ?? null

  const showFirstRun = shouldShowFirstRunIntro(introState, ctx)
  const mod = modifierLabel(settings.quickGrabModifier)
  const mod2 = secondModifierLabel(settings.quickGrabModifier)

  return (
    <div {...stylex.props(styles.popup)} data-xmd-popup="ready">
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
        {...stylex.props(styles.toastOutput, saved ? styles.toastSaved : styles.toastNotSaved)}
      >
        {saved && (
          <span {...stylex.props(styles.savedBadge)}>
            <CheckIcon sx={iconSize.s3} />
            Saved
          </span>
        )}
      </output>
    </div>
  )
}
