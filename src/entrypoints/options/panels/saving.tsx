import { useEffect, useRef, useState } from 'preact/hooks'
import { Option } from 'effect'
import type { DailyBudgetUsage, MediaType, Settings } from '@/core/schema'
import { aria2OriginPattern } from '@/core/download/aria2'
import { readDailyBudgetToday, resetDailyBudgetToday } from '@/core/download/daily-budget-client'
import { DOWNLOAD_MODES } from '@/core/download/strategy'
import { dedupeToggleDelta } from '@/core/settings/coupling'
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
import { useAsyncAuthority } from '@/components/use-async-authority'
import { useFetchedStrategySelection } from '@/components/use-fetched-strategy-selection'

const TYPE_FILTERS: ReadonlyArray<{ value: MediaType; label: string }> = [
  { value: 'photo', label: 'Photos' },
  { value: 'video', label: 'Videos' },
  { value: 'gif', label: 'GIFs' },
]

const clampNonNegative = (raw: string): number => {
  const value = Number(raw)
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

const clampBoundedInteger = (raw: string, minimum: number, maximum: number): number => {
  const value = Number(raw)
  if (!Number.isFinite(value)) return minimum
  return Math.min(maximum, Math.max(minimum, Math.floor(value)))
}

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
  const [fetchedNotice, setFetchedNotice] = useState<string | null>(null)
  const [usage, setUsage] = useState<DailyBudgetUsage | null>(null)
  const budgetUsageIntent = useRef(0)
  const aria2PermissionAuthority = useAsyncAuthority()
  const selectDownloadStrategy = useFetchedStrategySelection(update, setFetchedNotice)

  const strategy = settings.downloadStrategy
  const rpcUrl = settings.aria2RpcUrl
  useEffect(() => {
    const epoch = aria2PermissionAuthority.begin()
    setAria2Granted(null)
    if (strategy !== 'aria2') return
    const pattern = aria2OriginPattern(rpcUrl)
    if (Option.isNone(pattern)) {
      setAria2Granted(null)
      return
    }
    void (async () => {
      const granted = await browser.permissions
        .contains({ origins: [pattern.value] })
        .catch(() => false)
      if (aria2PermissionAuthority.isCurrent(epoch)) setAria2Granted(granted)
    })()
  }, [aria2PermissionAuthority, strategy, rpcUrl])

  const requestAria2Access = async (): Promise<void> => {
    const epoch = aria2PermissionAuthority.begin()
    const pattern = aria2OriginPattern(settings.aria2RpcUrl)
    if (Option.isNone(pattern)) return
    const granted = await browser.permissions
      .request({ origins: [pattern.value] })
      .catch(() => false)
    if (aria2PermissionAuthority.isCurrent(epoch)) setAria2Granted(granted)
  }

  const activeMode = DOWNLOAD_MODES.find((option) => option.value === settings.downloadStrategy)

  const requestUsage = async (
    request: () => ReturnType<typeof readDailyBudgetToday>,
  ): Promise<void> => {
    const intent = ++budgetUsageIntent.current
    setUsage(null)
    const outcome = await request()
    if (intent !== budgetUsageIntent.current) return
    setUsage(outcome.status === 'available' ? outcome.usage : null)
  }
  useEffect(() => {
    void requestUsage(readDailyBudgetToday)
    const budgetIntent = budgetUsageIntent
    return () => {
      ++budgetIntent.current
    }
  }, [])

  const resetToday = async (): Promise<void> => {
    await requestUsage(resetDailyBudgetToday)
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
            aria-label="Quick Grab"
            checked={settings.quickGrabEnabled}
            onCheckedChange={(checked: boolean) => void update({ quickGrabEnabled: checked })}
          />
        </Field>

        {settings.quickGrabEnabled && (
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="quickGrabModifier">Quick grab modifier</FieldLabel>
              <FieldDescription>
                Hold {settings.quickGrabModifier === 'meta' ? 'Alt' : 'Cmd'} as well to grab the
                whole post (Instagram &amp; Threads)
              </FieldDescription>
            </FieldContent>
            <Select
              value={settings.quickGrabModifier}
              onValueChange={(value: string) =>
                void update({ quickGrabModifier: value as Settings['quickGrabModifier'] })
              }
            >
              <SelectTrigger
                id="quickGrabModifier"
                aria-label="Quick grab modifier"
                className="w-44 min-h-10"
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
      </Section>

      <Section
        title="Files & naming"
        description="Naming and sidecars applied to every new download."
      >
        <Field>
          <FieldLabel htmlFor="filenameTemplate">Filename template</FieldLabel>
          <Input
            id="filenameTemplate"
            aria-label="Filename template"
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
            aria-label="Save metadata sidecar"
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
            aria-label="Concurrent downloads"
            value={settings.downloadConcurrency}
            onChange={(e: Event) =>
              void update({
                downloadConcurrency: clampBoundedInteger(
                  (e.target as HTMLInputElement).value,
                  1,
                  10,
                ),
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
            if (value) selectDownloadStrategy(value as Settings['downloadStrategy'])
          }}
        >
          {DOWNLOAD_MODES.map((option) => (
            <ToggleGroupItem
              key={option.value}
              value={option.value}
              aria-label={`Download mode: ${option.label}`}
              className="h-10 flex-1"
            >
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {fetchedNotice && (
          <p aria-live="polite" className="text-sm text-pretty text-muted-foreground">
            {fetchedNotice}
          </p>
        )}
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
                aria-label="aria2 split"
                value={settings.aria2Split}
                onChange={(e: Event) =>
                  void update({
                    aria2Split: clampBoundedInteger((e.target as HTMLInputElement).value, 1, 16),
                  })
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="aria2RpcUrl">RPC URL</FieldLabel>
              <Input
                id="aria2RpcUrl"
                aria-label="aria2 RPC URL"
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
                aria-label="aria2 RPC secret"
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
                aria-label="aria2 download directory"
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
            aria-label="Prevent duplicate downloads"
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
              aria-label={`Skip ${filter.label}`}
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
            aria-label="Minimum width"
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
            aria-label="Minimum height"
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
            aria-label="Max file size in MB"
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
            aria-label="Daily size cap in MB"
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
            aria-label="Daily file cap"
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
              {usage === null ? 'Unavailable' : `${usedMB} MB · ${usage.count} files`}
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
            aria-label="Auto-reveal sensitive media"
            checked={settings.autoRevealSensitiveEnabled}
            onCheckedChange={(checked: boolean) =>
              void update({ autoRevealSensitiveEnabled: checked })
            }
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
            aria-label="Show Saved status on already-downloaded posts"
            checked={settings.showSavedStatus}
            onCheckedChange={(checked: boolean) => void update({ showSavedStatus: checked })}
          />
        </Field>
      </Section>
    </>
  )
}
