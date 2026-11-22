import type { JSX } from 'preact'
import { useRef, useState } from 'preact/hooks'
import { Option } from 'effect'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '@/theme/tokens.stylex'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { PanelHeader, Section, type PanelProps } from '../ui'
import { EraserIcon, iconSize } from '@/components/icons'
import {
  EMPTY_CAPTURE_SUMMARY,
  fetchCaptureSearch,
  fetchCaptureSummary,
  runCaptureExport,
  type CaptureExportKind,
  type CaptureSearchResult,
  type CaptureSummary,
} from '@/components/capture-export'
import { readyOr, useLoaded } from '@/components/use-loaded'
import { plural, fmtDay, confirmEraseArchiveCopy } from '@/components/capture-copy'
import { runCaptureErase } from '@/components/capture-erase'
import { ConfirmStrip, useConfirmStrip } from '@/components/confirm-strip'
import { useOwnedTimer } from '@/components/owned-timer'

// The archive browser loads the newest ARCHIVE_FETCH_LIMIT conversations in one
// message and pages through them client-side — no per-click round-trips. Archives
// beyond the cap stay reachable via "Export all (JSONL)"; a caption says so.
const ARCHIVE_FETCH_LIMIT = 1000
const PAGE_SIZE = 20
const PAGE_STEP = 50
const SEARCH_DEBOUNCE_MS = 200

type ArchiveSearchState =
  | { readonly _tag: 'idle' }
  | { readonly _tag: 'searching' }
  | { readonly _tag: 'ready'; readonly result: CaptureSearchResult }

const HOVER = '@media (hover: hover)'

