import { useEffect, useRef, useState } from 'preact/hooks'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '@/theme/tokens.stylex'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { FieldDescription } from '@/components/ui/field'
import { PanelHeader, Section } from '../ui'
import { EraserIcon, iconSize } from '@/components/icons'
import {
  fetchCaptureSummary,
  runCaptureExport,
  type CaptureExportKind,
  type CaptureSummary,
} from '@/components/capture-export'
import {
  plural,
  fmtDay,
  confirmEraseArchiveCopy,
  erasedArchiveCopy,
} from '@/components/capture-copy'
import { ConfirmStrip } from '@/components/confirm-strip'

// The archive browser loads the newest ARCHIVE_FETCH_LIMIT conversations in one
// message and pages through them client-side — no per-click round-trips. Archives
// beyond the cap stay reachable via "Export all (JSONL)"; a caption says so.
const ARCHIVE_FETCH_LIMIT = 1000
const PAGE_SIZE = 20
const PAGE_STEP = 50

const HOVER = '@media (hover: hover)'

const styles = stylex.create({
  minH10: { minHeight: '2.5rem' },
  selfStart: { alignSelf: 'flex-start' },
  text13: { fontSize: '13px' },
  searchRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.75rem' },
  searchInput: { minWidth: '12rem', flex: 1 },
  countLabel: {
    flexShrink: 0,
    fontFamily: tokens['--font-mono'],
    fontSize: '0.75rem',
    lineHeight: tokens['--text-xs--line-height'],
    fontVariantNumeric: 'tabular-nums',
    color: tokens['--muted-foreground'],
  },
  list: { display: 'grid', gap: 0 },
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.75rem',
    paddingBlock: '0.625rem',
    paddingTop: { default: null, ':first-child': 0 },
    paddingBottom: { default: null, ':last-child': 0 },
    fontSize: '0.875rem',
    lineHeight: tokens['--text-sm--line-height'],
  },
  infoCol: { display: 'grid', minWidth: 0, gap: '0.125rem' },
  truncate: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  handle: { fontWeight: 500 },
  metaInline: {
    fontFamily: tokens['--font-mono'],
    fontVariantNumeric: 'tabular-nums',
    color: tokens['--muted-foreground'],
  },
  rootTextTruncate: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: tokens['--muted-foreground'],
  },
  actionsRow: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: '0.375rem',
    fontSize: '0.75rem',
    lineHeight: tokens['--text-xs--line-height'],
  },
  // Shared focus-ring fragment for the raw text-link buttons on this surface
  // (JSON / Markdown / Export all / Erase archive) — audit finding 10: keep the
  // bare-link register, just make it focusable/visible. No `active:scale` here
  // (adjudicated: scaling plain underlined text on a full page reads as broken).
  // These raw buttons carry no `data-slot`, so unlike the vendored Button they
  // get no transition declarations at all.
  linkFocus: {
    borderRadius: 'calc(var(--radius) - 4px)',
    outlineStyle: 'none',
    boxShadow: {
      default: null,
      ':focus-visible':
        '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent), 0 0 #0000',
    },
  },
  linkPrimary: {
    color: tokens['--primary'],
    textDecorationLine: { default: null, [HOVER]: { ':hover': 'underline' } },
  },
  eraseLayout: { display: 'flex', alignItems: 'center', gap: '0.375rem' },
  linkDestructive: {
    color: tokens['--destructive'],
    textDecorationLine: { default: null, [HOVER]: { ':hover': 'underline' } },
  },
  dotSeparator: { color: tokens['--muted-foreground'] },
  textPretty: { textWrap: 'pretty' },
  monoNums: { fontFamily: tokens['--font-mono'], fontVariantNumeric: 'tabular-nums' },
  monoNumsPretty: {
    fontFamily: tokens['--font-mono'],
    fontVariantNumeric: 'tabular-nums',
    textWrap: 'pretty',
  },
  exportRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '1rem' },
  status: {
    display: 'block',
    textWrap: 'pretty',
    fontSize: '0.875rem',
    lineHeight: tokens['--text-sm--line-height'],
    color: tokens['--muted-foreground'],
  },
})

