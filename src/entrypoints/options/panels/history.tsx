import { useEffect, useState } from 'preact/hooks'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '@/theme/tokens.stylex'
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

const HOVER = '@media (hover: hover)'
const RING_FOCUS_VISIBLE =
  '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent), 0 0 #0000'

const styles = stylex.create({
  // grid gap-1.5
  authorGroup: {
    display: 'grid',
    gap: '0.375rem',
  },
  // text-xs font-semibold text-muted-foreground
  authorHandle: {
    fontSize: '0.75rem',
    lineHeight: tokens['--text-xs--line-height'],
    fontWeight: 600,
    color: tokens['--muted-foreground'],
  },
  // grid gap-1
  recordList: {
    display: 'grid',
    gap: '0.25rem',
  },
  // flex items-center gap-2 text-sm
  recordRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    fontSize: '0.875rem',
    lineHeight: tokens['--text-sm--line-height'],
  },
  // shrink-0 capitalize
  statusBadge: {
    flexShrink: 0,
    textTransform: 'capitalize',
  },
  // truncate rounded-sm text-muted-foreground outline-none
  // hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50
  recordLink: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    borderRadius: 'calc(var(--radius) - 4px)',
    color: { default: tokens['--muted-foreground'], [HOVER]: { ':hover': tokens['--foreground'] } },
    outlineStyle: 'none',
    boxShadow: { default: null, ':focus-visible': RING_FOCUS_VISIBLE },
  },
  // self-start rounded-sm text-[13px] text-destructive outline-none
  // hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 (no data-slot)
  eraseButton: {
    alignSelf: 'flex-start',
    borderRadius: 'calc(var(--radius) - 4px)',
    fontSize: '13px',
    color: tokens['--destructive'],
    outlineStyle: 'none',
    textDecorationLine: { default: null, [HOVER]: { ':hover': 'underline' } },
    boxShadow: { default: null, ':focus-visible': RING_FOCUS_VISIBLE },
  },
  // text-pretty
  emptyDescription: {
    textWrap: 'pretty',
  },
})

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
            checked={settings.downloadHistoryEnabled}
            onCheckedChange={(checked: boolean) => void update({ downloadHistoryEnabled: checked })}
          />
        </Field>

        {settings.downloadHistoryEnabled && history.length > 0 ? (
          <>
            {groupByAuthor(history).map((group) => (
              <div key={group.handle} {...stylex.props(styles.authorGroup)}>
                <span {...stylex.props(styles.authorHandle)}>@{group.handle}</span>
                <ol
                  {...stylex.props(styles.recordList)}
                  aria-label={`Downloads for ${group.handle}`}
                >
                  {group.records.map((r) => {
                    const f = formatRecord(r)
                    const variant =
                      f.status === 'completed'
                        ? 'success'
                        : f.status === 'failed'
                          ? 'destructive'
                          : 'outline'
                    return (
                      <li key={r.requestId} {...stylex.props(styles.recordRow)}>
                        <Badge variant={variant} sx={styles.statusBadge}>
                          {f.status}
                        </Badge>
                        <a
                          {...stylex.props(styles.recordLink)}
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
                <button type="button" {...stylex.props(styles.eraseButton)} onClick={arm}>
                  Erase history…
                </button>
              )}
            </ConfirmStrip>
          </>
        ) : (
          <FieldDescription sx={styles.emptyDescription}>
            {historyEmptyLabel(settings.downloadHistoryEnabled, history.length)}
          </FieldDescription>
        )}
      </Section>
    </>
  )
}
