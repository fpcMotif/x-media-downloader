import { useEffect, useRef, useState } from 'preact/hooks'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '@/theme/tokens.stylex'
import { EraserIcon, iconSize } from '@/components/icons'
import { runCaptureExport, type CaptureSummary } from '@/components/capture-export'
import {
  plural,
  fmtDay,
  confirmEraseArchiveCopy,
  erasedArchiveCopy,
} from '@/components/capture-copy'
import { ConfirmStrip } from '@/components/confirm-strip'

// Keep this in sync with the eager fetch in App.tsx (fetchCaptureSummary(3)) —
// the popup asks the background for exactly this many recent conversations, so
// slicing here is a defensive no-op, not a real pagination cut.
const RECENT_LIMIT = 3

const HOVER = '@media (hover: hover)'

// `transition-colors` (Tailwind v4) — verbatim property list.
const TRANSITION_COLORS =
  'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to'
// `focus-visible:ring-3 focus-visible:ring-ring/50` — five box-shadow layers.
const FOCUS_RING =
  '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent), 0 0 #0000'

// `animate-in fade-in slide-in-from-top-1`.
const enterFadeSlideTop1 = stylex.keyframes({
  '0%': {
    opacity: 0,
    transform: 'translate3d(0, calc(1 * 0.25rem * -1), 0) scale3d(1, 1, 1) rotate(0)',
    filter: 'blur(0)',
  },
})

const styles = stylex.create({
  root: {
    display: 'grid',
    gap: '0.5rem',
    borderTopStyle: 'solid',
    borderTopWidth: '1px',
    borderColor: tokens['--border'],
    paddingInline: '0.875rem',
    paddingBlock: '1rem',
  },
  // `data-slot="button"` override baked in: transitionDuration '0.16s',
  // transitionTimingFunction 'var(--xmd-ease)' (spec §3).
  disclosureButton: {
    display: 'flex',
    minHeight: '2.5rem',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: tokens['--xmd-radius-3'],
    fontSize: '0.75rem',
    lineHeight: tokens['--text-xs--line-height'],
    fontWeight: 500,
    color: {
      default: 'color-mix(in oklab, var(--foreground) 80%, transparent)',
      [HOVER]: { ':hover': tokens['--foreground'] },
    },
    outlineStyle: 'none',
    transitionProperty: TRANSITION_COLORS,
    transitionDuration: '0.16s',
    transitionTimingFunction: 'var(--xmd-ease)',
    scale: { default: null, ':active': 0.97 },
    boxShadow: { default: null, ':focus-visible': FOCUS_RING },
  },
  chevronWrap: {
    position: 'relative',
    display: 'inline-grid',
    width: '0.75rem',
    height: '0.75rem',
    placeItems: 'center',
  },
  // No data-slot on these spans, so the 0.18s + var(--xmd-ease) utility
  // values apply directly (no override).
  chevronGlyph: {
    gridColumnStart: 1,
    gridRowStart: 1,
    transitionProperty: 'opacity, transform',
    transitionDuration: '0.18s',
    transitionTimingFunction: 'var(--xmd-ease)',
  },
  chevronVisible: {
    scale: '100% 100%',
    opacity: 1,
  },
  chevronHidden: {
    scale: '90% 90%',
    opacity: 0,
  },
  panel: {
    display: 'grid',
    gap: '0.625rem',
    animationName: enterFadeSlideTop1,
    animationDuration: '0.22s',
    animationTimingFunction: 'var(--xmd-ease)',
    // `duration-[220ms] ease-[…]` also set transition-duration/-timing-function
    // (default `transition-property: all`).
    transitionDuration: '0.22s',
    transitionTimingFunction: 'var(--xmd-ease)',
    animationDelay: '0s',
    animationIterationCount: 1,
    animationDirection: 'normal',
    animationFillMode: 'none',
  },
  gridGap2: {
    display: 'grid',
    gap: '0.5rem',
  },
  recentRow: {
    display: 'grid',
    gap: '0.125rem',
    fontSize: '0.75rem',
    lineHeight: tokens['--text-xs--line-height'],
  },
  rowTop: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.5rem',
  },
  truncate: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  truncateMuted: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: tokens['--muted-foreground'],
  },
  fontMedium: {
    fontWeight: 500,
  },
  meta: {
    fontFamily: tokens['--font-mono'],
    fontVariantNumeric: 'tabular-nums',
    color: tokens['--muted-foreground'],
  },
  actionsWrap: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: '0.375rem',
  },
  mutedForeground: {
    color: tokens['--muted-foreground'],
  },
  emptyText: {
    fontSize: '0.75rem',
    lineHeight: tokens['--text-xs--line-height'],
    color: tokens['--muted-foreground'],
  },
  // Invisible hit-slop for the compact JSON/Markdown/Export-all/Erase
  // text-links (spec §2.8) — matches the Switch idiom's after:-inset-y-3.
  linkSlop: {
    position: 'relative',
    borderRadius: 'calc(var(--radius) - 4px)',
    outlineStyle: 'none',
    transitionProperty: TRANSITION_COLORS,
    transitionDuration: '0.16s',
    transitionTimingFunction: 'var(--xmd-ease)',
    '::after': {
      content: '""',
      position: 'absolute',
      insetInline: '-0.25rem',
      insetBlock: '-0.75rem',
    },
    boxShadow: { default: null, ':focus-visible': FOCUS_RING },
    scale: { default: null, ':active': 0.97 },
  },
  textPrimaryUnderline: {
    color: tokens['--primary'],
    textDecorationLine: { default: null, [HOVER]: { ':hover': 'underline' } },
  },
  exportAllText: {
    justifySelf: 'flex-start',
    fontSize: '0.75rem',
    lineHeight: tokens['--text-xs--line-height'],
    fontWeight: 500,
    color: tokens['--primary'],
    textDecorationLine: { default: null, [HOVER]: { ':hover': 'underline' } },
  },
  eraseText: {
    display: 'flex',
    alignItems: 'center',
    justifySelf: 'flex-start',
    gap: '0.25rem',
    fontSize: '0.75rem',
    lineHeight: tokens['--text-xs--line-height'],
    fontWeight: 500,
    color: tokens['--destructive'],
    textDecorationLine: { default: null, [HOVER]: { ':hover': 'underline' } },
  },
  statusOutput: {
    display: 'block',
    textWrap: 'pretty',
    fontSize: '0.75rem',
    lineHeight: 1.375,
  },
})

