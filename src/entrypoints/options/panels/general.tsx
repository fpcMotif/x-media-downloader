import type { Settings } from '@/core/schema'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { PanelHeader, SettingGroup, type PanelProps } from '../ui'
import { SlidersIcon, InfoIcon } from '@/components/icons'

export function GeneralPanel({ settings, update }: PanelProps) {
  return (
    <>
      <PanelHeader
        title="General"
        description="On-page helpers that ride alongside X — hover grabs, badges, and the download dock."
      />

      <SettingGroup
        title="On-page controls"
        description="What the extension overlays on x.com while you browse."
        icon={<SlidersIcon className="size-[18px]" />}
      >
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="quickGrabEnabled">Hover quick grab</FieldLabel>
            <FieldDescription>Hold a modifier and hover one media item to grab it</FieldDescription>
          </FieldContent>
          <Switch
            id="quickGrabEnabled"
            aria-label="Quick Grab"
            checked={settings.quickGrabEnabled}
            onCheckedChange={(checked: boolean) => void update({ quickGrabEnabled: checked })}
          />
        </Field>

        {settings.quickGrabEnabled && (
          <Field orientation="horizontal">
            <FieldLabel htmlFor="quickGrabModifier">Quick grab modifier</FieldLabel>
            <Select
              value={settings.quickGrabModifier}
              onValueChange={(value: string) =>
                void update({ quickGrabModifier: value as Settings['quickGrabModifier'] })
              }
            >
              <SelectTrigger
                id="quickGrabModifier"
                aria-label="Quick grab modifier"
                className="w-44"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                <SelectGroup>
                  <SelectItem value="alt">Alt / Option</SelectItem>
                  <SelectItem value="shift">Shift</SelectItem>
                  <SelectItem value="ctrl">Control</SelectItem>
                  <SelectItem value="meta">Cmd / Win</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        )}

        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="downloadBadgeEnabled">Show download badge on media</FieldLabel>
            <FieldDescription>
              Corner badge on photos and videos; click downloads that item
            </FieldDescription>
          </FieldContent>
          <Switch
            id="downloadBadgeEnabled"
            aria-label="Download badge"
            checked={settings.downloadBadgeEnabled}
            onCheckedChange={(checked: boolean) => void update({ downloadBadgeEnabled: checked })}
          />
        </Field>

        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="downloadDockEnabled">Show download dock</FieldLabel>
            <FieldDescription>
              Bottom-left stack to grab all detected media and rescan
            </FieldDescription>
          </FieldContent>
          <Switch
            id="downloadDockEnabled"
            aria-label="Download dock"
            checked={settings.downloadDockEnabled}
            onCheckedChange={(checked: boolean) => void update({ downloadDockEnabled: checked })}
          />
        </Field>

        {settings.downloadDockEnabled && (
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="dockGlassEnabled">Liquid glass dock</FieldLabel>
              <FieldDescription>Translucent glass look instead of the solid pill</FieldDescription>
            </FieldContent>
            <Switch
              id="dockGlassEnabled"
              aria-label="Liquid glass dock"
              checked={settings.dockGlassEnabled}
              onCheckedChange={(checked: boolean) => void update({ dockGlassEnabled: checked })}
            />
          </Field>
        )}
      </SettingGroup>

      <SettingGroup
        title="Advanced"
        description="Opt-in behaviours that change how media is reached on the page."
        icon={<InfoIcon className="size-[18px]" />}
      >
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="autoRevealSensitiveEnabled">
              Auto-reveal sensitive media
            </FieldLabel>
            <FieldDescription>
              Click through “Content warning” covers so hidden media renders inline
            </FieldDescription>
          </FieldContent>
          <Switch
            id="autoRevealSensitiveEnabled"
            aria-label="Auto-reveal sensitive media"
            checked={settings.autoRevealSensitiveEnabled}
            onCheckedChange={(checked: boolean) =>
              void update({ autoRevealSensitiveEnabled: checked })
            }
          />
        </Field>

        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="authFallbackEnabled">Authenticated fallback</FieldLabel>
            <FieldDescription>
              Opt-in — reuse your X session to reach media the public path misses
            </FieldDescription>
          </FieldContent>
          <Switch
            id="authFallbackEnabled"
            aria-label="Authenticated fallback"
            checked={settings.authFallbackEnabled}
            onCheckedChange={(checked: boolean) => void update({ authFallbackEnabled: checked })}
          />
        </Field>
      </SettingGroup>
    </>
  )
}
