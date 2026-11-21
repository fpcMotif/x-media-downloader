import { Option } from 'effect'
import { storage } from 'wxt/utils/storage'
import * as stylex from '@stylexjs/stylex'
import { tokens } from '@/theme/tokens.stylex'
import type { MediaType, Settings } from '@/packages/schema'
import { aria2OriginPattern } from '@/packages/download/aria2'
import { DOWNLOAD_MODES } from '@/packages/download/strategy'
import { freshRecord, type BudgetRecord } from '@/packages/download/daily-budget'
import { dedupeToggleDelta } from '@/packages/settings/coupling'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem, segmented } from '@/components/ui/toggle-group'
import { inputValue, PanelHeader, Section, type PanelProps } from '../ui'
import { readyOr, useLoaded } from '@/components/use-loaded'
import { offersGrantRequest, useOriginGrant } from '@/components/use-origin-grant'
import { EraserIcon, iconSize } from '@/components/icons'

const styles = stylex.create({
  // FieldDescription 'font-mono text-xs' — a later text-size utility also
  // strips the base's leading-normal (tailwind-merge's font-size ↔ leading
  // conflict), so the line-height is text-xs's own.
  descMonoXs: {
    fontFamily: tokens['--font-mono'],
    fontSize: '0.75rem',
    lineHeight: tokens['--text-xs--line-height'],
  },
  // FieldDescription 'font-mono tabular-nums' (no text-xs) — additive onto
  // the base text-sm/leading-normal.
  descMonoNums: { fontFamily: tokens['--font-sans'], fontVariantNumeric: 'tabular-nums' },
  // Input 'w-20 text-center font-mono tabular-nums' — width replaces the
  // base w-full.
  inputMono5: {
    width: '5rem',
    textAlign: 'center',
    fontFamily: tokens['--font-mono'],
    fontVariantNumeric: 'tabular-nums',
  },
  // Input 'w-24 text-center font-mono tabular-nums'.
  inputMono6: {
    width: '6rem',
    textAlign: 'center',
    fontFamily: tokens['--font-mono'],
    fontVariantNumeric: 'tabular-nums',
  },
  // ToggleGroupItem 'h-10 flex-1' — height replaces the Toggle size's own
  // height; text-sm (font-size/line-height) is untouched.
  toggleGroupItemFull: { height: '2.5rem', flex: 1 },
  // aria2 sub-group div: 'grid gap-0 divide-y divide-border border-l
  // border-border pl-4 *:py-3 first:*:pt-0'. divide-y/divide-border and
  // *:py-3 are structural parent->child rules (src/app.css §6) driven by
  // data-xmd-divide/data-xmd-rows instead.
  // dropped: first:*:pt-0 — this div is never itself a :first-child (the
  // ToggleGroup, and often the mode hint <p>, always render before it inside
  // the Section), so the `first:` variant never matched at this call site.
  aria2Group: {
    display: 'grid',
    gap: 0,
    borderLeftStyle: 'solid',
    borderLeftWidth: '1px',
    borderColor: tokens['--border'],
    paddingLeft: '1rem',
  },
  // Shared 'min-h-10' override used by both options action Buttons below.
  minH10: { minHeight: '2.5rem' },
  selfStart: { alignSelf: 'flex-start' },
  // 'text-sm font-medium text-success' p.
  successText: {
    fontSize: '0.875rem',
    lineHeight: tokens['--text-sm--line-height'],
    fontWeight: 500,
    color: tokens['--success'],
  },
  // 'text-sm text-pretty text-muted-foreground' hint p.
  hintText: {
    fontSize: '0.875rem',
    lineHeight: tokens['--text-sm--line-height'],
    textWrap: 'pretty',
    color: tokens['--muted-foreground'],
  },
  typesTrack: { width: '16rem', flexShrink: 0 },
  pairRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    color: tokens['--muted-foreground'],
  },
})

// Moved intact from filters.tsx (the "Daily budget" section reads/resets this
// same `local:` storage item — nothing about its shape changes here).
const EMPTY_USAGE = { day: '', bytes: 0, count: 0 } satisfies BudgetRecord

const budgetItem = storage.defineItem<BudgetRecord>('local:daily-budget', {
  fallback: EMPTY_USAGE,
})

const loadUsage = async (): Promise<BudgetRecord> =>
  freshRecord(await budgetItem.getValue(), Date.now())

const TYPE_FILTERS: ReadonlyArray<{ value: MediaType; label: string }> = [
  { value: 'photo', label: 'Photos' },
  { value: 'video', label: 'Videos' },
  { value: 'gif', label: 'GIFs' },
]