interface CaptureQuickActionsProps {
  readonly summary: CaptureSummary | null
  /** Called after a successful erase so the parent can zero its own captureSummary
   *  state (mirrors the reset the Archive settings panel does locally). */
  readonly onCleared: () => void
}

/** Popup-sized quick actions for the harvest archive: a collapsed disclosure that,
 *  once opened, shows the most recent conversations (with per-row export links)
 *  plus a bulk "Export all" and a Confirm-Strip-gated "Erase archive…" — all
 *  without leaving the popup for the full Archive settings tab. Renders nothing
 *  until something has actually been captured. */
export function CaptureQuickActions({ summary, onCleared }: CaptureQuickActionsProps) {
  const [open, setOpen] = useState(false)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  // One owned status-flash timer: a newer flash cancels the older timer before
  // rearming, and unmount cancels whatever is pending. Hooks stay above the
  // conditional return below.
  const statusTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    return () => clearTimeout(statusTimer.current)
  }, [])

  const tweets = summary?.tweets ?? 0
  // A successful erase zeroes the parent's captureSummary synchronously in
  // the same batch that sets statusMsg below — an early return on tweets===0
  // alone would unmount this block before its own flash ever painted. Stay
  // mounted while a flash is pending; its own timeout (flashStatus) clears it.
  if (tweets === 0 && statusMsg === null) return null

  const flashStatus = (msg: string): void => {
    setStatusMsg(msg)
    clearTimeout(statusTimer.current)
    statusTimer.current = setTimeout(() => {
      setStatusMsg(null)
      statusTimer.current = undefined
    }, 5000)
  }

  const exportAll = async (): Promise<void> => {
    const outcome = await runCaptureExport('jsonl')
    flashStatus(outcome.detail)
  }

  const exportConversation = async (
    kind: 'tree' | 'markdown',
    conversationId: string,
  ): Promise<void> => {
    const outcome =
      kind === 'tree'
        ? await runCaptureExport('tree', conversationId)
        : await runCaptureExport('markdown', conversationId)
    flashStatus(outcome.detail)
  }

  // Fire-and-forget, matching the Archive settings panel's eraseArchive: the
  // local reset + status message happen unconditionally, since ClearCaptureRequest
  // is a durable local wipe with no partial-failure mode worth branching on.
  const eraseArchive = async (): Promise<void> => {
    await browser.runtime.sendMessage({ _tag: 'ClearCaptureRequest' }).catch(() => {})
    onCleared()
    flashStatus(erasedArchiveCopy(tweets))
  }

  const recent = (summary?.recent ?? []).slice(0, RECENT_LIMIT)

  return (
    <div {...stylex.props(styles.root)}>
      <button
        type="button"
        data-slot="button"
        {...stylex.props(styles.disclosureButton)}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        Recent
        <span aria-hidden="true" {...stylex.props(styles.chevronWrap)}>
          <span
            {...stylex.props(
              styles.chevronGlyph,
              open ? styles.chevronVisible : styles.chevronHidden,
            )}
          >
            ⌃
          </span>
          <span
            {...stylex.props(
              styles.chevronGlyph,
              open ? styles.chevronHidden : styles.chevronVisible,
            )}
          >
            ⌄
          </span>
        </span>
      </button>

      {open && (
        <div {...stylex.props(styles.panel)}>
          {recent.length > 0 ? (
            <ol {...stylex.props(styles.gridGap2)} aria-label="Recently captured conversations">
              {recent.map((c) => (
                <li key={c.conversationId} {...stylex.props(styles.recentRow)}>
                  <div {...stylex.props(styles.rowTop)}>
                    <span {...stylex.props(styles.truncate)}>
                      <span {...stylex.props(styles.fontMedium)}>@{c.rootHandle}</span>
                      <span {...stylex.props(styles.meta)}>
                        {' '}
                        · {plural(c.count, 'tweet')} · {fmtDay(c.lastAt)}
                      </span>
                    </span>
                    <span {...stylex.props(styles.actionsWrap)}>
                      <button
                        type="button"
                        data-slot="button"
                        aria-label={`Export conversation by @${c.rootHandle} as JSON`}
                        {...stylex.props(styles.textPrimaryUnderline, styles.linkSlop)}
                        onClick={() => void exportConversation('tree', c.conversationId)}
                      >
                        JSON
                      </button>
                      <span aria-hidden="true" {...stylex.props(styles.mutedForeground)}>
                        ·
                      </span>
                      <button
                        type="button"
                        data-slot="button"
                        aria-label={`Export conversation by @${c.rootHandle} as Markdown`}
                        {...stylex.props(styles.textPrimaryUnderline, styles.linkSlop)}
                        onClick={() => void exportConversation('markdown', c.conversationId)}
                      >
                        Markdown
                      </button>
                    </span>
                  </div>
                  <span {...stylex.props(styles.truncateMuted)}>{c.rootText}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p {...stylex.props(styles.emptyText)}>Nothing captured yet.</p>
          )}

          <div {...stylex.props(styles.gridGap2)}>
            <button
              type="button"
              data-slot="button"
              {...stylex.props(styles.exportAllText, styles.linkSlop)}
              onClick={() => void exportAll()}
            >
              Export all · JSONL
            </button>

            <ConfirmStrip
              sentence={confirmEraseArchiveCopy(tweets)}
              confirmLabel="Erase the archive"
              kind="one-shot"
              onConfirm={() => void eraseArchive()}
            >
              {(arm) => (
                <button
                  type="button"
                  data-slot="button"
                  {...stylex.props(styles.eraseText, styles.linkSlop)}
                  onClick={arm}
                >
                  <EraserIcon sx={iconSize.s35} />
                  Erase archive…
                </button>
              )}
            </ConfirmStrip>
          </div>
        </div>
      )}

      <output
        aria-live="polite"
        aria-atomic="true"
        {...stylex.props(styles.statusOutput, styles.mutedForeground)}
      >
        {statusMsg}
      </output>
    </div>
  )
}
