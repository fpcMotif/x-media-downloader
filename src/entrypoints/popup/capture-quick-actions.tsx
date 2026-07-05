import { useState } from 'preact/hooks'
import { EraserIcon } from '@/components/icons'
import { runCaptureExport, type CaptureSummary } from '@/components/capture-export'
import {
  plural,
  fmtDay,
  confirmClearArchiveCopy,
  clearedArchiveCopy,
} from '@/components/capture-copy'

// Keep this in sync with the eager fetch in App.tsx (fetchCaptureSummary(3)) —
// the popup asks the background for exactly this many recent conversations, so
// slicing here is a defensive no-op, not a real pagination cut.
const RECENT_LIMIT = 3

interface CaptureQuickActionsProps {
  readonly summary: CaptureSummary | null
  /** Called after a successful clear so the parent can zero its own captureSummary
   *  state (mirrors the reset the Archive settings panel does locally). */
  readonly onCleared: () => void
}

/** Popup-sized quick actions for the harvest archive: a collapsed disclosure that,
 *  once opened, shows the most recent conversations (with per-row export links)
 *  plus a bulk "Export all" and a confirm-gated "Clear archive…" — all without
 *  leaving the popup for the full Archive settings tab. Renders nothing until
 *  something has actually been captured. */
export function CaptureQuickActions({ summary, onCleared }: CaptureQuickActionsProps) {
  const [open, setOpen] = useState(false)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)

  const tweets = summary?.tweets ?? 0
  if (tweets === 0) return null

  const flashStatus = (msg: string): void => {
    setStatusMsg(msg)
    setTimeout(() => setStatusMsg(null), 5000)
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

  // Fire-and-forget, matching the Archive settings panel's clearArchive: the
  // local reset + status message happen unconditionally, since ClearCaptureRequest
  // is a durable local wipe with no partial-failure mode worth branching on.
  const clearArchive = async (): Promise<void> => {
    if (!confirm(confirmClearArchiveCopy(tweets))) return
    await browser.runtime.sendMessage({ _tag: 'ClearCaptureRequest' }).catch(() => {})
    onCleared()
    flashStatus(clearedArchiveCopy(tweets))
  }

  const recent = (summary?.recent ?? []).slice(0, RECENT_LIMIT)

  return (
    <div className="grid gap-2 border-t border-border pt-3">
      <button
        type="button"
        className="flex items-center justify-between text-xs font-medium text-foreground/80 hover:text-foreground"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        Recent
        <span aria-hidden="true">{open ? '⌃' : '⌄'}</span>
      </button>

      {open && (
        <div className="grid gap-2.5">
          {recent.length > 0 ? (
            <ol className="grid gap-2" aria-label="Recently captured conversations">
              {recent.map((c) => (
                <li key={c.conversationId} className="grid gap-0.5 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate">
                      <span className="font-medium">@{c.rootHandle}</span>
                      <span className="font-mono text-muted-foreground">
                        {' '}
                        · {plural(c.count, 'tweet')} · {fmtDay(c.lastAt)}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        className="text-primary hover:underline"
                        onClick={() => void exportConversation('tree', c.conversationId)}
                      >
                        JSON
                      </button>
                      <span aria-hidden="true" className="text-muted-foreground">
                        ·
                      </span>
                      <button
                        type="button"
                        className="text-primary hover:underline"
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

          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              className="text-xs font-medium text-primary hover:underline"
              onClick={() => void exportAll()}
            >
              Export all · JSONL
            </button>
            <button
              type="button"
              className="flex items-center gap-1 text-xs font-medium text-destructive hover:underline"
              onClick={() => void clearArchive()}
            >
              <EraserIcon className="size-3.5" />
              Clear archive…
            </button>
          </div>

          {statusMsg && (
            <p aria-live="polite" className="text-xs leading-snug text-muted-foreground">
              {statusMsg}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
