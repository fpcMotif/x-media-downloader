import { useEffect, useRef, useState } from 'preact/hooks'
import { cn } from '@/lib/utils'
import { EraserIcon } from '@/components/icons'
import { runCaptureExport, type CaptureSummaryResult } from '@/components/capture-export'
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

// Keep this in sync with useCaptureSummary's eager three-row read. Slicing here
// is a defensive no-op, not a real pagination cut.
const RECENT_LIMIT = 3

// Invisible hit-slop for the compact JSON/Markdown/Export-all/Erase text-links
// (spec §2.8) — matches the Switch idiom's after:-inset-y-3.
const LINK_SLOP =
  'relative rounded-sm outline-none transition-colors after:absolute after:-inset-x-1 after:-inset-y-3 focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-[0.97]'

interface CaptureQuickActionsProps {
  readonly summary: CaptureSummaryResult | null
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
  const [erasing, setErasing] = useState(false)
  const erasePending = useRef(false)
  const statusTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const statusAuthority = useAsyncAuthority()

  useEffect(() => {
    return () => {
      if (statusTimer.current !== undefined) clearTimeout(statusTimer.current)
    }
  }, [])

  const capture = summary?.status === 'available' ? summary.summary : null
  const tweets = capture?.tweets ?? 0
  // A successful erase zeroes the parent's captureSummary synchronously in
  // the same batch that sets statusMsg below — an early return on tweets===0
  // alone would unmount this block before its own flash ever painted. Stay
  // mounted while a flash is pending; its own timeout (flashStatus) clears it.
  if (summary === null)
    return (
      <p className="border-t border-border px-3.5 py-4 text-xs text-muted-foreground">
        Archive loading…
      </p>
    )
  if (summary.status === 'unavailable')
    return (
      <p className="border-t border-border px-3.5 py-4 text-xs text-muted-foreground">
        Archive unavailable.
      </p>
    )
  if (tweets === 0 && statusMsg === null) return null

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

  const exportAll = async (): Promise<void> => {
    const epoch = statusAuthority.begin()
    const outcome = await runCaptureExport('jsonl')
    flashStatus(epoch, outcome.detail)
  }

  const exportConversation = async (
    kind: 'tree' | 'markdown',
    conversationId: string,
  ): Promise<void> => {
    const epoch = statusAuthority.begin()
    const outcome =
      kind === 'tree'
        ? await runCaptureExport('tree', conversationId)
        : await runCaptureExport('markdown', conversationId)
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
        onCleared()
        flashStatus(epoch, erasedArchiveCopy(outcome.cleared))
      } else {
        flashStatus(epoch, eraseArchiveFailedCopy())
      }
    } finally {
      erasePending.current = false
      if (statusAuthority.isMounted()) setErasing(false)
    }
  }

  const recent = capture?.recent.slice(0, RECENT_LIMIT) ?? []

  return (
    <div className="grid gap-2 border-t border-border px-3.5 py-4">
      <button
        type="button"
        data-slot="button"
        className="flex min-h-10 items-center justify-between rounded-[var(--xmd-radius-3)] text-xs font-medium text-foreground/80 outline-none transition-colors hover:text-foreground active:scale-[0.97] focus-visible:ring-3 focus-visible:ring-ring/50"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        Recent
        <span aria-hidden="true" className="relative inline-grid size-3 place-items-center">
          <span
            className={cn(
              'col-start-1 row-start-1 transition-[opacity,transform] duration-[180ms] ease-[var(--xmd-ease)]',
              open ? 'scale-100 opacity-100' : 'scale-90 opacity-0',
            )}
          >
            ⌃
          </span>
          <span
            className={cn(
              'col-start-1 row-start-1 transition-[opacity,transform] duration-[180ms] ease-[var(--xmd-ease)]',
              open ? 'scale-90 opacity-0' : 'scale-100 opacity-100',
            )}
          >
            ⌄
          </span>
        </span>
      </button>

      {open && (
        <div className="animate-in fade-in slide-in-from-top-1 grid gap-2.5 duration-[220ms] ease-[var(--xmd-ease)]">
          {recent.length > 0 ? (
            <ol className="grid gap-2" aria-label="Recently captured conversations">
              {recent.map((c) => (
                <li key={c.conversationId} className="grid gap-0.5 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate">
                      <span className="font-medium">@{c.rootHandle}</span>
                      <span className="font-mono tabular-nums text-muted-foreground">
                        {' '}
                        · {plural(c.count, 'tweet')} · {fmtDay(c.lastAt)}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        data-slot="button"
                        className={cn('text-primary hover:underline', LINK_SLOP)}
                        onClick={() => void exportConversation('tree', c.conversationId)}
                      >
                        JSON
                      </button>
                      <span aria-hidden="true" className="text-muted-foreground">
                        ·
                      </span>
                      <button
                        type="button"
                        data-slot="button"
                        className={cn('text-primary hover:underline', LINK_SLOP)}
                        onClick={() => void exportConversation('markdown', c.conversationId)}
                      >
                        Markdown
                      </button>
                    </span>
                  </div>
                  <span className="truncate text-muted-foreground">{c.rootText}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-xs text-muted-foreground">Nothing captured yet.</p>
          )}

          <div className="grid gap-2">
            <button
              type="button"
              data-slot="button"
              className={cn(
                'justify-self-start text-xs font-medium text-primary hover:underline',
                LINK_SLOP,
              )}
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
                  className={cn(
                    'flex items-center justify-self-start gap-1 text-xs font-medium text-destructive hover:underline',
                    LINK_SLOP,
                  )}
                  disabled={erasing}
                  onClick={erasing ? undefined : arm}
                >
                  <EraserIcon className="size-3.5" />
                  {erasing ? 'Erasing archive…' : 'Erase archive…'}
                </button>
              )}
            </ConfirmStrip>
          </div>

          {statusMsg && (
            <p
              aria-live="polite"
              className="text-pretty text-xs leading-snug text-muted-foreground"
            >
              {statusMsg}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
