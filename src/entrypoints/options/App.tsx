import type { ComponentType } from 'preact'
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { useSettingsEditor } from '@/components/use-settings-editor'
import { confirmSettingsRecovery, inspectSettingsRecovery } from '@/core/settings/recovery-client'
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
import { RecoveryPanel } from './panels/recovery'
import {
  OptionsSettingsRecoveryContext,
  beginSettingsRecovery,
  initialSettingsRecoveryState,
  settleSettingsRecovery,
} from './settings-recovery-context'

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
  { id: 'recovery', label: 'Recovery', group: 'library', Panel: RecoveryPanel },
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
  const [section, setSection] = useState<SectionId>('saving')
  const [settingsRecovery, setSettingsRecovery] = useState(initialSettingsRecoveryState)
  const recoveryMounted = useRef(true)
  const recoveryEpoch = useRef(0)
  const editor = useSettingsEditor({
    successMs: 1400,
  })
  const { load, notice: saveNotice, reload: reloadEditor } = editor
  const settings = load.settings

  const refreshSettingsRecovery = useCallback(async (): Promise<void> => {
    if (!recoveryMounted.current) return
    const epoch = ++recoveryEpoch.current
    setSettingsRecovery(beginSettingsRecovery)
    const response = await inspectSettingsRecovery()
    if (recoveryMounted.current && recoveryEpoch.current === epoch)
      setSettingsRecovery((state) => settleSettingsRecovery(state, response))
  }, [])

  const recoverSettings = useCallback(
    async (action: 'repair' | 'reset', fingerprint: string): Promise<void> => {
      if (!recoveryMounted.current) return
      const epoch = ++recoveryEpoch.current
      setSettingsRecovery(beginSettingsRecovery)
      const response = await confirmSettingsRecovery(action, fingerprint)
      if (!recoveryMounted.current || recoveryEpoch.current !== epoch) return
      setSettingsRecovery((state) => settleSettingsRecovery(state, response))
      if (response._tag === 'SettingsRecoveryStatus' && response.kind === 'healthy')
        await reloadEditor()
    },
    [reloadEditor],
  )

  const update: PanelProps['update'] = async (patch) => {
    await editor.update(patch)
    await refreshSettingsRecovery()
  }

  const reload = async (): Promise<void> => {
    await editor.reload()
    await refreshSettingsRecovery()
  }

  useEffect(() => {
    const handleHash = () => {
      const hash = location.hash.replace(/^#/, '')
      const target = HASH_ALIASES[hash] ?? hash
      if (isSectionId(target)) setSection(target)
    }
    handleHash()
    window.addEventListener('hashchange', handleHash)
    return () => window.removeEventListener('hashchange', handleHash)
  }, [])

  useEffect(() => {
    recoveryMounted.current = true
    void refreshSettingsRecovery()
    return () => {
      recoveryMounted.current = false
    }
  }, [refreshSettingsRecovery])

  // Sidebar clicks are tab switches, not navigation — replaceState keeps the
  // hash in sync (so reload/copy-link still lands on the right panel) without
  // spamming browser history; five sidebar clicks shouldn't take five presses
  // of Back to leave the page.
  const select = (id: SectionId): void => {
    setSection(id)
    history.replaceState(null, '', `#${id}`)
  }

  const active: Section = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]
  const ActivePanel = active.Panel

  const recoveryKind =
    settingsRecovery.status?.kind === 'recoverable' || settingsRecovery.status?.kind === 'blocked'
      ? settingsRecovery.status.kind
      : null
  const recoveryController = useMemo(
    () => ({
      state: settingsRecovery,
      refresh: refreshSettingsRecovery,
      recover: recoverSettings,
    }),
    [settingsRecovery, refreshSettingsRecovery, recoverSettings],
  )

  return (
    <OptionsSettingsRecoveryContext.Provider value={recoveryController}>
      <div className="xmd-options-root flex min-h-screen w-full bg-background text-foreground">
        <SettingsSidebar sections={SECTIONS} active={section} onSelect={select} />

        <main className="min-w-0 flex-1">
          <div className="mx-auto flex max-w-2xl flex-col gap-8 px-10 py-12">
            {recoveryKind !== null && (
              <section
                aria-label="Settings recovery required"
                className="flex items-start justify-between gap-4 border border-destructive/30 bg-destructive/6 p-4"
              >
                <div className="grid gap-1">
                  <p className="text-sm font-semibold">
                    {recoveryKind === 'recoverable'
                      ? 'Settings repair required'
                      : 'Settings reset required'}
                  </p>
                  <p className="text-[13px] leading-snug text-muted-foreground">
                    Safe Direct mode is active. Cloud upload, Cloud Sync, Clear, and Capture Mirror
                    are paused.
                  </p>
                </div>
                <button
                  type="button"
                  className="shrink-0 rounded-sm text-[13px] font-medium text-destructive outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                  onClick={() => select('recovery')}
                >
                  Open Recovery
                </button>
              </section>
            )}
            {settings !== null ? (
              <ActivePanel settings={settings} update={update} reload={reload} />
            ) : load.status === 'unavailable' ? (
              <section className="grid gap-3" aria-label="Settings unavailable">
                <p className="text-sm text-muted-foreground">Settings are unavailable.</p>
                <button
                  type="button"
                  className="self-start rounded-sm text-sm font-medium text-primary outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                  onClick={() => void reload()}
                >
                  Retry
                </button>
              </section>
            ) : (
              <p className="text-sm text-muted-foreground">Loading settings…</p>
            )}
          </div>
        </main>

        <div
          aria-live="polite"
          className={cn(
            'pointer-events-none fixed right-5 bottom-5 transition-[opacity,transform] ease-[var(--xmd-ease)]',
            saveNotice !== 'idle'
              ? 'translate-y-0 opacity-100 duration-200'
              : 'translate-y-1 opacity-0 duration-150',
          )}
        >
          <span
            className={cn(
              'flex items-center gap-1.5 rounded-[var(--xmd-radius-3)] border border-border bg-background px-3 py-1.5 text-[13px] font-medium',
              saveNotice === 'saved' ? 'text-success' : 'text-destructive',
            )}
          >
            {saveNotice === 'saved' ? <CheckIcon className="size-3.5" /> : null}
            {saveNotice === 'saved' ? 'All changes saved' : 'Save failed'}
          </span>
        </div>
      </div>
    </OptionsSettingsRecoveryContext.Provider>
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