const styles = stylex.create({
  minH10: { minHeight: '2.5rem' },
  selfStart: { alignSelf: 'flex-start' },
  text13: { fontSize: '13px' },
  searchRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.75rem' },
  searchInput: { minWidth: '12rem', flex: 1 },
  countLabel: {
    flexShrink: 0,
    fontFamily: tokens['--font-sans'],
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
    fontFamily: tokens['--font-sans'],
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
  syncLink: {
    borderRadius: 'calc(var(--radius) - 4px)',
    outlineStyle: 'none',
    boxShadow: {
      default: null,
      ':focus-visible':
        '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent), 0 0 #0000',
    },
  },
  monoNums: { fontFamily: tokens['--font-mono'], fontVariantNumeric: 'tabular-nums' },
  monoNumsPretty: {
    fontFamily: tokens['--font-sans'],
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

const loadArchiveSummary = (): Promise<CaptureSummary> => fetchCaptureSummary(ARCHIVE_FETCH_LIMIT)

// Takes no PanelProps — the archive is a pure data browser, not a setting; it
// only talks to the extension worker for its own summary/export/erase messages.
export function ArchivePanel({ settings, update }: PanelProps) {
  const syncConfigured = settings.convexUrl !== '' && settings.convexSyncSecret !== ''
  const summaryLoad = useLoaded(loadArchiveSummary)
  const summary = readyOr(summaryLoad.state, EMPTY_CAPTURE_SUMMARY)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [visible, setVisible] = useState(PAGE_SIZE)
  // One owned status-flash timer: a newer flash cancels the older timer before
  // rearming, and unmount cancels whatever is pending.
  const statusTimer = useOwnedTimer()
  const eraseStrip = useConfirmStrip()
  const [searchState, setSearchState] = useState<ArchiveSearchState>({ _tag: 'idle' })
  const searchTimer = useOwnedTimer()
  const latestNeedle = useRef('')

  const searchArchive = (text: string): void => {
    const wanted = text.trim()
    latestNeedle.current = wanted
    if (wanted === '') {
      setSearchState({ _tag: 'idle' })
      searchTimer.cancel()
      return
    }
    setSearchState({ _tag: 'searching' })
    searchTimer.arm(() => {
      void (async () => {
        const result = await fetchCaptureSearch(wanted, ARCHIVE_FETCH_LIMIT)
        if (latestNeedle.current !== wanted) return
        setSearchState({
          _tag: 'ready',
          result: Option.getOrElse(result, () => ({ total: 0, matches: [] })),
        })
      })()
    }, SEARCH_DEBOUNCE_MS)
  }

  const flashStatus = (msg: string): void => {
    setStatusMsg(msg)
    statusTimer.arm(() => setStatusMsg(null), 5000)
  }

  const doExport = async (kind: CaptureExportKind, conversationId?: string): Promise<void> => {
    const outcome = await runCaptureExport(kind, conversationId)
    flashStatus(outcome.detail)
  }

  const eraseArchive = async (): Promise<void> => {
    const outcome = await runCaptureErase(summary.tweets)
    if (outcome.ok) {
      summaryLoad.setValue(EMPTY_CAPTURE_SUMMARY)
      setQuery('')
      setVisible(PAGE_SIZE)
      searchArchive('')
    }
    flashStatus(outcome.detail)
  }

  const loaded = summary.recent
  const conversations = summary.conversations

  const needle = query.trim()
  const searching = needle !== '' && searchState._tag === 'searching'
  const searchMatches = searchState._tag === 'ready' ? searchState.result.matches : []
  const matches = needle === '' ? loaded : searchMatches
  const shown = matches.slice(0, visible)
  const remaining = matches.length - shown.length

  const conversationList = (): JSX.Element | null => {
    if (summaryLoad.state._tag === 'Loading') return <FieldDescription>Loading…</FieldDescription>
    if (summaryLoad.state._tag === 'Failed') {
      return <FieldDescription>Could not load the archive. Reload this page.</FieldDescription>
    }
    if (searching) return <FieldDescription>Searching…</FieldDescription>
    if (shown.length > 0) {
      return (
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
      )
    }
    if (loaded.length > 0 || needle !== '') {
      return (
        <FieldDescription sx={styles.textPretty}>
          No conversations match “{needle}”.
        </FieldDescription>
      )
    }
    if (summary.tweets > 0) return null
    return <FieldDescription sx={styles.textPretty}>Nothing captured yet.</FieldDescription>
  }

  return (
    <>
      <PanelHeader
        title="Archive"
        description="Saves tweet text as you scroll. No files, no network."
      />

      <Section title="Capture">
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="captureEnabled">Capture tweets</FieldLabel>
          </FieldContent>
          <Switch
            id="captureEnabled"
            checked={settings.captureEnabled}
            onCheckedChange={(checked: boolean) => void update({ captureEnabled: checked })}
          />
        </Field>

        {settings.captureEnabled && (
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="captureAllScrolled">Everything you scroll</FieldLabel>
              <FieldDescription>Not only tweets you act on</FieldDescription>
            </FieldContent>
            <Switch
              id="captureAllScrolled"
              checked={settings.captureAllScrolled}
              onCheckedChange={(checked: boolean) => void update({ captureAllScrolled: checked })}
            />
          </Field>
        )}

        {settings.captureEnabled && (
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="captureMirrorEnabled">Mirror to Convex</FieldLabel>
              {!syncConfigured && (
                <FieldDescription>
                  Set up{' '}
                  <a href="#sync" {...stylex.props(styles.syncLink)}>
                    Sync ›
                  </a>{' '}
                  first
                </FieldDescription>
              )}
            </FieldContent>
            <Switch
              id="captureMirrorEnabled"
              disabled={!syncConfigured}
              checked={settings.captureMirrorEnabled}
              onCheckedChange={(checked: boolean) => void update({ captureMirrorEnabled: checked })}
            />
          </Field>
        )}
      </Section>

      <Section
        title="Conversations"
        action={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            sx={styles.minH10}
            onClick={() => {
              summaryLoad.reload()
              searchArchive(query)
            }}
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
              if (e.target instanceof HTMLInputElement) {
                setQuery(e.target.value)
                setVisible(PAGE_SIZE)
                searchArchive(e.target.value)
              }
            }}
            sx={styles.searchInput}
          />
          <span {...stylex.props(styles.countLabel)}>
            {plural(summary.tweets, 'tweet')} · {plural(conversations, 'conversation')}
          </span>
        </div>

        {conversationList()}

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
        {needle === '' && conversations > loaded.length && (
          <FieldDescription sx={styles.monoNumsPretty}>
            Showing the newest {loaded.length.toLocaleString()} of {conversations.toLocaleString()}.
            Export all includes everything.
          </FieldDescription>
        )}
        {needle !== '' &&
          searchState._tag === 'ready' &&
          searchState.result.total > searchState.result.matches.length && (
            <FieldDescription sx={styles.monoNumsPretty}>
              Showing the newest {searchState.result.matches.length.toLocaleString()} of{' '}
              {searchState.result.total.toLocaleString()} matching conversations.
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
          control={eraseStrip}
          sentence={confirmEraseArchiveCopy(summary.tweets)}
          confirmLabel="Erase the archive"
          kind="one-shot"
          onConfirm={() => void eraseArchive()}
        >
          <button
            type="button"
            {...stylex.props(
              styles.linkFocus,
              styles.eraseLayout,
              styles.text13,
              styles.linkDestructive,
            )}
            onClick={eraseStrip.arm}
          >
            <EraserIcon sx={iconSize.s35} />
            Erase archive…
          </button>
        </ConfirmStrip>

        <output aria-live="polite" aria-atomic="true" {...stylex.props(styles.status)}>
          {statusMsg}
        </output>
      </Section>
    </>
  )
}
