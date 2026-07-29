import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { FieldDescription } from '@/components/ui/field'
import { PanelHeader, Section } from '../ui'
import { EraserIcon } from '@/components/icons'
import {
  fetchCaptureSummary,
  runCaptureExport,
  type CaptureExportKind,
  type CaptureSummaryResult,
} from '@/components/capture-export'
import { requestCaptureErase } from '@/core/capture/client'
import {
  plural,
  fmtDay,
  confirmEraseArchiveCopy,
  erasedArchiveCopy,
  eraseArchiveFailedCopy,
} from '@/components/capture-copy'
import { ConfirmStrip } from '@/components/confirm-strip'
import { useAsyncAuthority } from '@/components/use-async-authority'

// The archive browser loads the newest ARCHIVE_FETCH_LIMIT conversations in one
// message and pages through them client-side — no per-click round-trips. Archives
// beyond the cap stay reachable via "Export all (JSONL)"; a caption says so.
const ARCHIVE_FETCH_LIMIT = 1000
const PAGE_SIZE = 20
const PAGE_STEP = 50

// Shared focus-ring fragment for the raw text-link buttons on this surface
// (JSON / Markdown / Export all / Erase archive) — audit finding 10: keep the
// bare-link register, just make it focusable/visible. No `active:scale` here
// (adjudicated: scaling plain underlined text on a full page reads as broken).
const LINK_FOCUS = 'rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50'

