import type { ComponentType } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import * as stylex from '@stylexjs/stylex'
import { getSettings, setSettings } from '@/packages/settings'
import type { Settings } from '@/packages/schema'
import { tokens } from '@/theme/tokens.stylex'
import { CheckIcon, iconSize } from '@/components/icons'
import { Badge } from '@/components/ui/badge'
import type { PanelProps } from './ui'
import { SavingPanel } from './panels/saving'
import { ReleasePanel } from './panels/release'
import { CapturePanel } from './panels/capture'
import { SyncPanel } from './panels/sync'
import { HistoryPanel } from './panels/history'
import { AboutPanel } from './panels/about'
import { ArchivePanel } from './panels/archive'

const SM = '@media (width >= 40rem)'
const HOVER = '@media (hover: hover)'
const RING_FOCUS_VISIBLE =
  '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent), 0 0 #0000'

const styles = stylex.create({
  // xmd-options-root flex flex-col sm:flex-row min-h-screen w-full bg-background
  // text-foreground — the `xmd-options-root` class name itself is dropped (it
  // only existed to carry the deleted style.css background rule); bg-background
  // resolved to the same var, but the unlayered .xmd-options-root selector used
  // to win the cascade, so this uses --xmd-bg directly to match.
  root: {
    display: 'flex',
    flexDirection: { default: 'column', [SM]: 'row' },
    minHeight: '100vh',
    width: '100%',
    backgroundColor: tokens['--xmd-bg'],
    color: tokens['--foreground'],
  },
  // min-w-0 flex-1
  main: {
    minWidth: 0,
    flex: 1,
  },
  // mx-auto flex max-w-2xl flex-col gap-8 px-4 sm:px-10 py-6 sm:py-12
  content: {
    marginInline: 'auto',
    display: 'flex',
    maxWidth: '42rem',
    flexDirection: 'column',
    gap: '2rem',
    paddingInline: { default: '1rem', [SM]: '2.5rem' },
    paddingBlock: { default: '1.5rem', [SM]: '3rem' },
  },
  // pointer-events-none fixed right-5 bottom-5 transition-[opacity,transform]
  // ease-[var(--xmd-ease)] — no data-slot, so the utility's own timing wins.
  toast: {
    pointerEvents: 'none',
    position: 'fixed',
    right: '1.25rem',
    bottom: '1.25rem',
    transitionProperty: 'opacity, transform',
    transitionTimingFunction: 'var(--xmd-ease)',
  },
  // saved ? translate-y-0 opacity-100 duration-200 : …
  toastShown: {
    translate: '0 0',
    opacity: 1,
    transitionDuration: '0.2s',
  },
  // : translate-y-1 opacity-0 duration-150
  toastHidden: {
    translate: '0 0.25rem',
    opacity: 0,
    transitionDuration: '0.15s',
  },
  // flex items-center gap-1.5 rounded-[var(--xmd-radius-3)] border border-border
  // bg-background px-3 py-1.5 text-[13px] font-medium text-success
  toastInner: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.375rem',
    borderRadius: tokens['--xmd-radius-3'],
    borderStyle: 'solid',
    borderWidth: '1px',
    borderColor: tokens['--border'],
    backgroundColor: tokens['--background'],
    paddingInline: '0.75rem',
    paddingBlock: '0.375rem',
    fontSize: '13px',
    fontWeight: 500,
    color: tokens['--success'],
  },
  // sm:sticky top-0 flex sm:h-screen w-full sm:w-[220px] shrink-0 flex-col gap-1
  // border-b sm:border-b-0 sm:border-r border-border px-3 py-4 sm:py-5
  aside: {
    position: { default: null, [SM]: 'sticky' },
    top: 0,
    display: 'flex',
    height: { default: null, [SM]: '100vh' },
    width: { default: '100%', [SM]: '220px' },
    flexShrink: 0,
    flexDirection: 'column',
    gap: '0.25rem',
    borderBottomStyle: 'solid',
    borderBottomWidth: { default: '1px', [SM]: 0 },
    // borderRightStyle: 'solid' is not declared — the preflight `border: 0 solid`
    // shorthand already establishes it on every element, unconditionally.
    borderRightWidth: { default: null, [SM]: '1px' },
    borderColor: tokens['--border'],
    paddingInline: '0.75rem',
    paddingBlock: { default: '1rem', [SM]: '1.25rem' },
  },
  // px-2 pb-4
  brandBlock: {
    paddingInline: '0.5rem',
    paddingBottom: '1rem',
  },
  // block text-sm leading-tight font-semibold tracking-tight
  brandName: {
    display: 'block',
    fontSize: '0.875rem',
    lineHeight: 1.25,
    fontWeight: 600,
    letterSpacing: '-0.025em',
  },
  // mt-0.5 block font-mono text-[11px] leading-tight text-muted-foreground
  brandVersion: {
    marginTop: '0.125rem',
    display: 'block',
    fontFamily: tokens['--font-mono'],
    fontSize: '11px',
    lineHeight: 1.25,
    color: tokens['--muted-foreground'],
  },
  // px-2 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground
  navLabel: {
    paddingInline: '0.5rem',
    paddingTop: '0.5rem',
    paddingBottom: '0.25rem',
    fontSize: '11px',
    fontWeight: 600,
    letterSpacing: '0.025em',
    color: tokens['--muted-foreground'],
  },
  // mb-4 flex flex-col gap-0.5
  navSettings: {
    marginBottom: '1rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
  },
  // flex flex-col gap-0.5
  navLibrary: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
  },
  // mt-auto flex flex-col gap-2 border-t border-border px-2 pt-3
  sidebarFooter: {
    marginTop: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
    borderTopStyle: 'solid',
    borderTopWidth: '1px',
    borderColor: tokens['--border'],
    paddingInline: '0.5rem',
    paddingTop: '0.75rem',
  },
  // About button (no data-slot): flex min-h-10 items-center
  // rounded-[var(--xmd-radius-3)] px-2 text-left text-[13px] transition-colors
  // outline-none focus-visible:ring-3 focus-visible:ring-ring/50
  aboutBase: {
    display: 'flex',
    minHeight: '2.5rem',
    alignItems: 'center',
    borderRadius: tokens['--xmd-radius-3'],
    paddingInline: '0.5rem',
    textAlign: 'left',
    fontSize: '13px',
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
    transitionDuration: '0.15s',
    outlineStyle: 'none',
    boxShadow: { default: null, ':focus-visible': RING_FOCUS_VISIBLE },
  },
  // active === 'about' ? font-semibold text-primary
  aboutActive: {
    fontWeight: 600,
    color: tokens['--primary'],
  },
  // : font-medium text-muted-foreground hover:text-foreground
  aboutInactive: {
    fontWeight: 500,
    color: { default: tokens['--muted-foreground'], [HOVER]: { ':hover': tokens['--foreground'] } },
  },
  // NavItem button (no data-slot): flex min-h-10 items-center
  // rounded-[var(--xmd-radius-3)] px-3 text-left text-[13px] transition-colors
  // outline-none focus-visible:ring-3 focus-visible:ring-ring/50
  navItemBase: {
    display: 'flex',
    minHeight: '2.5rem',
    alignItems: 'center',
    borderRadius: tokens['--xmd-radius-3'],
    paddingInline: '0.75rem',
    textAlign: 'left',
    fontSize: '13px',
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
    transitionDuration: '0.15s',
    outlineStyle: 'none',
    boxShadow: { default: null, ':focus-visible': RING_FOCUS_VISIBLE },
  },
  // isActive: bg-primary/[0.09] font-semibold text-primary
  navItemActive: {
    backgroundColor: 'color-mix(in oklab, var(--primary) 9%, transparent)',
    fontWeight: 600,
    color: tokens['--primary'],
  },
  // !isActive: font-medium text-foreground/80 hover:bg-muted hover:text-foreground
  navItemInactive: {
    fontWeight: 500,
    color: {
      default: 'color-mix(in oklab, var(--foreground) 80%, transparent)',
      [HOVER]: { ':hover': tokens['--foreground'] },
    },
    backgroundColor: { default: null, [HOVER]: { ':hover': tokens['--muted'] } },
  },
  // ml-1.5
  releaseBadge: {
    marginLeft: '0.375rem',
  },
})

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
    <div {...stylex.props(styles.root)}>
      <SettingsSidebar sections={SECTIONS} active={section} onSelect={select} />

      <main {...stylex.props(styles.main)}>
        <div {...stylex.props(styles.content)}>
          {settings ? <ActivePanel settings={settings} update={update} reload={reload} /> : null}
        </div>
      </main>

      <output
        aria-live="polite"
        aria-atomic="true"
        {...stylex.props(styles.toast, saved ? styles.toastShown : styles.toastHidden)}
      >
        {saved && (
          <span {...stylex.props(styles.toastInner)}>
            <CheckIcon sx={iconSize.s35} />
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
    <aside {...stylex.props(styles.aside)}>
      <div {...stylex.props(styles.brandBlock)}>
        <span {...stylex.props(styles.brandName)}>X Media Downloader</span>
        <span {...stylex.props(styles.brandVersion)}>v1.0 · local</span>
      </div>

      <p id="settings-nav-label" {...stylex.props(styles.navLabel)}>
        Settings
      </p>
      <nav aria-labelledby="settings-nav-label" {...stylex.props(styles.navSettings)}>
        {settingsSections.map((s) => (
          <NavItem key={s.id} section={s} active={active} onSelect={onSelect} />
        ))}
      </nav>

      <p id="library-nav-label" {...stylex.props(styles.navLabel)}>
        Library
      </p>
      <nav aria-labelledby="library-nav-label" {...stylex.props(styles.navLibrary)}>
        {librarySections.map((s) => (
          <NavItem key={s.id} section={s} active={active} onSelect={onSelect} />
        ))}
      </nav>

      <div {...stylex.props(styles.sidebarFooter)}>
        <button
          type="button"
          onClick={() => onSelect('about')}
          aria-current={active === 'about' ? 'page' : undefined}
          {...stylex.props(
            styles.aboutBase,
            active === 'about' ? styles.aboutActive : styles.aboutInactive,
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
      {...stylex.props(
        styles.navItemBase,
        isActive ? styles.navItemActive : styles.navItemInactive,
      )}
    >
      {section.label}
      {/* The danger tier is legible from the sidebar before the user clicks in
          (spec §3.1) — Release is the only account-mutating cluster. */}
      {section.id === 'release' && (
        <Badge variant="destructive" sx={styles.releaseBadge}>
          Account
        </Badge>
      )}
    </button>
  )
}
