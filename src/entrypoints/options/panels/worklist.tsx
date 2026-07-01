import { CLEAR_AFTER_DOWNLOAD } from '@/core/clear/copy'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { PanelHeader, SettingGroup, type PanelProps } from '../ui'
import { ListChecksIcon } from '@/components/icons'

export function WorklistPanel({ settings, update }: PanelProps) {
  return (
    <>
      <PanelHeader
        title="Worklist & clearing"
        description="Treat Bookmarks, Likes, and the For You feed as a worklist that empties itself as media is saved. Clearing is an irreversible account action — off by default."
      />

      <SettingGroup
        title="Clear after download"
        description="When on, each post is removed from the list (un-like on Likes, un-bookmark on Bookmarks) once its media truly lands. When off, the worklist actions just download."
        icon={<ListChecksIcon className="size-[18px]" />}
      >
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="clearOnSave">{CLEAR_AFTER_DOWNLOAD.label}</FieldLabel>
            <FieldDescription>{CLEAR_AFTER_DOWNLOAD.description} Off by default.</FieldDescription>
          </FieldContent>
          <Switch
            id="clearOnSave"
            aria-label="Clear after download"
            checked={settings.clearOnSave}
            onCheckedChange={(checked: boolean) => void update({ clearOnSave: checked })}
          />
        </Field>

        {settings.clearOnSave && (
          <div className="grid gap-3 rounded-lg border border-border/60 bg-muted/30 p-4">
            <span className="text-[11px] font-semibold tracking-wide text-muted-foreground">
              CLEAR FROM
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
                <FieldLabel htmlFor="clearAllListsOnSave">Clear from every list</FieldLabel>
                <FieldDescription>
                  Remove a finished post from <em>every</em> list it’s in, not just the page you’re
                  on — un-like a bookmarked post, un-bookmark a liked one. So a liked post you save
                  while browsing Bookmarks also leaves your Likes. “Not interested” still only fires
                  on For You. Off by default — it’s the most aggressive option.
                </FieldDescription>
              </FieldContent>
              <Switch
                id="clearAllListsOnSave"
                aria-label="Clear from every list"
                checked={settings.clearAllListsOnSave}
                onCheckedChange={(checked: boolean) =>
                  void update({ clearAllListsOnSave: checked })
                }
              />
            </Field>
          </div>
        )}

        <FieldDescription>
          Run the worklist from the toolbar popup on an X Likes or Bookmarks tab — “Download this
          page” or “one by one”. This setting only decides whether those actions also clear.
        </FieldDescription>
      </SettingGroup>
    </>
  )
}
