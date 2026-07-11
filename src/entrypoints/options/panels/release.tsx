import { CLEAR_AFTER_DOWNLOAD } from '@/core/clear/copy'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { ConfirmStrip } from '@/components/confirm-strip'
import { TURN_ON_RELEASE_LABEL, turnOnReleaseConfirm } from '@/components/action-copy'
import { Section, type PanelProps } from '../ui'

// Renders its own header (rather than the shared `PanelHeader`) only so the
// red "Account" tier tag can sit inline after the <h1> — `PanelHeader`'s
// `title` prop is typed `string`, and ui.tsx is untouched by this redesign
// (spec §5.3 "Never touched"). Markup below mirrors PanelHeader's classes
// exactly so the two headers are visually identical apart from the badge.
function ReleaseHeader() {
  return (
    <header className="grid gap-1.5 pb-1">
      <h1 className="flex items-center text-xl font-semibold tracking-tight text-balance">
        Release
        <Badge variant="destructive" className="ml-1.5">
          Account
        </Badge>
      </h1>
      <p className="text-[13px] leading-relaxed text-muted-foreground text-pretty">
        Treat Bookmarks, Likes, and For You as a worklist that empties itself as media is saved.
        Releasing changes your X account and can't be undone by this extension — off by default.
      </p>
    </header>
  )
}

export function ReleasePanel({ settings, update }: PanelProps) {
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
                  <FieldDescription className="flex items-center gap-1.5 text-[11px]">
                    <span
                      aria-hidden="true"
                      className="size-1.5 shrink-0 rounded-full bg-destructive"
                    />
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
                aria-label="Release after download"
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
          <div className="grid gap-0 divide-y divide-border border-l border-border pl-4 *:py-3 first:*:pt-0">
            <span className="text-[11px] font-semibold tracking-wide text-muted-foreground">
              Release from
            </span>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="autoUnbookmarkOnSave">Un-bookmark</FieldLabel>
                <FieldDescription>Remove from Bookmarks when complete</FieldDescription>
              </FieldContent>
              <Switch
                id="autoUnbookmarkOnSave"
                aria-label="Un-bookmark on save"
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
                aria-label="Un-like on save"
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
                aria-label="Not interested on save"
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
                aria-label="Release from every list"
                checked={settings.clearAllListsOnSave}
                onCheckedChange={(checked: boolean) =>
                  void update({ clearAllListsOnSave: checked })
                }
              />
            </Field>
          </div>
        )}

        <FieldDescription className="text-pretty">
          Run the worklist from the toolbar popup on an X Likes or Bookmarks tab — “Download this
          page” or “One by one”. This setting only decides whether those actions also release.
        </FieldDescription>
      </Section>

      <Section
        title="Release from the popup"
        description="Two rows in the toolbar popup release immediately, without downloading anything first. They appear only on X tabs."
      >
        <p className="text-[13px] leading-relaxed text-muted-foreground text-pretty">
          Release this page… — releases every post currently rendered on the page. Asks you to
          confirm.
        </p>
        <p className="text-[13px] leading-relaxed text-muted-foreground text-pretty">
          Release the whole list… — scrolls the entire Likes or Bookmarks list and releases
          everything in it. The single most destructive control in the extension; asks you to type
          RELEASE first.
        </p>
      </Section>
    </>
  )
}
