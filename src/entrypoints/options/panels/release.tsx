import { useEffect, useRef, useState } from 'preact/hooks'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '@/theme/tokens.stylex'
import { CLEAR_AFTER_DOWNLOAD } from '@/packages/clear/copy'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmStrip } from '@/components/confirm-strip'
import { TURN_ON_RELEASE_LABEL, turnOnReleaseConfirm } from '@/components/action-copy'
import { runDiagnosticsExport } from '@/components/diagnostics-export'
import { Section, type PanelProps } from '../ui'

const styles = stylex.create({
  header: { display: 'grid', gap: '0.375rem', paddingBottom: '0.25rem' },
  h1: {
    display: 'flex',
    alignItems: 'center',
    fontSize: '1.25rem',
    lineHeight: tokens['--text-xl--line-height'],
    fontWeight: 600,
    letterSpacing: '-0.025em',
    textWrap: 'balance',
  },
  badgeMargin: { marginLeft: '0.375rem' },
  lede: {
    fontSize: '13px',
    lineHeight: 1.625,
    color: tokens['--muted-foreground'],
    textWrap: 'pretty',
  },
  // 'flex items-center gap-1.5 text-[11px]' — the text-size utility strips the
  // base's leading-normal (tailwind-merge's font-size ↔ leading conflict), so
  // the line-height is inherited.
  subToggleDesc: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.375rem',
    fontSize: '11px',
    lineHeight: null,
  },
  dot: {
    width: '0.375rem',
    height: '0.375rem',
    flexShrink: 0,
    borderRadius: '3.40282e38px',
    backgroundColor: tokens['--destructive'],
  },
  subGroup: {
    display: 'grid',
    gap: 0,
    borderLeftStyle: 'solid',
    borderLeftWidth: '1px',
    borderColor: tokens['--border'],
    paddingLeft: '1rem',
  },
  releaseFromLabel: {
    fontSize: '11px',
    fontWeight: 600,
    letterSpacing: '0.025em',
    color: tokens['--muted-foreground'],
  },
  textPretty: { textWrap: 'pretty' },
  minH10SelfStart: { minHeight: '2.5rem', alignSelf: 'flex-start' },
  status: {
    display: 'block',
    textWrap: 'pretty',
    fontSize: '0.875rem',
    lineHeight: tokens['--text-sm--line-height'],
    color: tokens['--muted-foreground'],
  },
})

// Renders its own header (rather than the shared `PanelHeader`) only so the
// red "Account" tier tag can sit inline after the <h1> — `PanelHeader`'s
// `title` prop is typed `string`, and ui.tsx is untouched by this redesign
// (spec §5.3 "Never touched"). Markup below mirrors PanelHeader's classes
// exactly so the two headers are visually identical apart from the badge.
function ReleaseHeader() {
  return (
    <header {...stylex.props(styles.header)}>
      <h1 {...stylex.props(styles.h1)}>
        Release
        <Badge variant="destructive" sx={styles.badgeMargin}>
          Account
        </Badge>
      </h1>
      <p {...stylex.props(styles.lede)}>
        Treat Bookmarks, Likes, and For You as a worklist that empties itself as media is saved.
        Releasing changes your X account and can't be undone by this extension — off by default.
      </p>
    </header>
  )
}

