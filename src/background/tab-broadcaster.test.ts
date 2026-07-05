import { describe, it, expect, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing'
import { makeTabBroadcaster, type TabsPort } from './tab-broadcaster'
import { allAdapterHostMatch } from '../core/adapters/registry'

// The tab-broadcaster SHELL through an injected TabsPort. Pins the irreversible-clear
// targeting guarantee that clear-coordinator.test.ts mocks away: the origin tab is
// tried FIRST and the loop stops at the first MOUNTED tab, so a background list tab can
// never win and un-bookmark a post meant only for its own feed's clear.

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

/** A fake TabsPort: fixed open-tab ids + a per-tab response (an Error ⇒ a dead tab). */
function fakeTabs(ids: number[], responses: Record<number, unknown> = {}) {
  const sent: Array<{ tabId: number; message: unknown }> = []
  return {
    sent,
    queryXTabs: vi.fn<TabsPort['queryXTabs']>(async () => ids),
    sendTabMessage: vi.fn<TabsPort['sendTabMessage']>(async (tabId, message) => {
      sent.push({ tabId, message })
      const r = responses[tabId]
      if (r instanceof Error) throw r
      return r
    }),
  }
}

/** A mounted tab's ClearTweetResponse (only `.results` is read by the shell). */
const clearResp = (...scopes: ReadonlyArray<'bookmark' | 'like' | 'notInterested'>) => ({
  results: scopes.map((scope) => ({ scope, ok: true })),
})

describe('sendClearToTabs — clear targeting', () => {
  it('messages the origin tab first and short-circuits at the first mounted tab', async () => {
    const tabs = fakeTabs([1, 2, 3], { 2: clearResp('bookmark') })
    const res = await makeTabBroadcaster(tabs).sendClearToTabs('t1', ['bookmark'], 2)
    expect(res).toEqual({ mounted: true, results: [{ scope: 'bookmark', ok: true }] })
    expect(tabs.sendTabMessage).toHaveBeenCalledTimes(1) // stopped after the origin tab
    expect(tabs.sent[0]!.tabId).toBe(2) // origin tab tried FIRST, before 1 and 3
  })

  it('skips a tab without the article and stops at the first that has it', async () => {
    const tabs = fakeTabs([1, 2, 3], { 1: { results: [] }, 2: clearResp('like') })
    const res = await makeTabBroadcaster(tabs).sendClearToTabs('t1', ['like'])
    expect(res.mounted).toBe(true)
    expect(tabs.sent.map((s) => s.tabId)).toEqual([1, 2]) // tab 3 never reached
  })

  it('skips a dead tab (thrown sendMessage) and tries the next', async () => {
    const tabs = fakeTabs([1, 2], { 1: new Error('no content script'), 2: clearResp('bookmark') })
    const res = await makeTabBroadcaster(tabs).sendClearToTabs('t1', ['bookmark'])
    expect(res.mounted).toBe(true)
    expect(tabs.sent.map((s) => s.tabId)).toEqual([1, 2])
  })

  it('returns mounted:false (defer) when no tab has the article', async () => {
    const tabs = fakeTabs([1, 2], { 1: { results: [] }, 2: { results: [] } })
    const res = await makeTabBroadcaster(tabs).sendClearToTabs('t1', ['bookmark'])
    expect(res).toEqual({ mounted: false, results: [] })
    expect(tabs.sent.map((s) => s.tabId)).toEqual([1, 2]) // every tab tried
  })

  it('falls through past an open-but-empty origin tab to a later mounted tab', async () => {
    // The documented clear-loss case: the origin tab is still OPEN but DOM
    // virtualization scrolled the post out of its view (empty results), so the clear
    // must reach a later tab that still has it — never give up at the origin tab.
    const tabs = fakeTabs([1, 2], { 1: { results: [] }, 2: clearResp('bookmark') })
    const res = await makeTabBroadcaster(tabs).sendClearToTabs('t1', ['bookmark'], 1)
    expect(res.mounted).toBe(true)
    expect(tabs.sent.map((s) => s.tabId)).toEqual([1, 2]) // origin (1) first, then fall through to 2
  })

  it('falls back to natural order when the origin tab is gone', async () => {
    const tabs = fakeTabs([1, 2], { 2: clearResp('bookmark') })
    await makeTabBroadcaster(tabs).sendClearToTabs('t1', ['bookmark'], 9) // 9 not open
    expect(tabs.sent.map((s) => s.tabId)).toEqual([1, 2])
  })

  it('sends a ClearTweetRequest carrying the tweetId, scopes, and allLists flag', async () => {
    const tabs = fakeTabs([1], { 1: clearResp('bookmark') })
    await makeTabBroadcaster(tabs).sendClearToTabs('t99', ['bookmark', 'like'], 1, true)
    expect(tabs.sent[0]!.message).toEqual({
      _tag: 'ClearTweetRequest',
      tweetId: 't99',
      scopes: ['bookmark', 'like'],
      allLists: true,
    })
  })
})

describe('reportTransferOutcome', () => {
  it('fans the terminal outcome out to every open X tab', async () => {
    const tabs = fakeTabs([1, 2])
    makeTabBroadcaster(tabs).reportTransferOutcome('req-1', 'complete', 1234)
    await tick() // fire-and-forget
    expect(tabs.sent.map((s) => s.tabId)).toEqual([1, 2])
    expect(tabs.sent[0]!.message).toEqual({
      _tag: 'TransferOutcome',
      requestId: 'req-1',
      outcome: 'complete',
      at: 1234,
    })
  })

  it('skips a .json sidecar (it carries no badge)', async () => {
    const tabs = fakeTabs([1, 2])
    makeTabBroadcaster(tabs).reportTransferOutcome('req-1.json', 'complete', 1234)
    await tick()
    expect(tabs.sendTabMessage).not.toHaveBeenCalled()
  })
})

// defaultTabsPort (the real browser.tabs binding) isn't exported — every other
// test in this file drives the shell through an injected TabsPort fake, since
// fake-browser implements neither tabs.query's url-pattern match nor
// tabs.sendMessage (see the TabsPort doc comment). To pin the LIVE-BUG FIX
// itself — that the query widened off X_HOST_MATCH alone — spy on the global
// `browser.tabs.query` the default port calls through, and construct the
// broadcaster with NO injected port so it falls back to `defaultTabsPort()`.
describe('defaultTabsPort.queryXTabs — widened host query', () => {
  it('queries browser.tabs with every registered adapter hostMatch, not X alone', async () => {
    fakeBrowser.reset()
    const spy = vi.spyOn(fakeBrowser.tabs, 'query')
    await makeTabBroadcaster().queryXTabs()
    expect(spy).toHaveBeenCalledWith({ url: [...allAdapterHostMatch()] })
    const [{ url: queried }] = spy.mock.calls[0]!
    expect(queried).toEqual(expect.arrayContaining(['*://www.instagram.com/*']))
    expect(queried).toEqual(
      expect.arrayContaining(['*://www.threads.net/*', '*://www.threads.com/*']),
    )
    expect(queried).toEqual(expect.arrayContaining(['*://x.com/*', '*://twitter.com/*']))
  })
})

describe('broadcastToXTabs', () => {
  it('swallows a dead tab without rejecting, and still attempts every tab', async () => {
    const tabs = fakeTabs([1, 2], { 1: new Error('dead') })
    await expect(
      makeTabBroadcaster(tabs).broadcastToXTabs({
        _tag: 'TransferOutcome',
        requestId: 'r',
        outcome: 'complete',
        at: 0,
      }),
    ).resolves.toBeUndefined()
    expect(tabs.sent.map((s) => s.tabId)).toEqual([1, 2])
  })
})
