import { useState } from 'preact/hooks'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '@/theme/tokens.stylex'
import { CLEAR_AFTER_DOWNLOAD } from '@/packages/clear/copy'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmStrip, useConfirmStrip } from '@/components/confirm-strip'
import { useOwnedTimer } from '@/components/owned-timer'
import { TURN_ON_RELEASE_LABEL, turnOnReleaseConfirm } from '@/components/action-copy'
import { runDiagnosticsExport } from '@/components/diagnostics-export'
import { PanelHeader, Section, type PanelProps } from '../ui'

const styles = stylex.create({
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

export function ReleasePanel({ settings, update }: PanelProps) {
  const [diagStatus, setDiagStatus] = useState<string | null>(null)
  // One owned status-flash timer (mirrors ArchivePanel's `statusTimer`): a newer
  // flash cancels the older timer before rearming, and unmount cancels whatever
  // is pending.
  const diagStatusTimer = useOwnedTimer()
  const turnOnStrip = useConfirmStrip()

  const flashDiagStatus = (msg: string): void => {
    setDiagStatus(msg)
    diagStatusTimer.arm(() => setDiagStatus(null), 5000)
  }

  return (
    <>
      <PanelHeader
        title="Release"
        badge={<Badge variant="destructive">Account</Badge>}
        description="Empties Bookmarks, Likes and For You as you save. This changes your X account, and the extension can't undo it."
      />

      <Section title="Worklist">
        <ConfirmStrip
          control={turnOnStrip}
          sentence={turnOnReleaseConfirm}
          confirmLabel={TURN_ON_RELEASE_LABEL}
          kind="pre-committed"
          onConfirm={() => void update({ clearOnSave: true })}
        >
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="clearOnSave">{CLEAR_AFTER_DOWNLOAD.label}</FieldLabel>
              {settings.clearOnSave ? (
                <FieldDescription sx={styles.subToggleDesc}>
                  <span aria-hidden="true" {...stylex.props(styles.dot)} />
                  On — every page action also releases.
                </FieldDescription>
              ) : (
                <FieldDescription>{CLEAR_AFTER_DOWNLOAD.description}</FieldDescription>
              )}
            </FieldContent>
            <Switch
              id="clearOnSave"
              checked={settings.clearOnSave}
              onCheckedChange={(checked: boolean) => {
                if (checked) turnOnStrip.arm()
                else void update({ clearOnSave: false })
              }}
            />
          </Field>
        </ConfirmStrip>

        {settings.clearOnSave && (
          // dropped: first:*:pt-0 — this div is never a first child at any call site
          <div {...stylex.props(styles.subGroup)} data-xmd-divide="" data-xmd-rows="3">
            <span {...stylex.props(styles.releaseFromLabel)}>Release from</span>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="autoUnbookmarkOnSave">Un-bookmark</FieldLabel>
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
                  For You only. Also tells X to show less like it.
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
                  Also un-likes bookmarked posts and un-bookmarks liked ones. The most aggressive
                  option.
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
          Applies to “Download this page” and “One by one” in the popup.
        </FieldDescription>
      </Section>

      <Section title="Diagnostics" collapsed>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="releaseMutationDiagnosticsEnabled">
              Observe bookmark/like mutations
            </FieldLabel>
            <FieldDescription>
              Logs whether each un-bookmark or un-like succeeded. Read-only.
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
