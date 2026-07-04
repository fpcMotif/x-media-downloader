import { readFileSync } from 'node:fs'
import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { Settings } from '../../core/schema'

const popupCss = readFileSync('src/app.css', 'utf8')
const popupHtml = readFileSync('src/entrypoints/popup/index.html', 'utf8')
const popupSource = readFileSync('src/entrypoints/popup/App.tsx', 'utf8')
const generalSource = readFileSync('src/entrypoints/options/panels/general.tsx', 'utf8')

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

describe('popup is a focused action surface', () => {
  it('keeps the page worklist actions and a route into the settings page', () => {
    expect(popupSource).toContain('Download this page')
    expect(popupSource).toContain('Download one by one')
    expect(popupSource).toContain('openOptionsPage')
  })

  it('no longer hosts the configuration sections (they moved to the options page)', () => {
    expect(popupSource).not.toContain('aria-label="Download badge"')
    expect(popupSource).not.toContain('Authenticated fallback')
    expect(popupSource).not.toContain('Cloud sync to Convex')
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
    expect(popupSource).toContain('Clear entire list')
    expect(popupSource).toContain('onListPage')
  })
})

describe('popup hosts per-surface clear toggles', () => {
  it('binds the three clear-on-save surface toggles via ScopeToggle', () => {
    // Assert the live two-way bindings (not just the setting keys, which also
    // appeared in the now-removed clearSurfaces summary) so this pins the toggles.
    expect(popupSource).toContain('ScopeToggle')
    expect(popupSource).toContain('update({ autoUnbookmarkOnSave: v })')
    expect(popupSource).toContain('update({ autoUnlikeOnSave: v })')
    expect(popupSource).toContain('update({ autoNotInterestedOnSave: v })')
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
    // openOptionsPage always lands on General; the capture card must carry the
    // #capture hash so the options app opens on the Knowledge Capture panel.
    expect(popupSource).toContain('#capture')
    expect(popupSource).toContain('openCaptureArchive')
  })
})

describe('popup folds monitor-clear into the monitor card', () => {
  it('nests the clear-monitor trigger inside the Download monitor card rather than a separate button above it', () => {
    const monitorCardIdx = popupSource.indexOf('aria-label="Download monitor"')
    const clearTriggerIdx = popupSource.indexOf('clearMonitor()')
    expect(monitorCardIdx).toBeGreaterThan(-1)
    expect(clearTriggerIdx).toBeGreaterThan(monitorCardIdx)
  })
})
