import { useEffect, useState } from 'preact/hooks'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { PanelHeader, SettingGroup, type PanelProps } from '../ui'
import { LayersIcon, DownloadIcon, EraserIcon } from '@/components/icons'
import {
  fetchCaptureSummary,
  runCaptureExport,
  type CaptureExportKind,
  type CaptureSummary,
} from '@/components/capture-export'

// The archive browser loads the newest ARCHIVE_FETCH_LIMIT conversations in one
// message and pages through them client-side — no per-click round-trips. Archives
// beyond the cap stay reachable via "Export all (JSONL)"; a caption says so.
const ARCHIVE_FETCH_LIMIT = 1000
const PAGE_SIZE = 20
const PAGE_STEP = 50

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`

const fmtDay = (ms: number): string =>
  new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

export function CapturePanel({ settings, update }: PanelProps) {
  const [summary, setSummary] = useState<CaptureSummary | null>(null)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [visible, setVisible] = useState(PAGE_SIZE)

  const refreshSummary = (): void => void fetchCaptureSummary(ARCHIVE_FETCH_LIMIT).then(setSummary)
  useEffect(refreshSummary, [])

  const flashStatus = (msg: string): void => {
    setStatusMsg(msg)
    setTimeout(() => setStatusMsg(null), 5000)
  }

  const doExport = async (kind: CaptureExportKind, conversationId?: string): Promise<void> => {
    const outcome = await runCaptureExport(kind, conversationId)
    flashStatus(outcome.detail)
  }

  const clearArchive = async (): Promise<void> => {
    const tweets = summary?.tweets ?? 0
    if (!confirm(`Delete all ${plural(tweets, 'captured tweet')}? This cannot be undone.`)) return
    await browser.runtime.sendMessage({ _tag: 'ClearCaptureRequest' }).catch(() => {})
    setSummary({ tweets: 0, conversations: 0, recent: [] })
    setQuery('')
    setVisible(PAGE_SIZE)
    flashStatus(`Cleared ${plural(tweets, 'tweet')} from the archive.`)
  }

  const syncConfigured = settings.convexUrl !== '' && settings.convexSyncSecret !== ''
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
        title="Knowledge Capture"
        description="Capture the text and metadata of tweets you scroll past into a local, searchable archive — export as JSONL, conversation trees, or Markdown."
      />

      <SettingGroup
        title="Capture"
        description="Off by default. When on, tweet text and metadata are saved locally as you browse — no file bytes, no network."
        icon={<LayersIcon className="size-[18px]" />}
      >
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="captureEnabled">Capture tweets</FieldLabel>
            <FieldDescription>Save the text and metadata of tweets you view</FieldDescription>
          </FieldContent>
          <Switch
            id="captureEnabled"
            aria-label="Capture tweets"
            checked={settings.captureEnabled}
            onCheckedChange={(checked: boolean) => void update({ captureEnabled: checked })}
          />
        </Field>

        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="captureAllScrolled">Capture everything scrolled</FieldLabel>
            <FieldDescription>
              Capture every tweet on the timeline, not only ones you act on
            </FieldDescription>
          </FieldContent>
          <Switch
            id="captureAllScrolled"
            aria-label="Capture everything scrolled"
            disabled={!settings.captureEnabled}
            checked={settings.captureAllScrolled}
            onCheckedChange={(checked: boolean) => void update({ captureAllScrolled: checked })}
          />
        </Field>

        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="captureMirrorEnabled">Mirror to Convex</FieldLabel>
            <FieldDescription>
              {syncConfigured
                ? 'Also mirror captured tweets to your Convex deployment'
                : 'Configure Cloud sync first — meaningful only with Convex set up'}
            </FieldDescription>
          </FieldContent>
          <Switch
            id="captureMirrorEnabled"
            aria-label="Mirror to Convex"
            disabled={!syncConfigured}
            checked={settings.captureMirrorEnabled}
            onCheckedChange={(checked: boolean) => void update({ captureMirrorEnabled: checked })}
          />
        </Field>
      </SettingGroup>

      <SettingGroup
        title="Archive"
        description="Everything captured so far — browse conversations, export them, or wipe the archive."
        icon={<DownloadIcon className="size-[18px]" />}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{plural(summary?.tweets ?? 0, 'tweet')}</Badge>
          <Badge variant="outline">{plural(conversations, 'conversation')}</Badge>
          <Button type="button" variant="ghost" size="sm" onClick={refreshSummary}>
            Refresh
          </Button>
        </div>

        {loaded.length > 0 && (
          <Input
            type="search"
            aria-label="Filter conversations"
            placeholder="Filter by @handle or text…"
            value={query}
            onInput={(e: Event) => {
              setQuery((e.target as HTMLInputElement).value)
              setVisible(PAGE_SIZE)
            }}
          />
        )}

        {shown.length > 0 ? (
          <ol className="grid gap-1.5" aria-label="Captured conversations">
            {shown.map((c) => (
              <li
                key={c.conversationId}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <div className="grid min-w-0 gap-0.5">
                  <span className="truncate">
                    <span className="font-medium">@{c.rootHandle}</span>
                    <span className="text-muted-foreground">
                      {' '}
                      · {plural(c.count, 'tweet')} · {fmtDay(c.lastAt)}
                    </span>
                  </span>
                  <span className="truncate text-muted-foreground">{c.rootText}</span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void doExport('tree', c.conversationId)}
                  >
                    Export JSON
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void doExport('markdown', c.conversationId)}
                  >
                    Export Markdown
                  </Button>
                </div>
              </li>
            ))}
          </ol>
        ) : loaded.length > 0 ? (
          <FieldDescription>No conversations match “{query.trim()}”.</FieldDescription>
        ) : (
          <FieldDescription>
            Nothing captured yet. Turn on Capture tweets and browse X.
          </FieldDescription>
        )}

        {remaining > 0 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => setVisible((v) => v + PAGE_STEP)}
          >
            Show {Math.min(PAGE_STEP, remaining)} more ({remaining} remaining)
          </Button>
        )}
        {conversations > loaded.length && (
          <FieldDescription>
            Showing the newest {loaded.length} of {conversations} conversations — Export all (JSONL)
            includes everything.
          </FieldDescription>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => void doExport('jsonl')}
          >
            Export all (JSONL)
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start text-destructive hover:text-destructive"
            onClick={() => void clearArchive()}
          >
            <EraserIcon className="size-4" />
            Clear archive…
          </Button>
        </div>

        <div aria-live="polite">
          {statusMsg && <FieldDescription>{statusMsg}</FieldDescription>}
        </div>
      </SettingGroup>
    </>
  )
}
