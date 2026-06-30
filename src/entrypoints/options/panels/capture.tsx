import { useEffect, useState } from 'preact/hooks'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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

export function CapturePanel({ settings, update }: PanelProps) {
  const [summary, setSummary] = useState<CaptureSummary | null>(null)
  const [exportMsg, setExportMsg] = useState<string | null>(null)

  const refreshSummary = (): void => void fetchCaptureSummary().then(setSummary)
  useEffect(refreshSummary, [])

  const doExport = async (kind: CaptureExportKind, conversationId?: string): Promise<void> => {
    const outcome = await runCaptureExport(kind, conversationId)
    setExportMsg(outcome.detail)
    setTimeout(() => setExportMsg(null), 5000)
  }

  const clearHarvest = async (): Promise<void> => {
    await browser.runtime.sendMessage({ _tag: 'ClearCaptureRequest' }).catch(() => {})
    setSummary({ tweets: 0, conversations: 0, recent: [] })
    setExportMsg(null)
  }

  const syncConfigured = settings.convexUrl !== '' && settings.convexSyncSecret !== ''
  const recent = summary?.recent ?? []

  return (
    <>
      <PanelHeader
        title="Knowledge Capture"
        description="Harvest the text and metadata of tweets you scroll past into a local, searchable archive — exportable as JSONL, conversation trees, or Markdown."
      />

      <SettingGroup
        title="Capture"
        description="Off by default. When on, tweet text and metadata are saved locally as you browse — no file bytes, no network."
        icon={<LayersIcon className="size-[18px]" />}
      >
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="captureEnabled">Harvest tweets</FieldLabel>
            <FieldDescription>Save the text and metadata of tweets you view</FieldDescription>
          </FieldContent>
          <Switch
            id="captureEnabled"
            aria-label="Harvest tweets"
            checked={settings.captureEnabled}
            onCheckedChange={(checked: boolean) => void update({ captureEnabled: checked })}
          />
        </Field>

        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="captureAllScrolled">Capture everything scrolled</FieldLabel>
            <FieldDescription>
              Harvest every tweet on the timeline, not only ones you act on
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
        title="Harvest"
        description="What's in your local archive, and how to take it with you."
        icon={<DownloadIcon className="size-[18px]" />}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{summary?.tweets ?? 0} tweets</Badge>
          <Badge variant="outline">{summary?.conversations ?? 0} conversations</Badge>
          <Button type="button" variant="ghost" size="sm" onClick={refreshSummary}>
            Refresh
          </Button>
        </div>

        {recent.length > 0 ? (
          <ol className="grid gap-1.5" aria-label="Recent conversations">
            {recent.map((c) => (
              <li
                key={c.conversationId}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <div className="grid min-w-0 gap-0.5">
                  <span className="truncate font-medium">@{c.rootHandle}</span>
                  <span className="truncate text-muted-foreground">{c.rootText}</span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void doExport('tree', c.conversationId)}
                  >
                    Export tree
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
        ) : (
          <FieldDescription>
            Nothing harvested yet. Turn on Harvest tweets and browse X.
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
            className="self-start"
            onClick={() => void clearHarvest()}
          >
            <EraserIcon className="size-4" />
            Clear harvest
          </Button>
        </div>

        {exportMsg && <FieldDescription>{exportMsg}</FieldDescription>}
      </SettingGroup>
    </>
  )
}