// Takes no PanelProps — the archive is a pure data browser, not a setting; it
// only talks to the extension worker for its own summary/export/erase messages.
export function ArchivePanel() {
  const [summary, setSummary] = useState<CaptureSummary | null>(null)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [visible, setVisible] = useState(PAGE_SIZE)
  // One owned status-flash timer: a newer flash cancels the older timer before
  // rearming, and unmount cancels whatever is pending.
  const statusTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    return () => clearTimeout(statusTimer.current)
  }, [])

  const refreshSummary = (): void => void fetchCaptureSummary(ARCHIVE_FETCH_LIMIT).then(setSummary)
  useEffect(refreshSummary, [])

  const flashStatus = (msg: string): void => {
    setStatusMsg(msg)
    clearTimeout(statusTimer.current)
    statusTimer.current = setTimeout(() => {
      setStatusMsg(null)
      statusTimer.current = undefined
    }, 5000)
  }

  const doExport = async (kind: CaptureExportKind, conversationId?: string): Promise<void> => {
    const outcome = await runCaptureExport(kind, conversationId)
    flashStatus(outcome.detail)
  }

  const eraseArchive = async (): Promise<void> => {
    const tweets = summary?.tweets ?? 0
    await browser.runtime.sendMessage({ _tag: 'ClearCaptureRequest' }).catch(() => {})
    setSummary({ tweets: 0, conversations: 0, recent: [] })
    setQuery('')
    setVisible(PAGE_SIZE)
    flashStatus(erasedArchiveCopy(tweets))
  }

  const loaded = summary?.recent ?? []
  const conversations = summary?.conversations ?? 0

  const needle = query.trim().toLowerCase()
  const matches =
    needle === ''
      ? loaded
      : loaded.filter((c) => `@${c.rootHandle} ${c.rootText}`.toLowerCase().includes(needle))
  const shown = matches.slice(0, visible)
  const remaining = matches.length - shown.length

  return (
    <>
      <PanelHeader
        title="Archive"
        description="Everything captured so far — browse conversations, export them, or wipe the archive."
      />

      <Section
        title="Conversations"
        description="Search by handle or text, export a tree or Markdown copy of any conversation, or pull everything as JSONL."
        action={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            sx={styles.minH10}
            onClick={refreshSummary}
          >
            Refresh
          </Button>
        }
      >
        <div {...stylex.props(styles.searchRow)}>
          <Input
            type="search"
            aria-label="Search handles and text"
            placeholder="Search handles and text…"
            value={query}
            onInput={(e: Event) => {
              setQuery((e.target as HTMLInputElement).value)
              setVisible(PAGE_SIZE)
            }}
            sx={styles.searchInput}
          />
          <span {...stylex.props(styles.countLabel)}>
            {plural(summary?.tweets ?? 0, 'tweet')} · {plural(conversations, 'conversation')}
          </span>
        </div>

        {summary === null ? (
          <FieldDescription>Loading…</FieldDescription>
        ) : shown.length > 0 ? (
          <ol {...stylex.props(styles.list)} data-xmd-divide="" aria-label="Captured conversations">
            {shown.map((c) => (
              <li key={c.conversationId} {...stylex.props(styles.row)}>
                <div {...stylex.props(styles.infoCol)}>
                  <span {...stylex.props(styles.truncate)}>
                    <span {...stylex.props(styles.handle)}>@{c.rootHandle}</span>
                    <span {...stylex.props(styles.metaInline)}>
                      {' '}
                      · {plural(c.count, 'tweet')} · {fmtDay(c.lastAt)}
                    </span>
                  </span>
                  <span {...stylex.props(styles.rootTextTruncate)}>{c.rootText}</span>
                </div>
                <div {...stylex.props(styles.actionsRow)}>
                  <button
                    type="button"
                    aria-label={`Export conversation by @${c.rootHandle} as JSON`}
                    {...stylex.props(styles.linkFocus, styles.linkPrimary)}
                    onClick={() => void doExport('tree', c.conversationId)}
                  >
                    JSON
                  </button>
                  <span aria-hidden="true" {...stylex.props(styles.dotSeparator)}>
                    ·
                  </span>
                  <button
                    type="button"
                    aria-label={`Export conversation by @${c.rootHandle} as Markdown`}
                    {...stylex.props(styles.linkFocus, styles.linkPrimary)}
                    onClick={() => void doExport('markdown', c.conversationId)}
                  >
                    Markdown
                  </button>
                </div>
              </li>
            ))}
          </ol>
        ) : loaded.length > 0 ? (
          <FieldDescription sx={styles.textPretty}>
            No conversations match “{query.trim()}”.
          </FieldDescription>
        ) : (
          <FieldDescription sx={styles.textPretty}>
            Nothing captured yet. Turn on Capture tweets and browse X.
          </FieldDescription>
        )}

        {remaining > 0 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            sx={[styles.minH10, styles.selfStart]}
            onClick={() => setVisible((v) => v + PAGE_STEP)}
          >
            Show <span {...stylex.props(styles.monoNums)}>{Math.min(PAGE_STEP, remaining)}</span>{' '}
            more
            <span {...stylex.props(styles.monoNums)}>({remaining} remaining)</span>
          </Button>
        )}
        {conversations > loaded.length && (
          <FieldDescription sx={styles.monoNumsPretty}>
            Showing the newest {loaded.length} of {conversations} conversations — Export all (JSONL)
            includes everything.
          </FieldDescription>
        )}

        <div {...stylex.props(styles.exportRow)}>
          <button
            type="button"
            {...stylex.props(styles.linkFocus, styles.linkPrimary, styles.selfStart, styles.text13)}
            onClick={() => void doExport('jsonl')}
          >
            Export all · JSONL
          </button>
        </div>

        <ConfirmStrip
          sentence={confirmEraseArchiveCopy(summary?.tweets ?? 0)}
          confirmLabel="Erase the archive"
          kind="one-shot"
          onConfirm={() => void eraseArchive()}
        >
          {(arm) => (
            <button
              type="button"
              {...stylex.props(
                styles.linkFocus,
                styles.eraseLayout,
                styles.text13,
                styles.linkDestructive,
              )}
              onClick={arm}
            >
              <EraserIcon sx={iconSize.s35} />
              Erase archive…
            </button>
          )}
        </ConfirmStrip>

        <output aria-live="polite" aria-atomic="true" {...stylex.props(styles.status)}>
          {statusMsg}
        </output>
      </Section>
    </>
  )
}
