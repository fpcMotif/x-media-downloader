import { useEffect, useState } from 'preact/hooks'
import { Option } from 'effect'
import { storage } from 'wxt/utils/storage'
import type { MediaType, Settings } from '@/packages/schema'
import { aria2OriginPattern } from '@/packages/download/aria2'
import { DOWNLOAD_MODES } from '@/packages/download/strategy'
import { freshRecord, type BudgetRecord } from '@/packages/download/daily-budget'
import { dedupeToggleDelta } from '@/packages/settings/coupling'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { PanelHeader, Section, type PanelProps } from '../ui'
import { EraserIcon } from '@/components/icons'

// Moved intact from filters.tsx (the "Daily budget" section reads/resets this
// same `local:` storage item — nothing about its shape changes here).
const budgetItem = storage.defineItem<BudgetRecord>('local:daily-budget', {
  fallback: { day: '', bytes: 0, count: 0 },
})

const TYPE_FILTERS: ReadonlyArray<{ value: MediaType; label: string }> = [
  { value: 'photo', label: 'Photos' },
  { value: 'video', label: 'Videos' },
  { value: 'gif', label: 'GIFs' },
]

const clampNonNegative = (raw: string): number => Math.max(0, Math.floor(Number(raw) || 0))

const toggleType = (
  skipTypes: ReadonlyArray<MediaType>,
  type: MediaType,
  skip: boolean,
): MediaType[] => (skip ? [...skipTypes, type] : skipTypes.filter((t) => t !== type))

/** Merged General + Downloads + Filters (Stage redesign §3.3 "Saving") — all
 *  three answer "how does media get onto my disk", so they collapse into one
 *  scrollable, hairline-sectioned panel instead of three nav items. */
