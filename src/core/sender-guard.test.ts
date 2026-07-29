import { describe, it, expect } from 'vitest'
import { isMessageAllowed, isFromExtensionWorker, CONTENT_SCRIPT_TAGS } from './sender-guard'
import { originsForAllPlatforms } from './adapters/catalog'

const OWN = 'self-extension-id'
const UI_TAG = 'CloudConnectRequest' // privileged, UI-only
const CS_TAG = 'DownloadRequest' // content-script-allowed
const SETTINGS_UPDATE_TAG = 'SettingsUpdateRequest' // privileged, UI-only
const SETTINGS_READ_TAG = 'SettingsReadRequest' // read-only, content-script-allowed
const DAILY_BUDGET_READ_TAG = 'DailyBudgetReadRequest' // privileged, UI-only

describe('CONTENT_SCRIPT_TAGS', () => {
  it('is exactly the overlay-sent tag set', () => {
    expect([...CONTENT_SCRIPT_TAGS].toSorted()).toEqual(
      [
        'SettingsReadRequest',
        'DownloadRequest',
        'DownloadTraceEvent',
        'RecoverTweetMediaRequest',
        'SweepEnqueueRequest',
        'ClearVisibilityPulse',
        'CaptureEpochRequest',
        'CaptureTweets',
        'SavedStatusRequest',
      ].toSorted(),
    )
  })
})

describe('ALLOWED_CONTENT_SCRIPT_ORIGINS', () => {
  // Pin: the catalog-derived origin set must equal today's literal allow-list
  // exactly, so deriving it from `originsForAllPlatforms()` is a
  // zero-behavior-change refactor (docs/adr/0019-platform-identity-derives-from-adapter-registry.md).
  it('matches the Platform-Catalog-derived origin set exactly', () => {
    expect([...originsForAllPlatforms()].toSorted()).toEqual(
      [
        'https://x.com',
        'https://twitter.com',
        'https://www.instagram.com',
        'https://www.threads.net',
        'https://www.threads.com',
      ].toSorted(),
    )
  })
})

describe('Saved-status sweep', () => {
  // Regression: the overlay's timeline sweep sends SavedStatusRequest from a
  // content script. When the tag was missing from CONTENT_SCRIPT_TAGS the guard
  // dropped every sweep silently (fail-safe overlay → zero chips, no error).
  it('allows the overlay content script to ask SavedStatusRequest', () => {
    expect(
      isMessageAllowed(
        'SavedStatusRequest',
        { id: OWN, tab: { id: 1 }, origin: 'https://x.com' },
        OWN,
      ),
    ).toBe(true)
  })
})

describe('Clear visibility pulse', () => {
  it('allows the content-script wake-up hint, not a privileged clear', () => {
    expect(
      isMessageAllowed(
        'ClearVisibilityPulse',
        { id: OWN, tab: { id: 1 }, origin: 'https://x.com' },
        OWN,
      ),
    ).toBe(true)
  })
})

describe('Clear Log', () => {
  const cs = { id: OWN, tab: { id: 1 }, origin: 'https://x.com' }

  it('allows the UI request but never a content script', () => {
    expect(isMessageAllowed('ClearLogRequest', { id: OWN }, OWN)).toBe(true)
    expect(isMessageAllowed('ClearLogRequest', cs, OWN)).toBe(false)
  })
})

describe('Transfer recovery', () => {
  const cs = { id: OWN, tab: { id: 1 }, origin: 'https://x.com' }

  it('is Options-only', () => {
    expect(isMessageAllowed('TransferRecoveryRequest', { id: OWN }, OWN)).toBe(true)
    expect(isMessageAllowed('TransferRecoveryRequest', cs, OWN)).toBe(false)
    expect(CONTENT_SCRIPT_TAGS.has('TransferRecoveryRequest')).toBe(false)
  })
})

describe('Settings recovery', () => {
  const cs = { id: OWN, tab: { id: 1 }, origin: 'https://x.com' }

  it('is Options-only', () => {
    expect(isMessageAllowed('SettingsRecoveryRequest', { id: OWN }, OWN)).toBe(true)
    expect(isMessageAllowed('SettingsRecoveryRequest', cs, OWN)).toBe(false)
    expect(CONTENT_SCRIPT_TAGS.has('SettingsRecoveryRequest')).toBe(false)
  })
})