const clampNonNegative = (raw: string): number => Math.max(0, Math.floor(Number(raw) || 0))

const skipTypesFor = (kept: ReadonlyArray<string>): MediaType[] =>
  TYPE_FILTERS.filter((filter) => !kept.includes(filter.value)).map((filter) => filter.value)

/** Whether `value` is one of `DOWNLOAD_MODES`' own values — reuses that array (the
 *  single source of truth for the strategy vocabulary) instead of asserting. */
const isDownloadStrategy = (value: string): value is Settings['downloadStrategy'] =>
  DOWNLOAD_MODES.some((mode) => mode.value === value)

/** Merged General + Downloads + Filters (Stage redesign §3.3 "Saving") — all
 *  three answer "how does media get onto my disk", so they collapse into one
 *  scrollable, hairline-sectioned panel instead of three nav items. */
export function SavingPanel({ settings, update }: PanelProps) {
  const usageLoad = useLoaded(loadUsage)

  const strategy = settings.downloadStrategy
  const rpcUrl = settings.aria2RpcUrl
  const aria2Access = useOriginGrant(
    strategy === 'aria2' ? aria2OriginPattern(rpcUrl) : Option.none(),
  )

  const activeMode = DOWNLOAD_MODES.find((option) => option.value === settings.downloadStrategy)

  const resetToday = async (): Promise<void> => {
    await budgetItem.setValue(freshRecord(null, Date.now()))
    usageLoad.reload()
  }

  const usage = readyOr(usageLoad.state, EMPTY_USAGE)
  const usedMB = Math.round((usage.bytes / 1_000_000) * 10) / 10

  return (
    <>
      <PanelHeader title="Downloads" />

      <Section title="Files">
        <Field>
          <FieldLabel htmlFor="filenameTemplate">Filename template</FieldLabel>
          <Input
            id="filenameTemplate"
            value={settings.filenameTemplate}
            onChange={(e: Event) => void update({ filenameTemplate: inputValue(e) })}
          />
          <FieldDescription sx={styles.descMonoXs}>
            {'{platform} {handle} {tweetId} {index} {ext} {type} {date}'}
          </FieldDescription>
        </Field>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="sidecarMetadata">Metadata sidecar</FieldLabel>
            <FieldDescription>Tweet text and author as .json beside each file</FieldDescription>
          </FieldContent>
          <Switch
            id="sidecarMetadata"
            checked={settings.sidecarMetadata}
            onCheckedChange={(checked: boolean) => void update({ sidecarMetadata: checked })}
          />
        </Field>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="preventDuplicateDownloads">Skip duplicates</FieldLabel>
            <FieldDescription>
              Skips posts already saved on any device. Turns on History.
            </FieldDescription>
          </FieldContent>
          <Switch
            id="preventDuplicateDownloads"
            checked={settings.preventDuplicateDownloads}
            onCheckedChange={(checked: boolean) => void update(dedupeToggleDelta(checked))}
          />
        </Field>
      </Section>

      <Section title="Download mode">
        <ToggleGroup
          type="single"
          spacing={0.5}
          sx={segmented.track}
          aria-label="Download mode"
          value={settings.downloadStrategy}
          onValueChange={(value: string) => {
            if (isDownloadStrategy(value)) void update({ downloadStrategy: value })
          }}
        >
          {DOWNLOAD_MODES.map((option) => (
            <ToggleGroupItem
              key={option.value}
              value={option.value}
              sx={[segmented.item, styles.toggleGroupItemFull]}
            >
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {activeMode && <p {...stylex.props(styles.hintText)}>{activeMode.hint}</p>}

        {settings.downloadStrategy === 'aria2' && (
          <div {...stylex.props(styles.aria2Group)} data-xmd-divide="" data-xmd-rows="3">
            <Field orientation="horizontal">
              <FieldLabel htmlFor="aria2Split">Connections per file</FieldLabel>
              <Input
                id="aria2Split"
                type="number"
                min={1}
                max={16}
                sx={styles.inputMono5}
                value={settings.aria2Split}
                onChange={(e: Event) => void update({ aria2Split: Number(inputValue(e)) || 1 })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="aria2RpcUrl">RPC URL</FieldLabel>
              <Input
                id="aria2RpcUrl"
                value={settings.aria2RpcUrl}
                onChange={(e: Event) => void update({ aria2RpcUrl: inputValue(e) })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="aria2Secret">RPC secret</FieldLabel>
              <Input
                id="aria2Secret"
                type="password"
                value={settings.aria2Secret}
                onChange={(e: Event) => void update({ aria2Secret: inputValue(e) })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="aria2Dir">Download directory</FieldLabel>
              <Input
                id="aria2Dir"
                placeholder="aria2 default"
                value={settings.aria2Dir}
                onChange={(e: Event) => void update({ aria2Dir: inputValue(e) })}
              />
            </Field>
            {offersGrantRequest(aria2Access.grant) && (
              <Button type="button" sx={styles.minH10} onClick={() => void aria2Access.request()}>
                Grant localhost access
              </Button>
            )}
            {aria2Access.grant === 'granted' && (
              <p {...stylex.props(styles.successText)}>localhost access granted</p>
            )}
          </div>
        )}

        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="downloadConcurrency">Concurrent downloads</FieldLabel>
            <FieldDescription>Raise only if your network keeps up</FieldDescription>
          </FieldContent>
          <Input
            id="downloadConcurrency"
            type="number"
            min={1}
            max={10}
            sx={styles.inputMono5}
            value={settings.downloadConcurrency}
            onChange={(e: Event) =>
              void update({
                downloadConcurrency: Number(inputValue(e)) || 1,
              })
            }
          />
        </Field>
      </Section>

      <Section title="Limits" collapsed>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel>Media types</FieldLabel>
          </FieldContent>
          <ToggleGroup
            type="multiple"
            spacing={0.5}
            sx={[segmented.track, styles.typesTrack]}
            aria-label="Media types to download"
            value={TYPE_FILTERS.filter((f) => !settings.skipTypes.includes(f.value)).map(
              (f) => f.value,
            )}
            onValueChange={(kept: string[]) => void update({ skipTypes: skipTypesFor(kept) })}
          >
            {TYPE_FILTERS.map((filter) => (
              <ToggleGroupItem
                key={filter.value}
                id={`skipType-${filter.value}`}
                value={filter.value}
                sx={segmented.item}
              >
                {filter.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Field>

        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="minWidth">Minimum size (px)</FieldLabel>
            <FieldDescription>Width × height</FieldDescription>
          </FieldContent>
          <div {...stylex.props(styles.pairRow)}>
            <Input
              id="minWidth"
              type="number"
              min={0}
              aria-label="Minimum size (px): width"
              sx={styles.inputMono5}
              value={settings.minWidth}
              onChange={(e: Event) => void update({ minWidth: clampNonNegative(inputValue(e)) })}
            />
            <span aria-hidden="true">×</span>
            <Input
              id="minHeight"
              type="number"
              min={0}
              aria-label="Minimum size (px): height"
              sx={styles.inputMono5}
              value={settings.minHeight}
              onChange={(e: Event) => void update({ minHeight: clampNonNegative(inputValue(e)) })}
            />
          </div>
        </Field>

        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="maxFileSizeMB">Max file size (MB)</FieldLabel>
          </FieldContent>
          <Input
            id="maxFileSizeMB"
            type="number"
            min={0}
            sx={styles.inputMono6}
            value={settings.maxFileSizeMB}
            onChange={(e: Event) => void update({ maxFileSizeMB: clampNonNegative(inputValue(e)) })}
          />
        </Field>

        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="dailyMaxMB">Daily size cap (MB)</FieldLabel>
            <FieldDescription>Downloads stop for the day at either cap</FieldDescription>
          </FieldContent>
          <Input
            id="dailyMaxMB"
            type="number"
            min={0}
            sx={styles.inputMono6}
            value={settings.dailyMaxMB}
            onChange={(e: Event) => void update({ dailyMaxMB: clampNonNegative(inputValue(e)) })}
          />
        </Field>

        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="dailyMaxCount">Daily file cap</FieldLabel>
          </FieldContent>
          <Input
            id="dailyMaxCount"
            type="number"
            min={0}
            sx={styles.inputMono6}
            value={settings.dailyMaxCount}
            onChange={(e: Event) => void update({ dailyMaxCount: clampNonNegative(inputValue(e)) })}
          />
        </Field>

        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel>Used today</FieldLabel>
            <FieldDescription sx={styles.descMonoNums}>
              {usedMB} MB · {usage.count} files
            </FieldDescription>
          </FieldContent>
          <Button
            type="button"
            variant="outline"
            size="sm"
            sx={[styles.minH10, styles.selfStart]}
            onClick={() => void resetToday()}
          >
            <EraserIcon sx={iconSize.s35} />
            Reset today
          </Button>
        </Field>

        <FieldDescription>0 = no limit</FieldDescription>
      </Section>
    </>
  )
}