export function ReleasePanel({ settings, update }: PanelProps) {
  const [diagStatus, setDiagStatus] = useState<string | null>(null)
  // One owned status-flash timer (mirrors ArchivePanel's `statusTimer`): a newer
  // flash cancels the older timer before rearming, and unmount cancels whatever
  // is pending.
  const diagStatusTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    return () => clearTimeout(diagStatusTimer.current)
  }, [])

  const flashDiagStatus = (msg: string): void => {
    setDiagStatus(msg)
    clearTimeout(diagStatusTimer.current)
    diagStatusTimer.current = setTimeout(() => {
      setDiagStatus(null)
      diagStatusTimer.current = undefined
    }, 5000)
  }

  return (
    <>
      <ReleaseHeader />

      <Section
        title="Release after download"
        description="When on, each post is removed from its list (un-like on Likes, un-bookmark on Bookmarks) once its media truly lands. When off, the page actions just download."
      >
        <ConfirmStrip
          sentence={turnOnReleaseConfirm}
          confirmLabel={TURN_ON_RELEASE_LABEL}
          kind="pre-committed"
          onConfirm={() => void update({ clearOnSave: true })}
        >
          {(arm) => (
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="clearOnSave">{CLEAR_AFTER_DOWNLOAD.label}</FieldLabel>
                {settings.clearOnSave ? (
                  <FieldDescription sx={styles.subToggleDesc}>
                    <span aria-hidden="true" {...stylex.props(styles.dot)} />
                    On — every page action also releases.
                  </FieldDescription>
                ) : (
                  <FieldDescription>
                    {CLEAR_AFTER_DOWNLOAD.description} Off by default.
                  </FieldDescription>
                )}
              </FieldContent>
              <Switch
                id="clearOnSave"
                checked={settings.clearOnSave}
                onCheckedChange={(checked: boolean) => {
                  if (checked) arm()
                  else void update({ clearOnSave: false })
                }}
              />
            </Field>
          )}
        </ConfirmStrip>

        {settings.clearOnSave && (
          // dropped: first:*:pt-0 — this div is never a first child at any call site
          <div {...stylex.props(styles.subGroup)} data-xmd-divide="" data-xmd-rows="3">
            <span {...stylex.props(styles.releaseFromLabel)}>Release from</span>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="autoUnbookmarkOnSave">Un-bookmark</FieldLabel>
                <FieldDescription>Remove from Bookmarks when complete</FieldDescription>
              </FieldContent>
              <Switch
                id="autoUnbookmarkOnSave"
                checked={settings.autoUnbookmarkOnSave}
                onCheckedChange={(checked: boolean) =>
                  void update({ autoUnbookmarkOnSave: checked })
                }
              />
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="autoUnlikeOnSave">Un-like</FieldLabel>
                <FieldDescription>Remove from Likes when complete</FieldDescription>
              </FieldContent>
              <Switch
                id="autoUnlikeOnSave"
                checked={settings.autoUnlikeOnSave}
                onCheckedChange={(checked: boolean) => void update({ autoUnlikeOnSave: checked })}
              />
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="autoNotInterestedOnSave">Not interested (For You)</FieldLabel>
                <FieldDescription>
                  On the For You timeline, fire X’s “Not interested in this post” when complete — it
                  leaves the feed and trains X to show you less like it.
                </FieldDescription>
              </FieldContent>
              <Switch
                id="autoNotInterestedOnSave"
                checked={settings.autoNotInterestedOnSave}
                onCheckedChange={(checked: boolean) =>
                  void update({ autoNotInterestedOnSave: checked })
                }
              />
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="clearAllListsOnSave">Release from every list</FieldLabel>
                <FieldDescription>
                  Remove a finished post from every list it’s in, not just the page you’re on —
                  un-like a bookmarked post, un-bookmark a liked one. “Not interested” still only
                  fires on For You. Off by default — it’s the most aggressive option.
                </FieldDescription>
              </FieldContent>
              <Switch
                id="clearAllListsOnSave"
                checked={settings.clearAllListsOnSave}
                onCheckedChange={(checked: boolean) =>
                  void update({ clearAllListsOnSave: checked })
                }
              />
            </Field>
          </div>
        )}

        <FieldDescription sx={styles.textPretty}>
          Run the worklist from the toolbar popup on an X Likes or Bookmarks tab — “Download this
          page” or “One by one”. This setting only decides whether those actions also release.
        </FieldDescription>
      </Section>

      <Section
        title="Release from the popup"
        description="Two rows in the toolbar popup release immediately, without downloading anything first. They appear only on X tabs."
      >
        <p {...stylex.props(styles.lede)}>
          Release this page… — releases every post currently rendered on the page. Asks you to
          confirm.
        </p>
        <p {...stylex.props(styles.lede)}>
          Release the whole list… — scrolls the entire Likes or Bookmarks list and releases
          everything in it. The single most destructive control in the extension; asks you to type
          RELEASE first.
        </p>
      </Section>

      <Section
        title="Diagnostics"
        description="Export the Release diagnostics log (stages, timings, ids only — no post content) as JSONL."
      >
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="releaseMutationDiagnosticsEnabled">
              Observe bookmark/like mutations
            </FieldLabel>
            <FieldDescription>
              Records whether each un-bookmark/un-like actually succeeded on X's server (status,
              errors) and flags any bookmark/like that fires mid-Release. Read-only — never clicks
              or changes what Release does. Off by default.
            </FieldDescription>
          </FieldContent>
          <Switch
            id="releaseMutationDiagnosticsEnabled"
            checked={settings.releaseMutationDiagnosticsEnabled}
            onCheckedChange={(checked: boolean) =>
              void update({ releaseMutationDiagnosticsEnabled: checked })
            }
          />
        </Field>

        <Button
          type="button"
          variant="outline"
          size="sm"
          sx={styles.minH10SelfStart}
          onClick={() => void runDiagnosticsExport().then((o) => flashDiagStatus(o.detail))}
        >
          Export diagnostics
        </Button>

        <output aria-live="polite" aria-atomic="true" {...stylex.props(styles.status)}>
          {diagStatus}
        </output>
      </Section>
    </>
  )
}
