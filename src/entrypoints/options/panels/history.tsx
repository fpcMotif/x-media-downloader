import { useEffect, useState } from 'preact/hooks'
import type { DownloadRecord } from '@/packages/history/record'
import { Badge } from '@/components/ui/badge'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { ConfirmStrip } from '@/components/confirm-strip'
import {
  groupByAuthor,
  formatRecord,
  historyEmptyLabel,
  confirmEraseHistoryCopy,
  fetchHistory,
} from '@/entrypoints/popup/history-section'
import { PanelHeader, Section, type PanelProps } from '../ui'

export function HistoryPanel({ settings, update }: PanelProps) {
  const [history, setHistory] = useState<ReadonlyArray<DownloadRecord>>([])

  useEffect(() => {
    void fetchHistory().then(setHistory)
  }, [])

  const eraseHistory = async (): Promise<void> => {
    await browser.runtime.sendMessage({ _tag: 'ClearHistoryRequest' }).catch(() => {})
    setHistory([])
  }

  return (
    <>
      <PanelHeader
        title="History"
        description="A durable local record of every download — original link and status. Local only; never deletes files."
      />

      <Section title="Download history" description="Survives restarts. Independent of Cloud Sync.">
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="downloadHistoryEnabled">Keep download history</FieldLabel>
            <FieldDescription>
              Persist each download's link, status, and provenance
            </FieldDescription>
          </FieldContent>
          <Switch
            id="downloadHistoryEnabled"
            aria-label="Keep download history"
            checked={settings.downloadHistoryEnabled}
            onCheckedChange={(checked: boolean) => void update({ downloadHistoryEnabled: checked })}
          />
        </Field>

        {settings.downloadHistoryEnabled && history.length > 0 ? (
          <>
            {groupByAuthor(history).map((group) => (
              <div key={group.handle} className="grid gap-1.5">
                <span className="text-xs font-semibold text-muted-foreground">@{group.handle}</span>
                <ol className="grid gap-1" aria-label={`Downloads for ${group.handle}`}>
                  {group.records.map((r) => {
                    const f = formatRecord(r)
                    const variant =
                      f.status === 'completed'
                        ? 'success'
                        : f.status === 'failed'
                          ? 'destructive'
                          : 'outline'
                    return (
                      <li key={r.requestId} className="flex items-center gap-2 text-sm">
                        <Badge variant={variant} className="shrink-0 capitalize">
                          {f.status}
                        </Badge>
                        <a
                          className="truncate rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                          href={f.link}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {f.title}
                        </a>
                      </li>
                    )
                  })}
                </ol>
              </div>
            ))}
            <ConfirmStrip
              sentence={confirmEraseHistoryCopy(history.length)}
              confirmLabel="Erase history"
              kind="one-shot"
              onConfirm={() => void eraseHistory()}
            >
              {(arm) => (
                <button
                  type="button"
                  className="self-start rounded-sm text-[13px] text-destructive outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                  onClick={arm}
                >
                  Erase history…
                </button>
              )}
            </ConfirmStrip>
          </>
        ) : (
          <FieldDescription className="text-pretty">
            {historyEmptyLabel(settings.downloadHistoryEnabled, history.length)}
          </FieldDescription>
        )}
      </Section>
    </>
  )
}
