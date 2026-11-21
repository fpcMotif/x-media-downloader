import * as stylex from '@stylexjs/stylex'
import type { Settings } from '@/packages/schema'
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
import { PanelHeader, Section, type PanelProps } from '../ui'

const styles = stylex.create({
  selectTriggerWide: { width: '11rem', minHeight: '2.5rem' },
})

const QUICK_GRAB_MODIFIERS = ['alt', 'shift', 'ctrl', 'meta'] as const satisfies ReadonlyArray<
  Settings['quickGrabModifier']
>

const isQuickGrabModifier = (value: string): value is Settings['quickGrabModifier'] =>
  QUICK_GRAB_MODIFIERS.some((modifier) => modifier === value)

export function BrowsingPanel({ settings, update }: PanelProps) {
  return (
    <>
      <PanelHeader title="Browsing" />

      <Section title="Page controls">
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="quickGrabEnabled">Hover quick grab</FieldLabel>
            <FieldDescription>Hold a modifier and hover media to grab it</FieldDescription>
          </FieldContent>
          <Switch
            id="quickGrabEnabled"
            checked={settings.quickGrabEnabled}
            onCheckedChange={(checked: boolean) => void update({ quickGrabEnabled: checked })}
          />
        </Field>

        {settings.quickGrabEnabled && (
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="quickGrabModifier">Modifier</FieldLabel>
              <FieldDescription>
                Add {settings.quickGrabModifier === 'meta' ? 'Alt' : 'Cmd'}, or press d d, to grab
                the whole post
              </FieldDescription>
            </FieldContent>
            <Select
              value={settings.quickGrabModifier}
              onValueChange={(value: string) => {
                if (isQuickGrabModifier(value)) void update({ quickGrabModifier: value })
              }}
            >
              <SelectTrigger id="quickGrabModifier" sx={styles.selectTriggerWide}>
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
            <FieldLabel htmlFor="downloadBadgeEnabled">Download badge</FieldLabel>
            <FieldDescription>Click the corner badge to save one item</FieldDescription>
          </FieldContent>
          <Switch
            id="downloadBadgeEnabled"
            checked={settings.downloadBadgeEnabled}
            onCheckedChange={(checked: boolean) => void update({ downloadBadgeEnabled: checked })}
          />
        </Field>

        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="downloadDockEnabled">Download dock</FieldLabel>
            <FieldDescription>Grab all detected media from the bottom-left</FieldDescription>
          </FieldContent>
          <Switch
            id="downloadDockEnabled"
            checked={settings.downloadDockEnabled}
            onCheckedChange={(checked: boolean) => void update({ downloadDockEnabled: checked })}
          />
        </Field>

        {settings.downloadDockEnabled && (
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="dockGlassEnabled">Glass dock</FieldLabel>
            </FieldContent>
            <Switch
              id="dockGlassEnabled"
              checked={settings.dockGlassEnabled}
              onCheckedChange={(checked: boolean) => void update({ dockGlassEnabled: checked })}
            />
          </Field>
        )}

        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="showSavedStatus">“Saved” chip</FieldLabel>
            <FieldDescription>Mark posts you’ve already downloaded, on any device</FieldDescription>
          </FieldContent>
          <Switch
            id="showSavedStatus"
            checked={settings.showSavedStatus}
            onCheckedChange={(checked: boolean) => void update({ showSavedStatus: checked })}
          />
        </Field>

        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="keyboardNavEnabled">Keyboard navigation</FieldLabel>
            <FieldDescription>
              Threads and Instagram: j/k posts, ←/→ columns, d downloads
            </FieldDescription>
          </FieldContent>
          <Switch
            id="keyboardNavEnabled"
            checked={settings.keyboardNavEnabled}
            onCheckedChange={(checked: boolean) => void update({ keyboardNavEnabled: checked })}
          />
        </Field>
      </Section>

      <Section title="Advanced" collapsed>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="autoRevealSensitiveEnabled">
              Auto-reveal sensitive media
            </FieldLabel>
            <FieldDescription>Click through “Content warning” covers</FieldDescription>
          </FieldContent>
          <Switch
            id="autoRevealSensitiveEnabled"
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
              Use your X session to reach media the public path misses
            </FieldDescription>
          </FieldContent>
          <Switch
            id="authFallbackEnabled"
            checked={settings.authFallbackEnabled}
            onCheckedChange={(checked: boolean) => void update({ authFallbackEnabled: checked })}
          />
        </Field>
      </Section>
    </>
  )
}