// Takes no PanelProps — the archive is a pure data browser, not a setting; it
// only talks to the extension worker for its own summary/export/erase messages.
export function ArchivePanel() {
  const [summaryResult, setSummary] = useState<CaptureSummaryResult | null>(null)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [visible, setVisible] = useState(PAGE_SIZE)
  const [erasing, setErasing] = useState(false)
  const erasePending = useRef(false)
  const statusTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const refreshAuthority = useAsyncAuthority()
  const statusAuthority = useAsyncAuthority()

  useEffect(() => {
    return () => {
      if (statusTimer.current !== undefined) clearTimeout(statusTimer.current)
    }
  }, [])

  const refreshSummary = useCallback((): void => {
    const generation = refreshAuthority.begin()
    setSummary(null)
    void fetchCaptureSummary(ARCHIVE_FETCH_LIMIT).then((result) => {
      if (refreshAuthority.isCurrent(generation)) setSummary(result)
      return undefined
    })
  }, [refreshAuthority])
  useEffect(() => {
    refreshSummary()
  }, [refreshSummary])

  const flashStatus = (epoch: number, msg: string): void => {
    if (!statusAuthority.isCurrent(epoch)) return
    if (statusTimer.current !== undefined) clearTimeout(statusTimer.current)
    setStatusMsg(msg)
    statusTimer.current = setTimeout(() => {
      if (!statusAuthority.isCurrent(epoch)) return
      statusTimer.current = undefined
      setStatusMsg(null)
    }, 5000)
  }

  const doExport = async (kind: CaptureExportKind, conversationId?: string): Promise<void> => {
    const epoch = statusAuthority.begin()
    const outcome = await runCaptureExport(kind, conversationId)
    flashStatus(epoch, outcome.detail)
  }

  const eraseArchive = async (): Promise<void> => {
    if (erasePending.current) return
    erasePending.current = true
    const epoch = statusAuthority.begin()
    setErasing(true)
    try {
      const outcome = await requestCaptureErase((request) => browser.runtime.sendMessage(request))
      if (!statusAuthority.isMounted()) return
      if (outcome.ok) {
        // A pre-erase refresh can resolve after this acknowledgement. Its snapshot
        // must never resurrect data the background has already removed.
        refreshAuthority.invalidate()
        setSummary({ status: 'available', summary: { tweets: 0, conversations: 0, recent: [] } })
        setQuery('')
        setVisible(PAGE_SIZE)
        flashStatus(epoch, erasedArchiveCopy(outcome.cleared))
      } else {
        flashStatus(epoch, eraseArchiveFailedCopy())
      }
    } finally {
      erasePending.current = false
      if (statusAuthority.isMounted()) setErasing(false)
    }
  }

  const summary = summaryResult?.status === 'available' ? summaryResult.summary : null
  const available = summary !== null
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
            className="min-h-10"
            onClick={refreshSummary}
          >
            Refresh
          </Button>
        }
      >
        <div className="flex flex-wrap items-center gap-3">
          <Input
            type="search"
            aria-label="Search handles and text"
            placeholder="Search handles and text…"
            value={query}
            disabled={!available}
            onInput={(e: Event) => {
              setQuery((e.target as HTMLInputElement).value)
              setVisible(PAGE_SIZE)
            }}
            className="min-w-[12rem] flex-1"
          />
          <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
            {available
              ? `${plural(summary.tweets, 'tweet')} · ${plural(conversations, 'conversation')}`
              : '—'}
          </span>
        </div>

        {summaryResult === null ? (
          <FieldDescription>Loading archive…</FieldDescription>
        ) : !available ? (
          <FieldDescription>Archive unavailable. Refresh to try again.</FieldDescription>
        ) : shown.length > 0 ? (
          <ol className="grid gap-0 divide-y divide-border" aria-label="Captured conversations">
            {shown.map((c) => (
              <li
                key={c.conversationId}
                className="flex items-center justify-between gap-3 py-2.5 text-sm first:pt-0 last:pb-0"
              >
                <div className="grid min-w-0 gap-0.5">
                  <span className="truncate">
                    <span className="font-medium">@{c.rootHandle}</span>
                    <span className="font-mono tabular-nums text-muted-foreground">
                      {' '}
                      · {plural(c.count, 'tweet')} · {fmtDay(c.lastAt)}
                    </span>
                  </span>
                  <span className="truncate text-muted-foreground">{c.rootText}</span>
                </div>
                <div className="flex shrink-0 items-center gap-1.5 text-xs">
                  <button
                    type="button"
                    className={`text-primary hover:underline ${LINK_FOCUS}`}
                    onClick={() => void doExport('tree', c.conversationId)}
                  >
                    JSON
                  </button>
                  <span aria-hidden="true" className="text-muted-foreground">
                    ·
                  </span>
                  <button
                    type="button"
                    className={`text-primary hover:underline ${LINK_FOCUS}`}
                    onClick={() => void doExport('markdown', c.conversationId)}
                  >
                    Markdown
                  </button>
                </div>
              </li>
            ))}
          </ol>
        ) : loaded.length > 0 ? (
          <FieldDescription className="text-pretty">
            No conversations match “{query.trim()}”.
          </FieldDescription>
        ) : (
          <FieldDescription className="text-pretty">
            Nothing captured yet. Turn on Capture tweets and browse X.
          </FieldDescription>
        )}

        {remaining > 0 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-10 self-start"
            onClick={() => setVisible((v) => v + PAGE_STEP)}
          >
            Show <span className="font-mono tabular-nums">{Math.min(PAGE_STEP, remaining)}</span>{' '}
            more
            <span className="font-mono tabular-nums">({remaining} remaining)</span>
          </Button>
        )}
        {conversations > loaded.length && (
          <FieldDescription className="font-mono tabular-nums text-pretty">
            Showing the newest {loaded.length} of {conversations} conversations — Export all (JSONL)
            includes everything.
          </FieldDescription>
        )}

        <div className="flex flex-wrap items-center gap-4">
          <button
            type="button"
            className={`self-start text-[13px] text-primary hover:underline ${LINK_FOCUS}`}
            disabled={!available}
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
              className={`flex items-center gap-1.5 text-[13px] text-destructive hover:underline ${LINK_FOCUS}`}
              disabled={!available || erasing}
              onClick={!available || erasing ? undefined : arm}
            >
              <EraserIcon className="size-3.5" />
              {erasing ? 'Erasing archive…' : 'Erase archive…'}
            </button>
          )}
        </ConfirmStrip>

        <div aria-live="polite">
          {statusMsg && <FieldDescription>{statusMsg}</FieldDescription>}
        </div>
      </Section>
    </>
  )
}
