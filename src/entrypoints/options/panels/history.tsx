import { useEffect, useState } from 'preact/hooks'
import type { DownloadRecord } from '@/core/history/record'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import {
  groupByAuthor,
  formatRecord,
  historyEmptyLabel,
  fetchHistory,
} from '@/entrypoints/popup/history-section'
import { PanelHeader, SettingGroup, type PanelProps } from '../ui'
import { ClockIcon } from '@/components/icons'

export function HistoryPanel({ settings, update }: PanelProps) {
  const [history, setHistory] = useState<ReadonlyArray<DownloadRecord>>([])

  useEffect(() => {
    void fetchHistory().then(setHistory)
  }, [])

  const clearHistory = async (): Promise<void> => {
    await browser.runtime.sendMessage({ _tag: 'ClearHistoryRequest' }).catch(() => {})
    setHistory([])
  }

  return (
    <>
      <PanelHeader
        title="History"
        description="A durable local record of every download — original link and status. Local only; never deletes files."
      />

      <SettingGroup
        title="Download history"
        description="Survives restarts. Independent of Cloud Sync."
        icon={<ClockIcon className="size-[18px]" />}
      >
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
                          className="truncate text-muted-foreground hover:text-foreground"
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
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => void clearHistory()}
            >
              Clear history
            </Button>
          </>
        ) : (
          <FieldDescription>
            {historyEmptyLabel(settings.downloadHistoryEnabled, history.length)}
          </FieldDescription>
        )}
      </SettingGroup>
    </>
  )
}