describe('Daily budget', () => {
  const cs = { id: OWN, tab: { id: 1 }, origin: 'https://x.com' }

  it('allows UI reads/resets but never a content script', () => {
    for (const tag of ['DailyBudgetReadRequest', 'DailyBudgetResetRequest'] as const) {
      expect(isMessageAllowed(tag, { id: OWN }, OWN)).toBe(true)
      expect(isMessageAllowed(tag, cs, OWN)).toBe(false)
    }
    expect(CONTENT_SCRIPT_TAGS.has(DAILY_BUDGET_READ_TAG)).toBe(false)
  })
})

describe('Tweet Harvest capture tags', () => {
  const cs = { id: OWN, tab: { id: 1 }, origin: 'https://x.com' }
  const ui = { id: OWN }

  it('allows the overlay to read its epoch and push CaptureTweets', () => {
    expect(isMessageAllowed('CaptureEpochRequest', cs, OWN)).toBe(true)
    expect(isMessageAllowed('CaptureTweets', cs, OWN)).toBe(true)
  })

  it('forbids a content script from triggering export/clear/summary (UI-only)', () => {
    for (const tag of [
      'ExportCaptureRequest',
      'ClearCaptureRequest',
      'CaptureSummaryRequest',
    ] as const) {
      expect(isMessageAllowed(tag, cs, OWN)).toBe(false)
    }
  })

  it('allows the options page (no tab) to drive export/clear/summary', () => {
    for (const tag of [
      'ExportCaptureRequest',
      'ClearCaptureRequest',
      'CaptureSummaryRequest',
    ] as const) {
      expect(isMessageAllowed(tag, ui, OWN)).toBe(true)
    }
  })
})

