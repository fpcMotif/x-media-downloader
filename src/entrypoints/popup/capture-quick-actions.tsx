import { useState } from 'preact/hooks'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '@/theme/tokens.stylex'
import { ChevronDownIcon, EraserIcon, iconSize } from '@/components/icons'
import { runCaptureExport, type CaptureSummary } from '@/components/capture-export'
import { plural, fmtDay, confirmEraseArchiveCopy } from '@/components/capture-copy'
import { runCaptureErase } from '@/components/capture-erase'
import { ConfirmStrip, useConfirmStrip } from '@/components/confirm-strip'
import { useOwnedTimer } from '@/components/owned-timer'
import { Collapse, useLingeringValue } from './collapse'

// Keep this in sync with the eager fetch in App.tsx (fetchCaptureSummary(3)) —
// the popup asks the background for exactly this many recent conversations, so
// slicing here is a defensive no-op, not a real pagination cut.
const RECENT_LIMIT = 3

const HOVER = '@media (hover: hover)'

// `transition-colors` (Tailwind v4) — verbatim property list.
const TRANSITION_COLORS =
  'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to, scale'
// `focus-visible:ring-3 focus-visible:ring-ring/50` — five box-shadow layers.
const FOCUS_RING =
  '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent), 0 0 #0000'

const styles = stylex.create({
  root: {
    display: 'grid',
    marginInline: '0.5rem',
    marginTop: '0.5rem',
    borderStyle: 'solid',
    borderWidth: '1px',
    borderColor: tokens['--border'],
    borderRadius: tokens['--xmd-radius-1'],
    backgroundColor: tokens['--xmd-surface'],
    paddingInline: '0.75rem',
    paddingBlock: '0.125rem',
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
  chevron: {
    flexShrink: 0,
    transitionProperty: 'rotate',
    transitionDuration: '0.26s',
    transitionTimingFunction: 'var(--xmd-ease)',
  },
  chevronCollapsed: { rotate: '0deg' },
  chevronExpanded: { rotate: '180deg' },
  panel: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr)',
    gap: '0.625rem',
    paddingTop: '0.25rem',
    paddingBottom: '0.5rem',
    // `duration-[220ms] ease-[…]` also set transition-duration/-timing-function
    // (default `transition-property: all`).
    transitionDuration: '0.22s',
    transitionTimingFunction: 'var(--xmd-ease)',
  },
  gridGap2: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr)',
    gap: '0.5rem',
  },
  recentRow: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr)',
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
    paddingBottom: '0.5rem',
  },
})

interface CaptureQuickActionsProps {
  readonly summary: CaptureSummary
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
  const statusTimer = useOwnedTimer()
  const eraseStrip = useConfirmStrip()

  const shownStatusMsg = useLingeringValue(statusMsg)

  const tweets = summary.tweets
  // A successful erase zeroes the parent's captureSummary synchronously in
  // the same batch that sets statusMsg below — an early return on tweets===0
  // alone would unmount this block before its own flash ever painted. Stay
  // mounted while a flash is pending; its own timeout (flashStatus) clears it.
  if (tweets === 0 && statusMsg === null) return null

  const flashStatus = (msg: string): void => {
    setStatusMsg(msg)
    statusTimer.arm(() => setStatusMsg(null), 5000)
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

  // The local reset happens only after the worker confirms the erase, matching
  // the Archive settings panel's eraseArchive.
  const eraseArchive = async (): Promise<void> => {
    const outcome = await runCaptureErase(tweets)
    if (outcome.ok) onCleared()
    flashStatus(outcome.detail)
  }

  const recent = summary.recent.slice(0, RECENT_LIMIT)

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
        <ChevronDownIcon
          aria-hidden="true"
          sx={[
            iconSize.s35,
            styles.chevron,
            open ? styles.chevronExpanded : styles.chevronCollapsed,
          ]}
        />
      </button>

      <Collapse open={open}>
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
              control={eraseStrip}
              sentence={confirmEraseArchiveCopy(tweets)}
              confirmLabel="Erase the archive"
              kind="one-shot"
              onConfirm={() => void eraseArchive()}
            >
              <button
                type="button"
                data-slot="button"
                {...stylex.props(styles.eraseText, styles.linkSlop)}
                onClick={eraseStrip.arm}
              >
                <EraserIcon sx={iconSize.s35} />
                Erase archive…
              </button>
            </ConfirmStrip>
          </div>
        </div>
      </Collapse>

      <Collapse open={statusMsg !== null}>
        <output
          aria-live="polite"
          aria-atomic="true"
          {...stylex.props(styles.statusOutput, styles.mutedForeground)}
        >
          {shownStatusMsg}
        </output>
      </Collapse>
    </div>
  )
}
