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

  it('recomputes the list-page check from the adapter directly, independent of the other effect', () => {
    expect(popupSource).toContain("adapterForUrl(url)?.platform === 'x'")
  })

  it('names the recognized platform for a non-X adapter instead of implying total inactivity', () => {
    expect(popupSource).toContain('Open X, Instagram, or Threads')
    expect(popupSource).toContain('Ready on this X tab')
    expect(popupSource).toContain('clear/sweep are X-only')
    expect(popupSource).toContain('PLATFORM_LABEL[tabAdapter.platform] ?? tabAdapter.platform')
  })

  it('keeps all four worklist button gates X-only via the onXTab-equivalent condition', () => {
    expect(popupSource).toContain('disabled={!onXTab || drain.busy}')
    expect(popupSource).toContain('disabled={!onXTab || sweep.busy}')
    expect(popupSource).toContain('disabled={!onXTab || clearVisible.busy}')
    expect(popupSource).toContain('disabled={!onListPage || clearWholeList.busy}')
  })
})
