import type { ComponentType } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { getSettings, setSettings } from '@/core/settings'
import type { Settings } from '@/core/schema'
import { cn } from '@/lib/utils'
import { CheckIcon } from '@/components/icons'
import type { PanelProps } from './ui'
import { GeneralPanel } from './panels/general'
import { DownloadsPanel } from './panels/downloads'
import { FiltersPanel } from './panels/filters'
import { WorklistPanel } from './panels/worklist'
import { CloudPanel } from './panels/cloud'
import { CapturePanel } from './panels/capture'
import { HistoryPanel } from './panels/history'
import { AboutPanel } from './panels/about'
import { ArchivePanel } from './panels/archive'

// Which sidebar cluster a section renders in. 'utility' sections (About) skip
// both nav lists — they're rendered by hand in the sidebar's bottom corner.
type NavGroup = 'settings' | 'library' | 'utility'

type Section = {
  readonly id: string
  readonly label: string
  readonly group: NavGroup
  // AboutPanel takes no props; it harmlessly ignores the ones it's handed.
  readonly Panel: ComponentType<PanelProps>
}

const SECTIONS = [
  { id: 'general', label: 'General', group: 'settings', Panel: GeneralPanel },
  { id: 'downloads', label: 'Downloads', group: 'settings', Panel: DownloadsPanel },
  { id: 'filters', label: 'Filters', group: 'settings', Panel: FiltersPanel },
  { id: 'clearing', label: 'Clearing', group: 'settings', Panel: WorklistPanel },
  { id: 'capture', label: 'Capture', group: 'settings', Panel: CapturePanel },
  { id: 'cloud', label: 'Cloud', group: 'settings', Panel: CloudPanel },
  { id: 'archive', label: 'Archive', group: 'library', Panel: ArchivePanel },
  { id: 'history', label: 'History', group: 'library', Panel: HistoryPanel },
  { id: 'about', label: 'About', group: 'utility', Panel: AboutPanel },
] as const satisfies ReadonlyArray<Section>

type SectionEntry = (typeof SECTIONS)[number]
type SectionId = SectionEntry['id']

const isSectionId = (value: string): value is SectionId =>
  SECTIONS.some((section) => section.id === value)

export function App() {
  const [settings, setSettingsState] = useState<Settings | null>(null)
  const [section, setSection] = useState<SectionId>('general')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void getSettings().then(setSettingsState)
    const handleHash = () => {
      const hash = location.hash.replace(/^#/, '')
      const target = hash === 'worklist' ? 'clearing' : hash
      if (isSectionId(target)) setSection(target)
    }
    handleHash()
    window.addEventListener('hashchange', handleHash)
    return () => window.removeEventListener('hashchange', handleHash)
  }, [])

  // Sidebar clicks are tab switches, not navigation — replaceState keeps the
  // hash in sync (so reload/copy-link still lands on the right panel) without
  // spamming browser history; five sidebar clicks shouldn't take five presses
  // of Back to leave the page.
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
        <div className="mx-auto flex max-w-2xl flex-col gap-8 px-10 py-12">
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
        <span className="flex items-center gap-1.5 rounded-[8px] border border-border bg-background px-3 py-1.5 text-[13px] font-medium text-success">
          <CheckIcon className="size-3.5" />
          All changes saved
        </span>
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
  const settingsSections = sections.filter((s) => s.group === 'settings')
  const librarySections = sections.filter((s) => s.group === 'library')

  return (
    <aside className="sticky top-0 flex h-screen w-[220px] shrink-0 flex-col gap-1 border-r border-border px-3 py-5">
      <div className="px-2 pb-4">
        <span className="block text-sm leading-tight font-semibold tracking-tight">
          X Media Downloader
        </span>
        <span className="mt-0.5 block font-mono text-[11px] leading-tight text-muted-foreground">
          v1.0 · local
        </span>
      </div>

      <p className="px-2 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground">
        Settings
      </p>
      <nav className="mb-4 flex flex-col gap-0.5">
        {settingsSections.map((s) => (
          <NavItem key={s.id} section={s} active={active} onSelect={onSelect} />
        ))}
      </nav>

      <p className="px-2 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground">
        Library
      </p>
      <nav className="flex flex-col gap-0.5">
        {librarySections.map((s) => (
          <NavItem key={s.id} section={s} active={active} onSelect={onSelect} />
        ))}
      </nav>

      <div className="mt-auto flex flex-col gap-2 border-t border-border px-2 pt-3">
        <button
          type="button"
          onClick={() => onSelect('about')}
          aria-current={active === 'about' ? 'page' : undefined}
          className={cn(
            'flex min-h-10 items-center rounded-[8px] px-2 text-left text-[13px] transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
            active === 'about'
              ? 'font-semibold text-primary'
              : 'font-medium text-muted-foreground hover:text-foreground',
          )}
        >
          About
        </button>
        <span className="text-[11px] text-muted-foreground">Appearance · System</span>
      </div>
    </aside>
  )
}

function NavItem({
  section,
  active,
  onSelect,
}: {
  section: Pick<SectionEntry, 'id' | 'label'>
  active: SectionId
  onSelect: (id: SectionId) => void
}) {
  const isActive = section.id === active
  return (
    <button
      type="button"
      onClick={() => onSelect(section.id)}
      aria-current={isActive ? 'page' : undefined}
      className={cn(
        'flex min-h-10 items-center rounded-[8px] px-3 text-left text-[13px] transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
        isActive
          ? 'bg-primary/[0.09] font-semibold text-primary'
          : 'font-medium text-foreground/80 hover:bg-muted hover:text-foreground',
      )}
    >
      {section.label}
    </button>
  )
}
