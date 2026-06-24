import { describe, it, expect } from 'vitest'
import { isMessageAllowed, isFromExtensionWorker, CONTENT_SCRIPT_TAGS } from './sender-guard'

const OWN = 'self-extension-id'
const UI_TAG = 'CloudConnectRequest' // privileged, UI-only
const CS_TAG = 'DownloadRequest' // content-script-allowed

describe('CONTENT_SCRIPT_TAGS', () => {
  it('is exactly the overlay-sent tag set', () => {
    expect([...CONTENT_SCRIPT_TAGS].toSorted()).toEqual(
      [
        'DownloadRequest',
        'DownloadTraceEvent',
        'RecoverTweetMediaRequest',
        'SweepEnqueueRequest',
      ].toSorted(),
    )
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

  it('allows a content-script tag from an x.com / twitter.com content script', () => {
    expect(
      isMessageAllowed(CS_TAG, { id: OWN, tab: { id: 1 }, origin: 'https://x.com' }, OWN),
    ).toBe(true)
    expect(
      isMessageAllowed(CS_TAG, { id: OWN, tab: { id: 1 }, origin: 'https://twitter.com' }, OWN),
    ).toBe(true)
  })

  it('rejects a UI-only tag arriving from a content script', () => {
    expect(
      isMessageAllowed(UI_TAG, { id: OWN, tab: { id: 1 }, origin: 'https://x.com' }, OWN),
    ).toBe(false)
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

  it('accepts the background worker (our id, no tab)', () => {
    expect(isFromExtensionWorker({ id: OWN }, OWN)).toBe(true)
  })

  it('rejects our own content script (our id, but carries a tab)', () => {
    // The offscreen download sink's only legitimate sender is the background SW.
    // A content script shares the extension id; the `tab` is what distinguishes it.
    expect(isFromExtensionWorker({ id: OWN, tab: { id: 1 } }, OWN)).toBe(false)
  })

  it('treats a null tab as the worker/UI (allowed)', () => {
    expect(isFromExtensionWorker({ id: OWN, tab: null }, OWN)).toBe(true)
  })

  it('rejects when id is missing even if other fields present', () => {
    expect(isFromExtensionWorker({ tab: undefined }, OWN)).toBe(false)
  })
})
