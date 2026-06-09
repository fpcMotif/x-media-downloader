import type { ComponentChildren } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { getSettings, setSettings } from '../../core/settings'
import { aria2OriginPattern } from '../../core/download/aria2'
import type { MetricsSnapshot, Settings } from '../../core/schema'

function fmtRate(bps: number): string {
  if (bps <= 0) return '—'
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} MB/s`
  return `${Math.round(bps / 1000)} KB/s`
}

export function App() {
  const [settings, setSettingsState] = useState<Settings | null>(null)
  const [saved, setSaved] = useState(false)
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null)
  const [aria2Granted, setAria2Granted] = useState<boolean | null>(null)

  useEffect(() => {
    void getSettings().then(setSettingsState)
  }, [])

  // Reflect whether the localhost host permission for aria2's RPC is granted.
  const strategy = settings?.downloadStrategy
  const rpcUrl = settings?.aria2RpcUrl
  useEffect(() => {
    if (strategy !== 'aria2' || rpcUrl === undefined) return
    const pattern = aria2OriginPattern(rpcUrl)
    if (pattern === null) {
      setAria2Granted(null)
      return
    }
    void browser.permissions.contains({ origins: [pattern] }).then(setAria2Granted)
  }, [strategy, rpcUrl])

  useEffect(() => {
    const poll = (): void => {
      void browser.runtime
        .sendMessage({ _tag: 'MetricsRequest' })
        .then((m) => setMetrics(m as MetricsSnapshot))
        .catch(() => {})
    }
    poll()
    const handle = setInterval(poll, 1000)
    return () => clearInterval(handle)
  }, [])

  if (!settings) {
    return <div class="w-80 p-4 text-sm text-zinc-500">Loading…</div>
  }

  const update = async (patch: Partial<Settings>): Promise<void> => {
    setSettingsState(await setSettings(patch))
    setSaved(true)
    setTimeout(() => setSaved(false), 1200)
  }

  const requestAria2Access = async (): Promise<void> => {
    const pattern = aria2OriginPattern(settings.aria2RpcUrl)
    if (pattern === null) return
    setAria2Granted(await browser.permissions.request({ origins: [pattern] }))
  }

  return (
    <div class="w-80 bg-white text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100">
      <header class="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <span class="text-base font-semibold">X Media Downloader</span>
      </header>

      <div class="space-y-4 p-4">
        <Field label="Filename template">
          <input
            class="w-full rounded-md border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-800"
            aria-label="Filename template"
            value={settings.filenameTemplate}
            onChange={(e) =>
              void update({ filenameTemplate: (e.target as HTMLInputElement).value })
            }
          />
          <p class="mt-1 text-xs text-zinc-500">
            {'{handle} {tweetId} {index} {ext} {type} {date}'}
          </p>
        </Field>

        <Field label="Concurrent downloads">
          <input
            type="number"
            min={1}
            max={10}
            class="w-20 rounded-md border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-800"
            aria-label="Concurrent downloads"
            value={settings.downloadConcurrency}
            onChange={(e) =>
              void update({
                downloadConcurrency: Number((e.target as HTMLInputElement).value) || 1,
              })
            }
          />
        </Field>

        <Field label="Download mode">
          <select
            class="w-full rounded-md border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-800"
            aria-label="Download mode"
            value={settings.downloadStrategy}
            onChange={(e) =>
              void update({
                downloadStrategy: (e.target as HTMLSelectElement)
                  .value as Settings['downloadStrategy'],
              })
            }
          >
            <option value="direct">Direct (default)</option>
            <option value="fetched">Fetched (verify / repackage)</option>
            <option value="aria2">aria2 (fast / resumable)</option>
          </select>
        </Field>

        {settings.downloadStrategy === 'aria2' && (
          <div class="space-y-2 rounded-md bg-zinc-50 p-3 dark:bg-zinc-800/50">
            <Field label="aria2 RPC URL">
              <input
                class="w-full rounded-md border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-800"
                aria-label="aria2 RPC URL"
                value={settings.aria2RpcUrl}
                onChange={(e) => void update({ aria2RpcUrl: (e.target as HTMLInputElement).value })}
              />
            </Field>
            <Field label="aria2 RPC secret">
              <input
                type="password"
                class="w-full rounded-md border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-800"
                aria-label="aria2 RPC secret"
                value={settings.aria2Secret}
                onChange={(e) => void update({ aria2Secret: (e.target as HTMLInputElement).value })}
              />
            </Field>
            <Field label="Download directory (--dir)">
              <input
                class="w-full rounded-md border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-800"
                aria-label="aria2 download directory"
                placeholder="aria2 default"
                value={settings.aria2Dir}
                onChange={(e) => void update({ aria2Dir: (e.target as HTMLInputElement).value })}
              />
            </Field>
            <Field label="Connections per file (split)">
              <input
                type="number"
                min={1}
                max={16}
                class="w-20 rounded-md border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-800"
                aria-label="aria2 split"
                value={settings.aria2Split}
                onChange={(e) =>
                  void update({ aria2Split: Number((e.target as HTMLInputElement).value) || 1 })
                }
              />
            </Field>
            {aria2Granted === false && (
              <button
                type="button"
                class="w-full rounded-md bg-zinc-900 px-2 py-1 text-xs font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
                onClick={() => void requestAria2Access()}
              >
                Grant localhost access
              </button>
            )}
            {aria2Granted === true && (
              <p class="text-xs text-emerald-600 dark:text-emerald-400">
                localhost access granted ✓
              </p>
            )}
          </div>
        )}

        <label class="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            aria-label="Save metadata sidecar"
            checked={settings.sidecarMetadata}
            onChange={(e) =>
              void update({ sidecarMetadata: (e.target as HTMLInputElement).checked })
            }
          />
          Save .json metadata sidecar
        </label>

        <label class="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            aria-label="Authenticated fallback"
            checked={settings.authFallbackEnabled}
            onChange={(e) =>
              void update({ authFallbackEnabled: (e.target as HTMLInputElement).checked })
            }
          />
          Authenticated fallback (opt-in)
        </label>

        {metrics && metrics.total > 0 && (
          <div class="rounded-md border border-zinc-200 p-3 text-xs dark:border-zinc-800">
            <div class="mb-1 font-medium text-zinc-600 dark:text-zinc-400">Download monitor</div>
            <dl class="grid grid-cols-2 gap-x-3 gap-y-1">
              <Stat label="Progress" value={`${metrics.completed}/${metrics.total}`} />
              <Stat label="Active" value={`${metrics.active}/${metrics.concurrencyCap}`} />
              <Stat label="Throughput" value={fmtRate(metrics.throughputBps)} />
              <Stat
                label="ETA"
                value={metrics.etaSeconds === undefined ? '—' : `${Math.ceil(metrics.etaSeconds)}s`}
              />
              {metrics.failed > 0 && <Stat label="Failed" value={String(metrics.failed)} />}
              {metrics.retries > 0 && <Stat label="Retries" value={String(metrics.retries)} />}
            </dl>
          </div>
        )}
      </div>

      <footer class="border-t border-zinc-200 px-4 py-2 text-xs text-zinc-500 dark:border-zinc-800">
        {saved ? 'Saved ✓' : 'Local-only · no tracking'}
      </footer>
    </div>
  )
}

function Field({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div>
      <label class="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">{label}</label>
      {children}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt class="text-zinc-500">{label}</dt>
      <dd class="text-right tabular-nums">{value}</dd>
    </>
  )
}
