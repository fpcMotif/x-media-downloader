import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const popupCss = readFileSync('src/app.css', 'utf8')
const popupHtml = readFileSync('src/entrypoints/popup/index.html', 'utf8')
const popupSource = readFileSync('src/entrypoints/popup/App.tsx', 'utf8')
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

describe('popup layout CSS — content-driven height and bubble-safe 320px reflow', () => {
  it('lets the popup render content height min 360 / max 600 and reflow down to 320px without root 100vw collapse', () => {
    const popupRule = ruleBody('.xmd-popup')

    expect(popupRule).toContain('min-width: 320px;')
    expect(popupRule).toContain('max-width: 100%;')
    expect(popupRule).toContain('box-sizing: border-box;')
    expect(popupRule).toContain('overflow-x: hidden;')
    expect(popupRule).toContain('min-height: 360px;')
    expect(popupRule).toContain('max-height: 600px;')
    expect(popupRule).toContain('overflow-y: auto;')
    expect(popupRule).not.toMatch(/(?<!max-)(?<!min-)height: 600px;/u)
  })

  it('does not pin a fixed height on the document shell', () => {
    const documentRule = ruleBody('html,\nbody,\n#app')

    expect(documentRule).toContain('width: 380px;')
    expect(documentRule).toContain('min-width: 380px;')
    expect(documentRule).toContain('margin: 0;')
    expect(documentRule).not.toContain('height:')
    expect(documentRule).not.toContain('max-height:')
    expect(documentRule).not.toContain('overflow: hidden;')
  })

  it('gives the loading frame the same 360px floor so hydrate never jumps', () => {
    const loadingRule = ruleBody('.xmd-popup--loading')
    expect(loadingRule).toContain('min-height: 360px;')
  })

  it('renders a non-empty fallback before the popup app hydrates, matching the 360px floor', () => {
    expect(popupHtml).toMatch(/html,\s*body,\s*#app/u)
    expect(popupHtml).toContain('min-height: 360px')
    expect(popupHtml).not.toContain('height: 600px')
    expect(popupHtml).toContain('class="xmd-boot-fallback"')
    expect(popupHtml).toContain('Loading...')
  })
})
describe('popup save-status toast live region (a11y announcement)', () => {
  it('uses semantic output tag, aria-atomic="true", and conditionally renders saved text', () => {
    expect(popupSource).toContain('<output')
    expect(popupSource).toContain('aria-live="polite"')
    expect(popupSource).toContain('aria-atomic="true"')
    expect(popupSource).toContain('{saved &&')
  })
})

describe('popup Stage zone hosts the X page actions (spec §2.3)', () => {
  it('keeps the page-action verbs and a route into the settings page', () => {
    expect(popupSource).toContain('Download this page')
    expect(popupSource).toContain('One by one')
    expect(popupSource).toContain('openOptions')
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

  it('drops the popup wordmark from the context strip (spec §2.1 zone table)', () => {
    expect(popupSource).not.toContain('X Media Downloader')
  })
})

// The "settings controls live on the options page" badge-toggle assertions
// that used to grep `panels/general.tsx` directly moved to
// `options/panels/saving.test.ts` — that file no longer exists, General having
// been absorbed into the merged Saving panel (Stage redesign §3.3).

describe('the bare "Clear" verb is retired everywhere in the popup (design contract line 3)', () => {
  it('never renders "Clear page", "Clear list", or "Clear archive"', () => {
    expect(popupSource).not.toContain('Clear page')
    expect(popupSource).not.toContain('Clear list')
    expect(popupSource).not.toContain('Clear archive')
    expect(captureQuickActionsSource).not.toContain('Clear archive')
  })

  it('uses the three-verb system instead: Reset / Erase / Release', () => {
    expect(popupSource).toContain('Release this page')
    expect(popupSource).toContain('Release the whole list')
    expect(popupSource).toContain('Reset')
    expect(captureQuickActionsSource).toContain('Erase archive')
    expect(captureQuickActionsSource).toContain('Erase the archive')
  })
})

describe('no native confirm() and no accesskey anywhere in the popup (design contract line 5)', () => {
  it('popup App.tsx', () => {
    expect(popupSource).not.toMatch(/\bconfirm\(/u)
    expect(popupSource).not.toContain('accesskey')
  })

  it('capture-quick-actions.tsx', () => {
    expect(captureQuickActionsSource).not.toMatch(/\bconfirm\(/u)
    expect(captureQuickActionsSource).not.toContain('accesskey')
  })
})

describe('no transition-all anywhere in the popup (spec §2.7)', () => {
  it('popup App.tsx and capture-quick-actions.tsx', () => {
    expect(popupSource).not.toContain('transition-all')
    expect(captureQuickActionsSource).not.toContain('transition-all')
  })
})

describe('popup hosts the whole-list release, gated to list pages via the tab-context matrix', () => {
  it('messages the release handlers and gates the whole-list row to onListPage', () => {
    expect(popupSource).toContain('ClearVisibleRequest')
    expect(popupSource).toContain('ClearWholeListRequest')
    expect(popupSource).toContain('onListPage')
    // ordering pin: the whole-list release request only appears after the
    // onListPage-gated branch of ReleaseCluster begins.
    const onListPageIdx = popupSource.indexOf('onListPage ?')
    const wholeListIdx = popupSource.indexOf('ClearWholeListRequest')
    expect(onListPageIdx).toBeGreaterThan(-1)
    expect(wholeListIdx).toBeGreaterThan(onListPageIdx)
  })

  it('renders the Release cluster only inside the X-context branch', () => {
    expect(popupSource).toContain('ReleaseCluster')
    expect(popupSource).toContain("(ctx === 'x' || ctx === 'x-list') &&")
  })
})

describe('popup collapses per-surface release scopes into a mono summary + Edit link', () => {
  it('summarizes the active release scopes instead of hosting three live switches', () => {
    expect(popupSource).toContain('clearScopeSummary')
    expect(popupSource).toContain('autoUnbookmarkOnSave')
    expect(popupSource).toContain('autoUnlikeOnSave')
    expect(popupSource).toContain('autoNotInterestedOnSave')
    expect(popupSource).not.toContain('ScopeToggle')
  })

  it('links out to the Release settings panel (deep-link updated from #clearing to #release)', () => {
    expect(popupSource).toContain('openReleaseSettings')
    expect(popupSource).toContain("openOptionsSection('release')")
    expect(popupSource).not.toContain("openOptionsSection('clearing')")
  })
})

describe('popup local data: history wipe stays in Settings, harvest wipe moves inline', () => {
  it('does not offer a download-history wipe from the popup', () => {
    expect(popupSource).not.toContain('ClearHistoryRequest')
    expect(popupSource).not.toContain('Clear download history')
  })

  it('offers a harvest-archive wipe via the inline CaptureQuickActions component', () => {
    expect(popupSource).toContain('CaptureQuickActions')
    expect(captureQuickActionsSource).toContain('ClearCaptureRequest')
  })
})

describe('popup hosts a minimal capture toggle', () => {
  it('lets capturing be toggled from the popup', () => {
    expect(popupSource).toContain('captureEnabled')
    expect(popupSource).toContain('Capture tweets')
  })

  it('hosts a trimmed (3-row) recent-conversation list with per-conversation exports via CaptureQuickActions', () => {
    expect(popupSource).toContain('fetchCaptureSummary(3)')
    expect(captureQuickActionsSource).toContain('RECENT_LIMIT')
    expect(captureQuickActionsSource).toContain('Export all')
  })

  it('surfaces the archive size as a deep link into the Capture settings panel', () => {
    expect(popupSource).toContain('captureSummary')
    // openOptionsPage always lands on Saving; the capture card must deep-link
    // straight to #capture so the options app opens on the Capture panel.
    expect(popupSource).toContain("openOptionsSection('capture')")
    expect(popupSource).toContain('openCaptureArchive')
  })

  it('hides Recent Captures entirely on Instagram/Threads tabs (capture is X-only)', () => {
    expect(popupSource).toContain('isMetaContext')
    expect(popupSource).toContain('{!isMetaContext && (')
  })
})

describe('popup folds monitor-reset into the monitor block', () => {
  it('nests the reset trigger inside the Download monitor section rather than a separate button above it', () => {
    const monitorIdx = popupSource.indexOf('aria-label="Download monitor"')
    const resetTriggerIdx = popupSource.indexOf('onClick={onReset}')
    expect(monitorIdx).toBeGreaterThan(-1)
    expect(resetTriggerIdx).toBeGreaterThan(monitorIdx)
  })

  it('drops the dead clearFeedback flash state (monitor unmounts immediately on success)', () => {
    expect(popupSource).not.toContain('clearFeedback')
    expect(popupSource).not.toContain("'Cleared'")
  })
})

describe('CaptureQuickActions renders a popup-sized recent-archive disclosure', () => {
  it('starts collapsed, is hidden with nothing captured, and wires export + Confirm-Strip-gated erase', () => {
    expect(captureQuickActionsSource).toContain('useState(false)')
    // tweets===0 alone must NOT unmount the block — it has to stay mounted
    // while an erase flash is pending (Batch B adversarial review fix).
    expect(captureQuickActionsSource).toContain(
      'if (tweets === 0 && statusMsg === null) return null',
    )
    expect(captureQuickActionsSource).toContain("_tag: 'ClearCaptureRequest'")
    expect(captureQuickActionsSource).toContain('Export all')
    expect(captureQuickActionsSource).toContain('ConfirmStrip')
  })
})

describe('the first-run teaching strip is wired to local:xmd-popup-intro (spec §2.2)', () => {
  it('records opens on mount and dismisses via markDone', () => {
    expect(popupSource).toContain('recordOpen')
    expect(popupSource).toContain('markDone')
    expect(popupSource).toContain('shouldShowIntro')
  })

  it('only shows on X contexts (isXContext), never on IG/Threads/unsupported', () => {
    expect(popupSource).toContain('isXContext(ctx)')
  })
})