export function SavingPanel({ settings, update }: PanelProps) {
  const [aria2Granted, setAria2Granted] = useState<boolean | null>(null)
  const [usage, setUsage] = useState<BudgetRecord | null>(null)

  const strategy = settings.downloadStrategy
  const rpcUrl = settings.aria2RpcUrl
  useEffect(() => {
    if (strategy !== 'aria2') return
    const pattern = aria2OriginPattern(rpcUrl)
    if (Option.isNone(pattern)) {
      setAria2Granted(null)
      return
    }
    void browser.permissions.contains({ origins: [pattern.value] }).then(setAria2Granted)
  }, [strategy, rpcUrl])

  const requestAria2Access = async (): Promise<void> => {
    const pattern = aria2OriginPattern(settings.aria2RpcUrl)
    if (Option.isNone(pattern)) return
    setAria2Granted(await browser.permissions.request({ origins: [pattern.value] }))
  }

  const activeMode = DOWNLOAD_MODES.find((option) => option.value === settings.downloadStrategy)

  const refreshUsage = async (): Promise<void> => {
    const stored = await budgetItem.getValue()
    setUsage(freshRecord(stored, Date.now()))
  }
  useEffect(() => {
    void refreshUsage()
  }, [])

  const resetToday = async (): Promise<void> => {
    await budgetItem.setValue(freshRecord(null, Date.now()))
    await refreshUsage()
  }

  const usedMB = usage ? Math.round((usage.bytes / 1_000_000) * 10) / 10 : 0

  return (
    <>
      <PanelHeader
        title="Saving"
        description="How media is noticed, fetched, named, filtered, and saved to disk."
      />

      <Section
        title="On-page controls"
        description="What the extension overlays on x.com while you browse."
      >
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="quickGrabEnabled">Hover quick grab</FieldLabel>
            <FieldDescription>Hold a modifier and hover one media item to grab it</FieldDescription>
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
              <FieldLabel htmlFor="quickGrabModifier">Quick grab modifier</FieldLabel>
              <FieldDescription>
                Hold {settings.quickGrabModifier === 'meta' ? 'Alt' : 'Cmd'} as well, or press d d
                on a post, to grab the whole post
              </FieldDescription>
            </FieldContent>
            <Select
              value={settings.quickGrabModifier}
              onValueChange={(value: string) =>
                void update({ quickGrabModifier: value as Settings['quickGrabModifier'] })
              }
            >
              <SelectTrigger id="quickGrabModifier" className="w-44 min-h-10">
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
            <FieldLabel htmlFor="keyboardNavEnabled">Keyboard navigation</FieldLabel>
            <FieldDescription>
              On Threads &amp; Instagram: j/k move between posts, arrow keys switch columns or flip
              carousel photos, d downloads the focused post
            </FieldDescription>
          </FieldContent>
          <Switch
            id="keyboardNavEnabled"
            checked={settings.keyboardNavEnabled}
            onCheckedChange={(checked: boolean) => void update({ keyboardNavEnabled: checked })}
          />
        </Field>

        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="downloadBadgeEnabled">Show download badge on media</FieldLabel>
            <FieldDescription>
              Corner badge on photos and videos; click downloads that item
            </FieldDescription>
          </FieldContent>
          <Switch
            id="downloadBadgeEnabled"
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
              checked={settings.dockGlassEnabled}
              onCheckedChange={(checked: boolean) => void update({ dockGlassEnabled: checked })}
            />
          </Field>
        )}
      </Section>

      <Section
        title="Files & naming"
        description="Naming and sidecars applied to every new download."
      >
        <Field>
          <FieldLabel htmlFor="filenameTemplate">Filename template</FieldLabel>
          <Input
            id="filenameTemplate"
            value={settings.filenameTemplate}
            onChange={(e: Event) =>
              void update({ filenameTemplate: (e.target as HTMLInputElement).value })
            }
          />
          <FieldDescription className="font-mono text-xs">
            {'{platform} {handle} {tweetId} {index} {ext} {type} {date}'}
          </FieldDescription>
        </Field>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="sidecarMetadata">Save metadata sidecar</FieldLabel>
            <FieldDescription>
              Write a .json with tweet text, author, and links next to each file
            </FieldDescription>
          </FieldContent>
          <Switch
            id="sidecarMetadata"
            checked={settings.sidecarMetadata}
            onCheckedChange={(checked: boolean) => void update({ sidecarMetadata: checked })}
          />
        </Field>
      </Section>

      <Section
        title="Speed"
        description="Conservative defaults; raise only when your network and disk keep up."
      >
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="downloadConcurrency">Concurrent downloads</FieldLabel>
            <FieldDescription>How many media files download at once</FieldDescription>
          </FieldContent>
          <Input
            id="downloadConcurrency"
            type="number"
            min={1}
            max={10}
            className="w-20 text-center font-mono tabular-nums"
            value={settings.downloadConcurrency}
            onChange={(e: Event) =>
              void update({
                downloadConcurrency: Number((e.target as HTMLInputElement).value) || 1,
              })
            }
          />
        </Field>
      </Section>

      <Section
        title="Download mode"
        description="Direct is the safest default — Chrome saves the file directly."
      >
        <ToggleGroup
          type="single"
          variant="outline"
          spacing={0}
          className="w-full rounded-[var(--xmd-radius-3)]"
          style={{ '--radius': 'var(--xmd-radius-3)' }}
          aria-label="Download mode"
          value={settings.downloadStrategy}
          onValueChange={(value: string) => {
            if (value) void update({ downloadStrategy: value as Settings['downloadStrategy'] })
          }}
        >
          {DOWNLOAD_MODES.map((option) => (
            <ToggleGroupItem key={option.value} value={option.value} className="h-10 flex-1">
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {activeMode && (
          <p className="text-sm text-pretty text-muted-foreground">{activeMode.hint}</p>
        )}

        {settings.downloadStrategy === 'aria2' && (
          <div className="grid gap-0 divide-y divide-border border-l border-border pl-4 *:py-3 first:*:pt-0">
            <Field orientation="horizontal">
              <FieldLabel htmlFor="aria2Split">aria2 split</FieldLabel>
              <Input
                id="aria2Split"
                type="number"
                min={1}
                max={16}
                className="w-20 text-center font-mono tabular-nums"
                value={settings.aria2Split}
                onChange={(e: Event) =>
                  void update({ aria2Split: Number((e.target as HTMLInputElement).value) || 1 })
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="aria2RpcUrl">RPC URL</FieldLabel>
              <Input
                id="aria2RpcUrl"
                value={settings.aria2RpcUrl}
                onChange={(e: Event) =>
                  void update({ aria2RpcUrl: (e.target as HTMLInputElement).value })
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="aria2Secret">RPC secret</FieldLabel>
              <Input
                id="aria2Secret"
                type="password"
                value={settings.aria2Secret}
                onChange={(e: Event) =>
                  void update({ aria2Secret: (e.target as HTMLInputElement).value })
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="aria2Dir">Download directory</FieldLabel>
              <Input
                id="aria2Dir"
                placeholder="aria2 default"
                value={settings.aria2Dir}
                onChange={(e: Event) =>
                  void update({ aria2Dir: (e.target as HTMLInputElement).value })
                }
              />
            </Field>
            {aria2Granted === false && (
              <Button type="button" className="min-h-10" onClick={() => void requestAria2Access()}>
                Grant localhost access
              </Button>
            )}
            {aria2Granted === true && (
              <p className="text-sm font-medium text-success">localhost access granted</p>
            )}
          </div>
        )}
      </Section>

      <Section
        title="Duplicates"
        description="Skip media from tweets you've already downloaded, on any device."
      >
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="preventDuplicateDownloads">Prevent duplicate downloads</FieldLabel>
            <FieldDescription>
              Requires download history — enabling this turns it on automatically.
            </FieldDescription>
          </FieldContent>
          <Switch
            id="preventDuplicateDownloads"
            checked={settings.preventDuplicateDownloads}
            onCheckedChange={(checked: boolean) => void update(dedupeToggleDelta(checked))}
          />
        </Field>
      </Section>

      <Section
        title="Media filters"
        description="Skip media by type or below a minimum resolution before it's queued."
      >
        {TYPE_FILTERS.map((filter) => (
          <Field key={filter.value} orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor={`skipType-${filter.value}`}>Skip {filter.label}</FieldLabel>
              <FieldDescription>Never download {filter.label.toLowerCase()}</FieldDescription>
            </FieldContent>
            <Switch
              id={`skipType-${filter.value}`}
              checked={settings.skipTypes.includes(filter.value)}
              onCheckedChange={(checked: boolean) =>
                void update({ skipTypes: toggleType(settings.skipTypes, filter.value, checked) })
              }
            />
          </Field>
        ))}

        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="minWidth">Minimum width</FieldLabel>
            <FieldDescription>Skip media narrower than this (px). 0 = off.</FieldDescription>
          </FieldContent>
          <Input
            id="minWidth"
            type="number"
            min={0}
            className="w-24 text-center font-mono tabular-nums"
            value={settings.minWidth}
            onChange={(e: Event) =>
              void update({ minWidth: clampNonNegative((e.target as HTMLInputElement).value) })
            }
          />
        </Field>

        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="minHeight">Minimum height</FieldLabel>
            <FieldDescription>Skip media shorter than this (px). 0 = off.</FieldDescription>
          </FieldContent>
          <Input
            id="minHeight"
            type="number"
            min={0}
            className="w-24 text-center font-mono tabular-nums"
            value={settings.minHeight}
            onChange={(e: Event) =>
              void update({ minHeight: clampNonNegative((e.target as HTMLInputElement).value) })
            }
          />
        </Field>

        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="maxFileSizeMB">Max file size (MB)</FieldLabel>
            <FieldDescription>Skip files larger than this. 0 = off.</FieldDescription>
          </FieldContent>
          <Input
            id="maxFileSizeMB"
            type="number"
            min={0}
            className="w-24 text-center font-mono tabular-nums"
            value={settings.maxFileSizeMB}
            onChange={(e: Event) =>
              void update({ maxFileSizeMB: clampNonNegative((e.target as HTMLInputElement).value) })
            }
          />
        </Field>
      </Section>

      <Section
        title="Daily budget"
        description="Hard-stop downloads once either cap is reached for the local calendar day."
      >
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="dailyMaxMB">Daily size cap (MB)</FieldLabel>
            <FieldDescription>Total bytes per day. 0 = off.</FieldDescription>
          </FieldContent>
          <Input
            id="dailyMaxMB"
            type="number"
            min={0}
            className="w-24 text-center font-mono tabular-nums"
            value={settings.dailyMaxMB}
            onChange={(e: Event) =>
              void update({ dailyMaxMB: clampNonNegative((e.target as HTMLInputElement).value) })
            }
          />
        </Field>

        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="dailyMaxCount">Daily file cap</FieldLabel>
            <FieldDescription>Number of files per day. 0 = off.</FieldDescription>
          </FieldContent>
          <Input
            id="dailyMaxCount"
            type="number"
            min={0}
            className="w-24 text-center font-mono tabular-nums"
            value={settings.dailyMaxCount}
            onChange={(e: Event) =>
              void update({ dailyMaxCount: clampNonNegative((e.target as HTMLInputElement).value) })
            }
          />
        </Field>

        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel>Used today</FieldLabel>
            <FieldDescription className="font-mono tabular-nums">
              {usedMB} MB · {usage?.count ?? 0} files
            </FieldDescription>
          </FieldContent>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-10 self-start"
            onClick={() => void resetToday()}
          >
            <EraserIcon className="size-3.5" />
            Reset today
          </Button>
        </Field>
      </Section>

      <Section
        title="Advanced"
        description="Opt-in behaviours that change how media is reached on the page."
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
            checked={settings.authFallbackEnabled}
            onCheckedChange={(checked: boolean) => void update({ authFallbackEnabled: checked })}
          />
        </Field>

        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="showSavedStatus">Show “Saved” on downloaded posts</FieldLabel>
            <FieldDescription>
              Mark timeline posts you’ve already downloaded (on any device) with a “Saved ✓” chip
            </FieldDescription>
          </FieldContent>
          <Switch
            id="showSavedStatus"
            checked={settings.showSavedStatus}
            onCheckedChange={(checked: boolean) => void update({ showSavedStatus: checked })}
          />
        </Field>
      </Section>
    </>
  )
}
