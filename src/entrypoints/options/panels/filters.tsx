import { useEffect, useState } from 'preact/hooks'
import { storage } from 'wxt/utils/storage'
import type { MediaType } from '@/core/schema'
import { freshRecord, type BudgetRecord } from '@/core/download/daily-budget'
import { dedupeToggleDelta } from '@/core/settings/coupling'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { PanelHeader, SettingGroup, type PanelProps } from '../ui'
import { SlidersIcon, ClockIcon, EraserIcon } from '@/components/icons'

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

export function FiltersPanel({ settings, update }: PanelProps) {
  const [usage, setUsage] = useState<BudgetRecord | null>(null)

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
        title="Filters"
        description="A pre-download gate that skips duplicates and media you don't want — all off by default."
      />

      <SettingGroup
        title="Duplicates"
        description="Skip media from tweets you've already downloaded, on any device."
        icon={<SlidersIcon className="size-[18px]" />}
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
      </SettingGroup>

      <SettingGroup
        title="Media filters"
        description="Skip media by type or below a minimum resolution before it's queued."
        icon={<SlidersIcon className="size-[18px]" />}
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
            className="w-24 text-center tabular-nums"
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
            className="w-24 text-center tabular-nums"
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
            className="w-24 text-center tabular-nums"
            aria-label="Max file size in MB"
            value={settings.maxFileSizeMB}
            onChange={(e: Event) =>
              void update({ maxFileSizeMB: clampNonNegative((e.target as HTMLInputElement).value) })
            }
          />
        </Field>
      </SettingGroup>

      <SettingGroup
        title="Daily budget"
        description="Hard-stop downloads once either cap is reached for the local calendar day."
        icon={<ClockIcon className="size-[18px]" />}
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
            className="w-24 text-center tabular-nums"
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
            className="w-24 text-center tabular-nums"
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
            <FieldDescription className="tabular-nums">
              {usedMB} MB · {usage?.count ?? 0} files
            </FieldDescription>
          </FieldContent>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => void resetToday()}
          >
            <EraserIcon className="size-3.5" />
            Reset today
          </Button>
        </Field>
      </SettingGroup>
    </>
  )
}
