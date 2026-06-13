import { readFileSync } from 'node:fs'
import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { Settings } from '../../core/schema'

const popupCss = readFileSync('src/app.css', 'utf8')
const popupHtml = readFileSync('src/entrypoints/popup/index.html', 'utf8')
const appSource = readFileSync('src/entrypoints/popup/App.tsx', 'utf8')

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

describe('popup settings controls', () => {
  it('exposes a download badge toggle in the same group as the Quick Grab controls', () => {
    const assistStart = appSource.indexOf('title="Assist"')
    expect(assistStart).toBeGreaterThan(-1)
    const assist = appSource.slice(assistStart, appSource.indexOf('</main>', assistStart))

    expect(assist).toContain('checked={settings.quickGrabEnabled}')
    expect(assist).toContain('aria-label="Download badge"')
    expect(assist).toContain('Show download badge on media')
    expect(assist).toContain('checked={settings.downloadBadgeEnabled}')
    expect(assist).toContain('downloadBadgeEnabled: (e.target as HTMLInputElement).checked')
  })

  it('renders the badge toggle on under default settings', () => {
    const defaults = Schema.decodeUnknownSync(Settings)({})
    expect(defaults.downloadBadgeEnabled).toBe(true)
    expect(appSource).toContain('checked={settings.downloadBadgeEnabled}')
  })
})
