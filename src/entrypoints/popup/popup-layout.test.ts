import { readFileSync } from 'node:fs'
import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { Settings } from '../../core/schema'

const popupCss = readFileSync('src/app.css', 'utf8')
const popupHtml = readFileSync('src/entrypoints/popup/index.html', 'utf8')
const popupSource = readFileSync('src/entrypoints/popup/App.tsx', 'utf8')
const generalSource = readFileSync('src/entrypoints/options/panels/general.tsx', 'utf8')
const captureQuickActionsSource = readFileSync(
  'src/entrypoints/popup/capture-quick-actions.tsx',
  'utf8',
)

const ruleBody = (selector: string): string => {
  const selectorIndex = popupCss.indexOf(selector)
  if (selectorIndex === -1) return ''

  const bodyStart = popupCss.indexOf('{', selectorIndex)
  const bodyEnd = popupCss.indexOf('}', bodyStart)
  if (bodyStart === -1 || bodyEnd === -1) return ''

  return popupCss.slice(bodyStart + 1, bodyEnd)
}

describe('popup layout CSS', () => {
  it('keeps the extension popup inside Chrome action popup bounds', () => {
    const popupRule = ruleBody('.xmd-popup')

    expect(popupRule).toContain('width: min(380px, 100vw);')
    expect(popupRule).toContain('height: 600px;')
    expect(popupRule).toContain('max-height: 600px;')
    expect(popupRule).toContain('overflow: auto;')
  })

  it('anchors the popup document to the action viewport', () => {
    const documentRule = ruleBody('html,\nbody,\n#app')

    expect(documentRule).toContain('width: 380px;')
    expect(documentRule).toContain('min-width: 380px;')
    expect(documentRule).toContain('height: 600px;')
    expect(documentRule).toContain('min-height: 600px;')
    expect(documentRule).toContain('margin: 0;')
    expect(documentRule).toContain('overflow: hidden;')
  })

  it('renders a non-empty fallback before the popup app hydrates', () => {
    expect(popupHtml).toMatch(/html,\s*body,\s*#app/u)
    expect(popupHtml).toContain('height: 600px')
    expect(popupHtml).toContain('class="xmd-boot-fallback"')
    expect(popupHtml).toContain('Loading...')
  })
})

describe('popup is a focused action surface (R4 instrument grammar)', () => {
  it('keeps the page worklist actions and a route into the settings page', () => {
    expect(popupSource).toContain('Download this page')
    expect(popupSource).toContain('One by one')
    expect(popupSource).toContain('openOptionsPage')
  })

  it('no longer hosts the configuration sections (they moved to the options page)', () => {
    expect(popupSource).not.toContain('aria-label="Download badge"')
    expect(popupSource).not.toContain('Authenticated fallback')
    expect(popupSource).not.toContain('Cloud sync to Convex')
  })

  it('drops the Recent downloads list (it duplicates Library → History)', () => {
    expect(popupSource).not.toContain('Recent downloads')
    expect(popupSource).not.toContain('fetchHistory')
  })

  it('has no gear button in the header — Settings lives in the footer only', () => {
    expect(popupSource).not.toContain('GearIcon')
    expect(popupSource).toContain('Settings')
  })
})

describe('settings controls live on the options page', () => {
  it('hosts the download badge toggle alongside the Quick Grab controls in the General panel', () => {
    expect(generalSource).toContain('checked={settings.quickGrabEnabled}')
    expect(generalSource).toContain('aria-label="Download badge"')
    expect(generalSource).toContain('Show download badge on media')
    expect(generalSource).toContain('checked={settings.downloadBadgeEnabled}')
    expect(generalSource).toContain('downloadBadgeEnabled: checked')
  })

  it('renders the badge toggle on under default settings', () => {
    const defaults = Schema.decodeUnknownSync(Settings)({})
    expect(defaults.downloadBadgeEnabled).toBe(true)
    expect(generalSource).toContain('checked={settings.downloadBadgeEnabled}')
  })
})

describe('popup hosts whole-list clear', () => {
  it('offers a list-page-gated whole-list clear that messages the new handler', () => {
    expect(popupSource).toContain('ClearWholeListRequest')
    expect(popupSource).toContain('Clear list')
    expect(popupSource).toContain('onListPage')
  })
})

describe('popup collapses per-surface clear scopes into a mono summary + Edit link', () => {
  it('summarizes the active clear scopes instead of hosting three live switches', () => {
    // R4: the popup is an action surface, not a configuration surface — editing
    // which scopes clear now happens in Settings → Clearing; the popup only
    // reads the three scope settings to render a compact summary.
    expect(popupSource).toContain('clearScopeSummary')
    expect(popupSource).toContain('autoUnbookmarkOnSave')
    expect(popupSource).toContain('autoUnlikeOnSave')
    expect(popupSource).toContain('autoNotInterestedOnSave')
    expect(popupSource).not.toContain('ScopeToggle')
  })

  it('links out to the Clearing settings panel to edit scopes', () => {
    expect(popupSource).toContain('openClearingSettings')
    expect(popupSource).toContain("openOptionsSection('clearing')")
  })
})

describe('popup local-data wipes moved to Settings', () => {
  it('no longer offers download-history or harvest-archive wipes from the popup', () => {
    expect(popupSource).not.toContain('ClearHistoryRequest')
    expect(popupSource).not.toContain('ClearCaptureRequest')
    expect(popupSource).not.toContain('Clear download history')
    expect(popupSource).not.toContain('Clear harvest archive')
  })
})

describe('popup hosts a minimal capture toggle', () => {
  it('lets capturing be toggled from the popup', () => {
    expect(popupSource).toContain('captureEnabled')
    expect(popupSource).toContain('Capture tweets')
  })

  it('no longer hosts the captured-conversation list or per-conversation exports (moved to Settings)', () => {
    expect(popupSource).not.toContain('exportConvo')
    expect(popupSource).not.toContain('Export all (JSONL)')
  })

  it('surfaces the archive size as a deep link into the Knowledge Capture settings panel', () => {
    expect(popupSource).toContain('captureSummary?.tweets')
    // openOptionsPage always lands on General; the capture card must deep-link
    // straight to #capture so the options app opens on the Capture panel.
    expect(popupSource).toContain("openOptionsSection('capture')")
    expect(popupSource).toContain('openCaptureArchive')
  })
})

describe('popup folds monitor-clear into the monitor block', () => {
  it('nests the clear-monitor trigger inside the Download monitor section rather than a separate button above it', () => {
    const monitorIdx = popupSource.indexOf('aria-label="Download monitor"')
    const clearTriggerIdx = popupSource.indexOf('clearMonitor()')
    expect(monitorIdx).toBeGreaterThan(-1)
    expect(clearTriggerIdx).toBeGreaterThan(monitorIdx)
  })
})

describe('CaptureQuickActions renders a popup-sized recent-archive disclosure', () => {
  it('starts collapsed, is hidden with nothing captured, and wires export + clear', () => {
    expect(captureQuickActionsSource).toContain('useState(false)')
    expect(captureQuickActionsSource).toContain('if (tweets === 0) return null')
    expect(captureQuickActionsSource).toContain("runCaptureExport('jsonl')")
    expect(captureQuickActionsSource).toContain("runCaptureExport('tree'")
    expect(captureQuickActionsSource).toContain("runCaptureExport('markdown'")
    expect(captureQuickActionsSource).toContain("_tag: 'ClearCaptureRequest'")
    expect(captureQuickActionsSource).toContain('Export all')
    expect(captureQuickActionsSource).toContain('Clear archive')
  })
})
