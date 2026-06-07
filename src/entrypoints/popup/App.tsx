import type { ComponentChildren } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { getSettings, setSettings } from '../../core/settings'
import type { Settings } from '../../core/schema'

export function App() {
  const [settings, setSettingsState] = useState<Settings | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void getSettings().then(setSettingsState)
  }, [])

  if (!settings) {
    return <div class="w-80 p-4 text-sm text-zinc-500">Loading…</div>
  }

  const update = async (patch: Partial<Settings>): Promise<void> => {
    setSettingsState(await setSettings(patch))
    setSaved(true)
    setTimeout(() => setSaved(false), 1200)
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
          </select>
        </Field>

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
