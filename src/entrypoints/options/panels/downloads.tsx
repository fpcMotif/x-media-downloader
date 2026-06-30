import { useEffect, useState } from 'preact/hooks'
import { Option } from 'effect'
import type { Settings } from '@/core/schema'
import { aria2OriginPattern } from '@/core/download/aria2'
import { DOWNLOAD_MODES } from '@/core/download/strategy'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { PanelHeader, SettingGroup, type PanelProps } from '../ui'
import { DownloadIcon, SlidersIcon } from '@/components/icons'

export function DownloadsPanel({ settings, update }: PanelProps) {
  const [aria2Granted, setAria2Granted] = useState<boolean | null>(null)

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

  return (
    <>
      <PanelHeader title="Downloads" description="How files are named, fetched, and saved." />

      <SettingGroup
        title="Save defaults"
        description="Naming and sidecars applied to every new download."
        icon={<DownloadIcon className="size-[18px]" />}
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
            {'{handle} {tweetId} {index} {ext} {type} {date}'}
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
      </SettingGroup>

      <SettingGroup
        title="Speed"
        description="Conservative defaults; raise only when your network and disk keep up."
        icon={<SlidersIcon className="size-[18px]" />}
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
            className="w-20 text-center tabular-nums"
            aria-label="Concurrent downloads"
            value={settings.downloadConcurrency}
            onChange={(e: Event) =>
              void update({
                downloadConcurrency: Number((e.target as HTMLInputElement).value) || 1,
              })
            }
          />
        </Field>
      </SettingGroup>

      <SettingGroup
        title="Download mode"
        description="Direct is the safest default — Chrome saves the file directly."
        icon={<DownloadIcon className="size-[18px]" />}
      >
        <ToggleGroup
          type="single"
          variant="outline"
          spacing={0}
          className="w-full"
          aria-label="Download mode"
          value={settings.downloadStrategy}
          onValueChange={(value: string) => {
            if (value) void update({ downloadStrategy: value as Settings['downloadStrategy'] })
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
        {activeMode && <p className="text-sm text-muted-foreground">{activeMode.hint}</p>}

        {settings.downloadStrategy === 'aria2' && (
          <div className="flex flex-col gap-4 rounded-lg bg-muted/40 p-4">
            <Field orientation="horizontal">
              <FieldLabel htmlFor="aria2Split">aria2 split</FieldLabel>
              <Input
                id="aria2Split"
                type="number"
                min={1}
                max={16}
                className="w-20 text-center tabular-nums"
                aria-label="aria2 split"
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
              <Button type="button" onClick={() => void requestAria2Access()}>
                Grant localhost access
              </Button>
            )}
            {aria2Granted === true && (
              <p className="text-sm font-medium text-success">localhost access granted</p>
            )}
          </div>
        )}
      </SettingGroup>
    </>
  )
}
