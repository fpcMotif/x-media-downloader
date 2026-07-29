import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const popupSource = readFileSync('src/entrypoints/popup/App.tsx', 'utf8')

describe('popup platform identity derives from the data-only catalog (ADR-0019)', () => {
  it('imports platformForUrl from the catalog, not behavior or an X-only matcher', () => {
    expect(popupSource).toContain("import { platformForUrl } from '@/core/adapters/catalog'")
    expect(popupSource).not.toContain("from '@/core/adapters/registry'")
    expect(popupSource).not.toContain("import { isXUrl } from '@/core/adapters/x'")
    expect(popupSource).not.toContain('isXUrl')
  })

  it('holds only the resolved Platform tag, deriving onXTab in the render body', () => {
    expect(popupSource).toContain(
      'const [tabPlatform, setTabPlatform] = useState<Platform | undefined>(undefined)',
    )
    expect(popupSource).toContain('setTabPlatform(platformForUrl(url))')
    expect(popupSource).toContain("const onXTab = tabPlatform === 'x'")
  })

  // Stage redesign (§2.2): the list-page/platform-context check is now
  // centralized in `context.ts`'s `tabContext()` — imported and unit-tested
  // there (context.test.ts) rather than re-derived inline in App.tsx. This is
  // a stronger form of the same ADR-0019 safety property (never derive
  // list-page-ness from an X-specific URL matcher; always route through the
  // Platform Catalog's `platform` field): the guarantee now lives in one
  // pure, directly-tested function instead of a string grep on a duplicated
  // inline expression.
  it('derives the tab-context matrix via context.ts, independently of the platform effect', () => {
    expect(popupSource).toContain("from './context'")
    expect(popupSource).toContain('setCtx(tabContext(url))')
    expect(popupSource).toContain('setScope(tabScope(url))')
  })
})

describe('Stage zone gates its buttons X-only via onXTab', () => {
  it('keeps the drain/sweep gates X-only', () => {
    expect(popupSource).toContain('disabled={!onXTab || active !== null}')
  })

  it('does not expose download-free destructive release actions', () => {
    expect(popupSource).not.toContain('ReleaseCluster')
    expect(popupSource).not.toContain("{ kind: 'release-page' }")
    expect(popupSource).not.toContain("{ kind: 'release-list' }")
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

describe('PopupActions owns action state and notice expiry', () => {
  it('constructs one action owner and renders its cluster notices', () => {
    expect(popupSource).toContain('makePopupActions')
    expect(popupSource).toContain('actions.subscribe(() => setActionView(actions.inspect()))')
    expect(popupSource).toContain('actions.dispose()')
    expect(popupSource).toContain('actionView.notices.download?.text ?? null')
  })

  it('returns first-run persistence to the action owner so it can contain rejection', () => {
    expect(popupSource).toContain('markDone: async () => {')
    expect(popupSource).toContain('const state = await markDone()')
    expect(popupSource).not.toContain('markDone: () => void markDone().then(setIntroState)')
  })

  it('uses automatic scope policy for page downloads and manual scope for Sweep', () => {
    expect(popupSource).toContain("{ kind: 'download-page', releaseAfter: downloadWillClear }")
    expect(popupSource).toContain("{ kind: 'sweep-list', releaseAfter: sweepWillClear }")
    expect(popupSource).toContain('const sweepWillClear = clearCapable && scope !== undefined')
  })
})

describe('Fetched mode permission selection', () => {
  it('uses the shared, behavior-tested selection owner', () => {
    expect(popupSource).toContain("from '@/components/use-fetched-strategy-selection'")
    expect(popupSource).toContain('useFetchedStrategySelection(update, setFetchedNotice)')
  })
})

describe('first-run dismissal', () => {
  it('contains a persistence rejection', () => {
    expect(popupSource).toContain('void markDone()')
    expect(popupSource).toContain('.catch(() => undefined)')
  })
})

describe('Clear Log popup projection', () => {
  it('requests the verified log once on mount and renders its dedicated stateful section', () => {
    expect(popupSource).toContain(
      "import { requestClearLog, type ClearLogOutcome } from '@/core/clear/log-client'",
    )
    expect(popupSource).toContain(
      'const [clearLog, setClearLog] = useState<ClearLogOutcome | null>(null)',
    )
    expect(popupSource).toContain(
      'requestClearLog((request) => browser.runtime.sendMessage(request))',
    )
    expect(popupSource).toContain('if (!cancelled && mounted.current) setClearLog(log)')
    expect(popupSource).toContain('<ClearLogSection log={clearLog} />')
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
