import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const popupSource = readFileSync('src/entrypoints/popup/App.tsx', 'utf8')

describe('popup platform identity derives from the adapter registry (ADR-0019)', () => {
  it('imports adapterForUrl from the registry, not isXUrl from the X adapter', () => {
    expect(popupSource).toContain("import { adapterForUrl } from '@/core/adapters/registry'")
    expect(popupSource).not.toContain("import { isXUrl } from '@/core/adapters/x'")
    expect(popupSource).not.toContain('isXUrl')
  })

  it('holds the resolved adapter (or undefined) as state, deriving onXTab in the render body', () => {
    expect(popupSource).toContain(
      'const [tabAdapter, setTabAdapter] = useState<PlatformAdapter | undefined>(undefined)',
    )
    expect(popupSource).toContain('setTabAdapter(adapterForUrl(url))')
    expect(popupSource).toContain("const onXTab = tabAdapter?.platform === 'x'")
  })

  // Stage redesign (§2.2): the list-page/platform-context check is now
  // centralized in `context.ts`'s `tabContext()` — imported and unit-tested
  // there (context.test.ts) rather than re-derived inline in App.tsx. This is
  // a stronger form of the same ADR-0019 safety property (never derive
  // list-page-ness from an X-specific URL matcher; always route through the
  // adapter registry's `platform` field): the guarantee now lives in one
  // pure, directly-tested function instead of a string grep on a duplicated
  // inline expression.
  it('derives the tab-context matrix via context.ts, independently of the tabAdapter effect', () => {
    expect(popupSource).toContain("from './context'")
    expect(popupSource).toContain('setCtx(tabContext(url))')
    expect(popupSource).toContain('setScope(tabScope(url))')
  })
})

describe('Stage zone gates its buttons X-only via onXTab, mirroring the pre-redesign gates', () => {
  it('keeps the drain/sweep gates X-only', () => {
    expect(popupSource).toContain('disabled={!onXTab || drainBusy}')
    expect(popupSource).toContain('disabled={!onXTab || sweepBusy}')
  })

  it('renders the Release cluster (page + whole-list release) only inside the X-context branch', () => {
    expect(popupSource).toContain('ReleaseCluster')
    expect(popupSource).toContain("(ctx === 'x' || ctx === 'x-list') &&")
  })

  it('gates the whole-list release row to list pages via onListPage, never rendering a disabled ghost', () => {
    // The old design disabled a "Clear list…" button off-list with a title
    // tooltip; the redesign instead renders the whole-list row only inside
    // the onListPage branch of ReleaseCluster (spec §2.2 table: "not
    // rendered" off-list, no tooltip-disabled ghost).
    const onListPageIdx = popupSource.indexOf('onListPage ?')
    const wholeListIdx = popupSource.indexOf('ClearWholeListRequest')
    expect(onListPageIdx).toBeGreaterThan(-1)
    expect(wholeListIdx).toBeGreaterThan(onListPageIdx)
  })
})

describe('no native confirm() and no accesskey (safety properties, spec §6.3)', () => {
  it('popup App.tsx contains neither', () => {
    expect(popupSource).not.toMatch(/\bconfirm\(/u)
    expect(popupSource).not.toContain('accesskey')
  })
})

describe('every ConfirmStrip confirm label restates the literal action, never the bare word "Confirm"', () => {
  it('does not render a button literally labeled Confirm', () => {
    expect(popupSource).not.toMatch(/>Confirm</u)
  })
})

describe('cluster status lines auto-clear after 6s unless persistent (spec §2.6)', () => {
  it('imports isPersistentStatus alongside the actionable-error constants', () => {
    expect(popupSource).toContain('isPersistentStatus')
  })

  it('gates a 6000ms clear effect on downloadMsg behind isPersistentStatus', () => {
    const idx = popupSource.indexOf(
      'if (downloadMsg === null || isPersistentStatus(downloadMsg)) return',
    )
    expect(idx).toBeGreaterThan(-1)
    expect(popupSource.slice(idx, idx + 200)).toContain(
      'setTimeout(() => setDownloadMsg(null), 6000)',
    )
  })

  it('gates a 6000ms clear effect on releaseMsg behind isPersistentStatus', () => {
    const idx = popupSource.indexOf(
      'if (releaseMsg === null || isPersistentStatus(releaseMsg)) return',
    )
    expect(idx).toBeGreaterThan(-1)
    expect(popupSource.slice(idx, idx + 200)).toContain(
      'setTimeout(() => setReleaseMsg(null), 6000)',
    )
  })
})

describe('zone hairlines never stack (spec §2.9 adjacent-zone fix)', () => {
  it('ContextStrip supplies its separator as a shadow, not a border-b', () => {
    const headerIdx = popupSource.indexOf('function ContextStrip')
    const nextFnIdx = popupSource.indexOf('function FirstRunStrip')
    const header = popupSource.slice(headerIdx, nextFnIdx)
    expect(header).toContain('shadow-[0_1px_0_0_var(--border)]')
    expect(header).not.toContain('border-b')
  })

  it("FirstRunStrip drops border-b, deferring to the next zone's border-t", () => {
    const stripIdx = popupSource.indexOf('function FirstRunStrip')
    const nextFnIdx = popupSource.indexOf('function MonitorZone')
    const strip = popupSource.slice(stripIdx, nextFnIdx)
    expect(strip).not.toContain('border-b')
  })
})

describe('unsupported-context headline balances instead of prettifying (spec §2.3)', () => {
  it('uses text-balance on the single-line headline', () => {
    expect(popupSource).toContain('<p className="text-balance text-[13px] font-medium">')
  })
})

describe('metrics polling cannot rearm or set state after unmount (react-doctor/effect-needs-cleanup)', () => {
  it('keeps the timer handle optional — cleanup is safe before the first timer', () => {
    expect(popupSource).toContain(
      'let handle: ReturnType<typeof setTimeout> | undefined',
    )
  })

  it('gates setMetrics behind the active flag', () => {
    const idx = popupSource.indexOf('setMetrics(snapshot)')
    expect(idx).toBeGreaterThan(-1)
    expect(popupSource.slice(Math.max(0, idx - 120), idx)).toContain('if (!active) return')
  })

  it('guards scheduling in both promise branches', () => {
    expect(popupSource).toContain('const schedule = (delayMs: number): void => {')
    expect(popupSource).toContain(
      'schedule(snapshot && snapshot.total > 0 ? POLL_ACTIVE_MS : POLL_IDLE_MS)',
    )
    expect(popupSource).toContain('.catch(() => schedule(POLL_IDLE_MS))')
  })

  it('clears the active flag before clearing the timer on cleanup', () => {
    const activeIdx = popupSource.indexOf('active = false')
    const clearIdx = popupSource.indexOf('clearTimeout(handle)')
    expect(activeIdx).toBeGreaterThan(-1)
    expect(clearIdx).toBeGreaterThan(activeIdx)
  })
})

describe('the "Saved" feedback timer is owned (cancel-before-rearm, unmount cleanup)', () => {
  it('cancels the prior timer before rearming with the same 1200ms delay', () => {
    expect(popupSource).toContain('clearTimeout(savedTimer.current)')
    expect(popupSource).toContain('savedTimer.current = setTimeout(() => {')
    expect(popupSource).toContain('setSaved(false)')
    expect(popupSource).toContain('}, 1200)')
  })

  it('unmount cancels the pending saved timer', () => {
    expect(popupSource).toContain('return () => clearTimeout(savedTimer.current)')
  })
})