describe('isMessageAllowed', () => {
  it('rejects an undefined sender', () => {
    expect(isMessageAllowed(CS_TAG, undefined, OWN)).toBe(false)
  })

  it('rejects a foreign extension id (any tag)', () => {
    const foreign = { id: 'other-extension', tab: undefined }
    expect(isMessageAllowed(CS_TAG, foreign, OWN)).toBe(false)
    expect(isMessageAllowed(UI_TAG, foreign, OWN)).toBe(false)
  })

  it('allows internal UI (our id, no tab) to send any tag', () => {
    const ui = { id: OWN }
    expect(isMessageAllowed(UI_TAG, ui, OWN)).toBe(true)
    expect(isMessageAllowed(CS_TAG, ui, OWN)).toBe(true)
  })

  it('allows an options document opened in a tab to send UI-only tags', () => {
    const options = {
      id: OWN,
      tab: { id: 1 },
      documentId: 'options-document',
      origin: `chrome-extension://${OWN}`,
      url: `chrome-extension://${OWN}/options.html`,
    }
    expect(isMessageAllowed(UI_TAG, options, OWN)).toBe(true)
    expect(isMessageAllowed('ClearCaptureRequest', options, OWN)).toBe(true)
  })

  it('does not trust a tabbed extension URL for another extension host', () => {
    expect(
      isMessageAllowed(
        UI_TAG,
        {
          id: OWN,
          tab: { id: 1 },
          url: 'chrome-extension://other-extension/options.html',
        },
        OWN,
      ),
    ).toBe(false)
  })

  it('allows a content-script tag from an x.com / twitter.com content script', () => {
    expect(
      isMessageAllowed(CS_TAG, { id: OWN, tab: { id: 1 }, origin: 'https://x.com' }, OWN),
    ).toBe(true)
    expect(
      isMessageAllowed(CS_TAG, { id: OWN, tab: { id: 1 }, origin: 'https://twitter.com' }, OWN),
    ).toBe(true)
  })

  // Regression: the multi-platform adapter work (Instagram/Threads content
  // scripts, wxt.config.ts host_permissions + manifest matches) never updated
  // this guard's origin allow-list, so every overlay-to-background message from
  // an Instagram/Threads tab — DownloadRequest included — was silently dropped
  // (the listener returns false, the caller sees an unanswered `reply: undefined`,
  // never a rejection or a decoded failure list).
  it('allows a content-script tag from an Instagram content script', () => {
    expect(
      isMessageAllowed(
        CS_TAG,
        { id: OWN, tab: { id: 1 }, origin: 'https://www.instagram.com' },
        OWN,
      ),
    ).toBe(true)
  })

  it('allows a content-script tag from a Threads content script (both hosts)', () => {
    expect(
      isMessageAllowed(CS_TAG, { id: OWN, tab: { id: 1 }, origin: 'https://www.threads.net' }, OWN),
    ).toBe(true)
    expect(
      isMessageAllowed(CS_TAG, { id: OWN, tab: { id: 1 }, origin: 'https://www.threads.com' }, OWN),
    ).toBe(true)
  })

  it('rejects a UI-only tag arriving from a content script', () => {
    expect(
      isMessageAllowed(UI_TAG, { id: OWN, tab: { id: 1 }, origin: 'https://x.com' }, OWN),
    ).toBe(false)
  })

  it('allows SettingsUpdateRequest from UI but denies a content script', () => {
    expect(isMessageAllowed(SETTINGS_UPDATE_TAG, { id: OWN }, OWN)).toBe(true)
    expect(
      isMessageAllowed(
        SETTINGS_UPDATE_TAG,
        { id: OWN, tab: { id: 1 }, origin: 'https://x.com' },
        OWN,
      ),
    ).toBe(false)
  })

  it('allows SettingsReadRequest from an allowed content script', () => {
    expect(
      isMessageAllowed(
        SETTINGS_READ_TAG,
        { id: OWN, tab: { id: 1 }, origin: 'https://x.com' },
        OWN,
      ),
    ).toBe(true)
  })

  it('rejects a content script on a non-allowlisted origin', () => {
    expect(
      isMessageAllowed(CS_TAG, { id: OWN, tab: { id: 1 }, origin: 'https://evil.example' }, OWN),
    ).toBe(false)
  })

  it('derives the origin from sender.url when origin is absent', () => {
    expect(
      isMessageAllowed(CS_TAG, { id: OWN, tab: { id: 1 }, url: 'https://x.com/home' }, OWN),
    ).toBe(true)
  })

  it('rejects a content script with neither origin nor url', () => {
    expect(isMessageAllowed(CS_TAG, { id: OWN, tab: { id: 1 } }, OWN)).toBe(false)
  })

  it('rejects a content script with an unparseable url', () => {
    expect(isMessageAllowed(CS_TAG, { id: OWN, tab: { id: 1 }, url: 'not a url' }, OWN)).toBe(false)
  })

  it('treats a null tab as internal UI (allowed)', () => {
    expect(isMessageAllowed(UI_TAG, { id: OWN, tab: null }, OWN)).toBe(true)
  })
})

describe('isFromExtensionWorker', () => {
  it('rejects an undefined sender', () => {
    expect(isFromExtensionWorker(undefined, OWN)).toBe(false)
  })

  it('rejects a foreign extension id', () => {
    expect(isFromExtensionWorker({ id: 'other' }, OWN)).toBe(false)
  })

  it('accepts the background worker (our id, no tab or document id)', () => {
    expect(isFromExtensionWorker({ id: OWN, documentId: undefined }, OWN)).toBe(true)
  })

  it('rejects our own content script (our id, but carries a tab)', () => {
    // The offscreen download sink's only legitimate sender is the background SW.
    // A content script shares the extension id; the `tab` is what distinguishes it.
    expect(isFromExtensionWorker({ id: OWN, tab: { id: 1 } }, OWN)).toBe(false)
  })

  it('treats a null tab as the worker/UI (allowed)', () => {
    expect(isFromExtensionWorker({ id: OWN, tab: null }, OWN)).toBe(true)
  })

  it.each([
    ['popup', 'popup-document-id'],
    ['options', 'options-document-id'],
  ])('rejects our %s document', (_surface, documentId) => {
    expect(isFromExtensionWorker({ id: OWN, documentId }, OWN)).toBe(false)
  })

  it('rejects when id is missing even if other fields present', () => {
    expect(isFromExtensionWorker({ tab: undefined }, OWN)).toBe(false)
  })
})
