import { useEffect, useState } from 'preact/hooks'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '@/theme/tokens.stylex'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { PanelHeader, Section, type PanelProps } from '../ui'
import { fetchCaptureSummary, type CaptureSummary } from '@/components/capture-export'
import { plural } from '@/components/capture-copy'

const HOVER = '@media (hover: hover)'
const RING_FOCUS_VISIBLE =
  '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent), 0 0 #0000'

const styles = stylex.create({
  // font-mono
  syncNotConfigured: {
    fontFamily: tokens['--font-mono'],
  },
  // rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50 —
  // the underline/hover come from app.css (keyed on data-slot="field-description").
  syncLink: {
    borderRadius: 'calc(var(--radius) - 4px)',
    outlineStyle: 'none',
    boxShadow: { default: null, ':focus-visible': RING_FOCUS_VISIBLE },
  },
  // -mx-1 flex min-h-10 items-center justify-between gap-3
  // rounded-[var(--xmd-radius-3)] px-1 py-0.5 text-sm no-underline outline-none
  // transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50
  // (no data-slot, so the utility's own 0.15s cubic-bezier timing wins; the
  // element's own py-0.5 is overridden at runtime by the Section row rule in
  // app.css exactly as before — this only needs to carry the element's values)
  archiveLink: {
    marginInline: '-0.25rem',
    display: 'flex',
    minHeight: '2.5rem',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.75rem',
    borderRadius: tokens['--xmd-radius-3'],
    paddingInline: '0.25rem',
    paddingBlock: '0.125rem',
    fontSize: '0.875rem',
    lineHeight: tokens['--text-sm--line-height'],
    textDecorationLine: 'none',
    outlineStyle: 'none',
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
    transitionDuration: '0.15s',
    backgroundColor: { default: null, [HOVER]: { ':hover': tokens['--muted'] } },
    boxShadow: { default: null, ':focus-visible': RING_FOCUS_VISIBLE },
  },
  // font-mono tabular-nums text-muted-foreground
  archiveCounts: {
    fontFamily: tokens['--font-mono'],
    fontVariantNumeric: 'tabular-nums',
    color: tokens['--muted-foreground'],
  },
  // shrink-0 text-primary
  archiveCta: {
    flexShrink: 0,
    color: tokens['--primary'],
  },
})

export function CapturePanel({ settings, update }: PanelProps) {
  const [summary, setSummary] = useState<CaptureSummary | null>(null)

  // Counts only (limit 0) — browsing and exporting the archive itself now lives
  // on its own page; this panel only needs the numbers for its link-out.
  useEffect(() => {
    void fetchCaptureSummary(0).then(setSummary)
  }, [])

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
                'Also mirror captured tweets to your Convex deployment'
              ) : (
                <>
                  <span {...stylex.props(styles.syncNotConfigured)}>Uses your Sync connection</span>{' '}
                  — set that up first (
                  <a href="#sync" {...stylex.props(styles.syncLink)}>
                    Sync ›
                  </a>
                  )
                </>
              )}
            </FieldDescription>
          </FieldContent>
          <Switch
            id="captureMirrorEnabled"
            disabled={!syncConfigured}
            checked={settings.captureMirrorEnabled}
            onCheckedChange={(checked: boolean) => void update({ captureMirrorEnabled: checked })}
          />
        </Field>
      </Section>

      <Section title="Archive" description="Everything captured so far, on this device.">
        <a href="#archive" {...stylex.props(styles.archiveLink)}>
          <span {...stylex.props(styles.archiveCounts)}>
            {plural(summary?.tweets ?? 0, 'tweet')} ·{' '}
            {plural(summary?.conversations ?? 0, 'conversation')}
          </span>
          <span {...stylex.props(styles.archiveCta)}>Open archive ›</span>
        </a>
      </Section>
    </>
  )
}
