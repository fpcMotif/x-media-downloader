import { useEffect, useState } from 'preact/hooks'
import type { RecentConversation } from '@/core/capture/store'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { PanelHeader, SettingGroup, type PanelProps } from '../ui'
import { LayersIcon, DownloadIcon, EraserIcon } from '@/components/icons'

type CaptureSummary = {
  readonly tweets: number
  readonly conversations: number
  readonly recent: ReadonlyArray<RecentConversation>
}

const fetchSummary = (): Promise<CaptureSummary | null> =>
  browser.runtime
    .sendMessage({ _tag: 'CaptureSummaryRequest' })
    .then((s) => (s as CaptureSummary | null) ?? null)
    .catch(() => null)

// The SW builds the artifact text; we download it from THIS page (extension
// pages have a DOM + URL.createObjectURL — the SW has neither). Reliable across
// Chrome versions, unlike a SW `data:`-URL or `chrome.downloads` call.
const exportCapture = async (
  kind: 'jsonl' | 'tree' | 'markdown',
  conversationId?: string,
): Promise<void> => {
  const res = (await browser.runtime
    .sendMessage({ _tag: 'ExportCaptureRequest', kind, conversationId })
    .catch(() => null)) as { ok?: boolean; filename?: string; text?: string } | null
  if (!res?.ok || typeof res.text !== 'string' || res.text.length === 0) {
    console.warn('[XMD] capture export: nothing to download', res)
    return
  }
  const url = URL.createObjectURL(new Blob([res.text], { type: 'application/octet-stream' }))
  const a = document.createElement('a')
  a.href = url
  a.download = res.filename ?? 'harvest.jsonl'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export function CapturePanel({ settings, update }: PanelProps) {
  const [summary, setSummary] = useState<CaptureSummary | null>(null)

  useEffect(() => {
    void fetchSummary().then(setSummary)
  }, [])

  const clearHarvest = async (): Promise<void> => {
    await browser.runtime.sendMessage({ _tag: 'ClearCaptureRequest' }).catch(() => {})
    setSummary({ tweets: 0, conversations: 0, recent: [] })
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
                    onClick={() => void exportCapture('tree', c.conversationId)}
                  >
                    Export tree
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void exportCapture('markdown', c.conversationId)}
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
            onClick={() => void exportCapture('jsonl')}
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
      </SettingGroup>
    </>
  )
}
