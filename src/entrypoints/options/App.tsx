import type { ComponentType } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { getSettings, setSettings } from '@/packages/settings'
import type { Settings } from '@/packages/schema'
import { cn } from '@/lib/utils'
import { CheckIcon } from '@/components/icons'
import { Badge } from '@/components/ui/badge'
import type { PanelProps } from './ui'
import { SavingPanel } from './panels/saving'
import { ReleasePanel } from './panels/release'
import { CapturePanel } from './panels/capture'
import { SyncPanel } from './panels/sync'
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

// Stage redesign §3.1: General + Downloads + Filters all answer "how does
// media get onto my disk", so they merge into Saving — one task, not three
// feature nouns. Clearing → Release (the account-mutating tier-2 verb).
// Cloud → Sync (names what the user is doing, not the technology).
const SECTIONS = [
  { id: 'saving', label: 'Saving', group: 'settings', Panel: SavingPanel },
  { id: 'release', label: 'Release', group: 'settings', Panel: ReleasePanel },
  { id: 'capture', label: 'Capture', group: 'settings', Panel: CapturePanel },
  { id: 'sync', label: 'Sync', group: 'settings', Panel: SyncPanel },
  { id: 'archive', label: 'Archive', group: 'library', Panel: ArchivePanel },
  { id: 'history', label: 'History', group: 'library', Panel: HistoryPanel },
  { id: 'about', label: 'About', group: 'utility', Panel: AboutPanel },
] as const satisfies ReadonlyArray<Section>

type SectionEntry = (typeof SECTIONS)[number]
type SectionId = SectionEntry['id']

const isSectionId = (value: string): value is SectionId =>
  SECTIONS.some((section) => section.id === value)

// Add-only: every hash a bookmark, an old popup build, or a stale deep-link
// might carry still has to resolve (spec §3.2). Never delete an entry once
// shipped — new clusters get new aliases, they don't reclaim old ones.
const HASH_ALIASES: Record<string, SectionId> = {
  worklist: 'release', // legacy alias, pre-R4
  clearing: 'release', // popup deep-link (openClearingSettings) + R4-era links
  general: 'saving',
  downloads: 'saving',
  filters: 'saving',
  cloud: 'sync',
}

export function App() {
  const [settings, setSettingsState] = useState<Settings | null>(null)
  const [section, setSection] = useState<SectionId>('saving')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void getSettings().then(setSettingsState)
    const handleHash = () => {
      const hash = location.hash.replace(/^#/, '')
      const target = HASH_ALIASES[hash] ?? hash
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

  // One owned "Saved" feedback timer: a newer save cancels the older timer
  // before rearming, and unmount cancels whatever is pending.
  const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    return () => clearTimeout(savedTimer.current)
  }, [])

  const update = async (patch: Partial<Settings>): Promise<void> => {
    setSettingsState(await setSettings(patch))
    setSaved(true)
    clearTimeout(savedTimer.current)
    savedTimer.current = setTimeout(() => {
      setSaved(false)
      savedTimer.current = undefined
    }, 1400)
  }
  const reload = async (): Promise<void> => {
    setSettingsState(await getSettings())
  }

  const active: Section = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]
  const ActivePanel = active.Panel

  return (
    <div className="xmd-options-root flex flex-col sm:flex-row min-h-screen w-full bg-background text-foreground">
      <SettingsSidebar sections={SECTIONS} active={section} onSelect={select} />

      <main className="min-w-0 flex-1">
        <div className="mx-auto flex max-w-2xl flex-col gap-8 px-4 sm:px-10 py-6 sm:py-12">
          {settings ? <ActivePanel settings={settings} update={update} reload={reload} /> : null}
        </div>
      </main>

      <output
        aria-live="polite"
        aria-atomic="true"
        className={cn(
          'pointer-events-none fixed right-5 bottom-5 transition-[opacity,transform] ease-[var(--xmd-ease)]',
          saved ? 'translate-y-0 opacity-100 duration-200' : 'translate-y-1 opacity-0 duration-150',
        )}
      >
        {saved && (
          <span className="flex items-center gap-1.5 rounded-[var(--xmd-radius-3)] border border-border bg-background px-3 py-1.5 text-[13px] font-medium text-success">
            <CheckIcon className="size-3.5" />
            All changes saved
          </span>
        )}
      </output>
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
    <aside className="sm:sticky top-0 flex sm:h-screen w-full sm:w-[220px] shrink-0 flex-col gap-1 border-b sm:border-b-0 sm:border-r border-border px-3 py-4 sm:py-5">
      <div className="px-2 pb-4">
        <span className="block text-sm leading-tight font-semibold tracking-tight">
          X Media Downloader
        </span>
        <span className="mt-0.5 block font-mono text-[11px] leading-tight text-muted-foreground">
          v1.0 · local
        </span>
      </div>

      <p
        id="settings-nav-label"
        className="px-2 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground"
      >
        Settings
      </p>
      <nav aria-labelledby="settings-nav-label" className="mb-4 flex flex-col gap-0.5">
        {settingsSections.map((s) => (
          <NavItem key={s.id} section={s} active={active} onSelect={onSelect} />
        ))}
      </nav>

      <p
        id="library-nav-label"
        className="px-2 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground"
      >
        Library
      </p>
      <nav aria-labelledby="library-nav-label" className="flex flex-col gap-0.5">
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
            'flex min-h-10 items-center rounded-[var(--xmd-radius-3)] px-2 text-left text-[13px] transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
            active === 'about'
              ? 'font-semibold text-primary'
              : 'font-medium text-muted-foreground hover:text-foreground',
          )}
        >
          About
        </button>
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
        'flex min-h-10 items-center rounded-[var(--xmd-radius-3)] px-3 text-left text-[13px] transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
        isActive
          ? 'bg-primary/[0.09] font-semibold text-primary'
          : 'font-medium text-foreground/80 hover:bg-muted hover:text-foreground',
      )}
    >
      {section.label}
      {/* The danger tier is legible from the sidebar before the user clicks in
          (spec §3.1) — Release is the only account-mutating cluster. */}
      {section.id === 'release' && (
        <Badge variant="destructive" className="ml-1.5">
          Account
        </Badge>
      )}
    </button>
  )
}
