import { useEffect, useRef, useState } from 'preact/hooks'
import { cn } from '@/lib/utils'
import { EraserIcon } from '@/components/icons'
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

// Invisible hit-slop for the compact JSON/Markdown/Export-all/Erase text-links
// (spec §2.8) — matches the Switch idiom's after:-inset-y-3.
const LINK_SLOP =
  'relative rounded-sm outline-none transition-colors after:absolute after:-inset-x-1 after:-inset-y-3 focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-[0.97]'

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
                  onClick={arm}
                >
                  <EraserIcon className="size-3.5" />
                  Erase archive…
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
