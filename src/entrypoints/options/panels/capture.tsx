import { useEffect, useState } from 'preact/hooks'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { PanelHeader, Section, type PanelProps } from '../ui'
import { fetchCaptureSummary, type CaptureSummaryResult } from '@/components/capture-export'
import { plural } from '@/components/capture-copy'
import { useAsyncAuthority } from '@/components/use-async-authority'

export function CapturePanel({ settings, update }: PanelProps) {
  const [summary, setSummary] = useState<CaptureSummaryResult | null>(null)
  const summaryAuthority = useAsyncAuthority()

  // Counts only (limit 0) — browsing and exporting the archive itself now lives
  // on its own page; this panel only needs the numbers for its link-out.
  useEffect(() => {
    const epoch = summaryAuthority.begin()
    void (async () => {
      const next = await fetchCaptureSummary(0)
      if (summaryAuthority.isCurrent(epoch)) setSummary(next)
    })()
  }, [summaryAuthority])

  const syncConfigured = settings.convexUrl !== '' && settings.convexSyncSecret !== ''

  return (
    <>
      <PanelHeader
        title="Capture"
        description="Save the text and metadata of tweets you scroll past into a local, searchable archive — no file bytes, no network."
      />

      <Section
        title="Capture tweets"
        description="Off by default. When on, tweet text and metadata are saved locally as you browse."
      >
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="captureEnabled">Capture tweets</FieldLabel>
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
            <FieldLabel htmlFor="captureAllScrolled">Everything you scroll</FieldLabel>
            <FieldDescription>
              Capture every tweet on the timeline, not only ones you act on
            </FieldDescription>
          </FieldContent>
          <Switch
            id="captureAllScrolled"
            aria-label="Everything you scroll"
            disabled={!settings.captureEnabled}
            checked={settings.captureAllScrolled}
            onCheckedChange={(checked: boolean) => void update({ captureAllScrolled: checked })}
          />
        </Field>

        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="captureMirrorEnabled">Mirror to Convex</FieldLabel>
            <FieldDescription>
              {syncConfigured ? (
                'Also mirror captured tweets to your Convex deployment. Erasing this device’s archive removes pending mirror work, not copies already sent.'
              ) : (
                <>
                  <span className="font-mono">Uses your Sync connection</span> — set that up first (
                  <a
                    href="#sync"
                    className="rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    Sync ›
                  </a>
                  )
                </>
              )}
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
      </Section>

      <Section title="Archive" description="Everything captured so far, on this device.">
        <a
          href="#archive"
          className="-mx-1 flex min-h-10 items-center justify-between gap-3 rounded-[var(--xmd-radius-3)] px-1 py-0.5 text-sm no-underline outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <span className="font-mono tabular-nums text-muted-foreground">
            {summary === null
              ? 'Loading archive…'
              : summary.status === 'unavailable'
                ? 'Archive unavailable'
                : `${plural(summary.summary.tweets, 'tweet')} · ${plural(summary.summary.conversations, 'conversation')}`}
          </span>
          <span className="shrink-0 text-primary">Open archive ›</span>
        </a>
      </Section>
    </>
  )
}
