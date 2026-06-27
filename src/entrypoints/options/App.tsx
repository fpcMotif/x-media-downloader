import type { ComponentType } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { getSettings, setSettings } from '@/core/settings'
import type { Settings } from '@/core/schema'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import {
  DownloadIcon,
  SlidersIcon,
  ListChecksIcon,
  CloudIcon,
  ClockIcon,
  InfoIcon,
  CheckIcon,
  MoonIcon,
} from '@/components/icons'
import type { PanelProps } from './ui'
import { GeneralPanel } from './panels/general'
import { DownloadsPanel } from './panels/downloads'
import { FiltersPanel } from './panels/filters'
import { WorklistPanel } from './panels/worklist'
import { CloudPanel } from './panels/cloud'
import { HistoryPanel } from './panels/history'
import { AboutPanel } from './panels/about'

type Section = {
  readonly id: string
  readonly label: string
  readonly icon: typeof DownloadIcon
  // AboutPanel takes no props; it harmlessly ignores the ones it's handed.
  readonly Panel: ComponentType<PanelProps>
}

const SECTIONS = [
  { id: 'general', label: 'General', icon: SlidersIcon, Panel: GeneralPanel },
  {
    id: 'downloads',
    label: 'Downloads',
    icon: DownloadIcon,
    Panel: DownloadsPanel,
  },
  { id: 'filters', label: 'Filters', icon: SlidersIcon, Panel: FiltersPanel },
  {
    id: 'worklist',
    label: 'Worklist & clearing',
    icon: ListChecksIcon,
    Panel: WorklistPanel,
  },
  { id: 'cloud', label: 'Cloud', icon: CloudIcon, Panel: CloudPanel },
  { id: 'history', label: 'History', icon: ClockIcon, Panel: HistoryPanel },
  { id: 'about', label: 'About', icon: InfoIcon, Panel: AboutPanel },
] as const satisfies ReadonlyArray<Section>

type SectionId = (typeof SECTIONS)[number]['id']

const isSectionId = (value: string): value is SectionId =>
  SECTIONS.some((section) => section.id === value)

export function App() {
  const [settings, setSettingsState] = useState<Settings | null>(null)
  const [section, setSection] = useState<SectionId>('general')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void getSettings().then(setSettingsState)
    const hash = location.hash.replace(/^#/, '')
    if (isSectionId(hash)) setSection(hash)
  }, [])

  const select = (id: SectionId): void => {
    setSection(id)
    history.replaceState(null, '', `#${id}`)
  }

  const update = async (patch: Partial<Settings>): Promise<void> => {
    setSettingsState(await setSettings(patch))
    setSaved(true)
    setTimeout(() => setSaved(false), 1400)
  }
  const reload = async (): Promise<void> => {
    setSettingsState(await getSettings())
  }

  const active: Section = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]
  const ActivePanel = active.Panel

  return (
    <div className="xmd-options-root flex min-h-screen w-full bg-background text-foreground">
      <SettingsSidebar sections={SECTIONS} active={section} onSelect={select} />

      <main className="min-w-0 flex-1">
        <div className="mx-auto flex max-w-3xl flex-col gap-5 px-8 py-9">
          {settings ? <ActivePanel settings={settings} update={update} reload={reload} /> : null}
        </div>
      </main>

      <div
        aria-live="polite"
        className={cn(
          'pointer-events-none fixed right-5 bottom-5 transition-all duration-200',
          saved ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0',
        )}
      >
        <Badge variant="success" className="gap-1.5 px-3 py-1.5 shadow-md">
          <CheckIcon className="size-3.5" />
          All changes saved
        </Badge>
      </div>
    </div>
  )
}

function SettingsSidebar({
  sections,
  active,
  onSelect,
}: {
  sections: typeof SECTIONS
  active: SectionId
  onSelect: (id: SectionId) => void
}) {
  return (
    <aside className="sticky top-0 flex h-screen w-64 shrink-0 flex-col gap-1 border-r border-border bg-card/40 px-3 py-4 backdrop-blur-xl">
      <div className="flex items-center gap-3 px-2 pb-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-[11px] bg-primary text-primary-foreground shadow-sm">
          <DownloadIcon className="size-5" />
        </span>
        <div className="grid gap-0.5">
          <span className="text-sm leading-tight font-bold tracking-tight">X Media Downloader</span>
          <span className="text-[11px] leading-tight text-muted-foreground">
            Version 1.0 · local
          </span>
        </div>
      </div>

      <p className="px-2 pt-2 pb-1 text-[10px] font-bold tracking-[0.16em] text-muted-foreground/70">
        SETTINGS
      </p>
      <nav className="flex flex-col gap-0.5">
        {sections.map((s) => {
          const Icon = s.icon
          const isActive = s.id === active
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onSelect(s.id)}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'flex items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors',
                isActive
                  ? 'bg-primary/10 font-semibold text-primary'
                  : 'font-medium text-foreground hover:bg-muted',
              )}
            >
              <Icon className="size-[18px]" />
              {s.label}
            </button>
          )
        })}
      </nav>

      <div className="mt-auto flex items-center gap-2.5 rounded-lg bg-muted/50 px-3 py-2.5">
        <MoonIcon className="size-[15px] text-muted-foreground" />
        <div className="grid gap-0.5">
          <span className="text-xs font-semibold leading-tight">Appearance</span>
          <span className="text-[11px] leading-tight text-muted-foreground">Following system</span>
        </div>
      </div>
    </aside>
  )
}
