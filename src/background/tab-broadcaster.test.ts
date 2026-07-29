import { describe, it, expect, vi } from 'vitest'
import { Schema } from 'effect'
import { fakeBrowser } from 'wxt/testing'
import { makeTabBroadcaster, type TabsPort } from './tab-broadcaster'
import { allPlatformHostMatch } from '../core/adapters/catalog'
import { projectContentSettings, Settings } from '../core/schema'

// The tab-broadcaster shell proves the irreversible boundary: Locate is read-only;
// Clear has one explicit tab id and never falls through after a lost reply.

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

/** A fake TabsPort: fixed open-tab ids + a per-tab response (an Error ⇒ a dead tab). */
function fakeTabs(ids: number[], responses: Record<number, unknown> = {}) {
  const sent: Array<{ tabId: number; message: unknown }> = []
  return {
    sent,
    queryPlatformTabs: vi.fn<TabsPort['queryPlatformTabs']>(async () => ids),
    sendTabMessage: vi.fn<TabsPort['sendTabMessage']>(async (tabId, message) => {
      sent.push({ tabId, message })
      const r = responses[tabId]
      if (r instanceof Error) throw r
      return r
    }),
  }
}

const locateResp = (...scopes: ReadonlyArray<'bookmark' | 'like' | 'notInterested'>) => ({
  _tag: 'LocateClearTweetResponse',
  mounted: true,
  results: scopes.map((scope) => ({ scope, state: 'actionable' })),
})

describe('locateClearTweet — read-only targeting', () => {
  it('queries every tab, with the origin first, and retains every mounted candidate', async () => {
    const tabs = fakeTabs([1, 2, 3], {
      1: { _tag: 'LocateClearTweetResponse', mounted: false },
      2: locateResp('bookmark'),
      3: locateResp('bookmark'),
    })
    const res = await makeTabBroadcaster(tabs).locateClearTweet('1', ['bookmark'], 2, false)
    expect(res.map(({ tabId }) => tabId)).toEqual([2, 3])
    expect(tabs.sent.map((s) => s.tabId)).toEqual([2, 1, 3])
    expect(
      tabs.sent.every((s) => (s.message as { _tag: string })._tag === 'LocateClearTweetRequest'),
    ).toBe(true)
  })

  it('drops malformed replies rather than selecting a destructive target', async () => {
    const tabs = fakeTabs([1, 2], {
      1: { _tag: 'LocateClearTweetResponse', mounted: true, results: [] },
      2: locateResp('like'),
    })
    const res = await makeTabBroadcaster(tabs).locateClearTweet('1', ['like'])
    expect(res.map(({ tabId }) => tabId)).toEqual([2])
  })

  it('sends exact location payload including a 20-digit snowflake', async () => {
    const id = '12345678901234567890'
    const tabs = fakeTabs([1], { 1: locateResp('bookmark', 'like') })
    await makeTabBroadcaster(tabs).locateClearTweet(id, ['bookmark', 'like'], 1, true)
    expect(tabs.sent[0]!.message).toEqual({
      _tag: 'LocateClearTweetRequest',
      tweetId: id,
      scopes: ['bookmark', 'like'],
      allLists: true,
    })
  })
})

describe('clearTweetInTab — one destructive target', () => {
  it('sends once to the named tab and returns its exact per-scope reply', async () => {
    const tabs = fakeTabs([1, 2], {
      2: {
        _tag: 'ClearTweetResponse',
        results: [{ scope: 'bookmark', state: 'cleared' }],
      },
    })
    const result = await makeTabBroadcaster(tabs).clearTweetInTab(2, '1', ['bookmark'], false)
    expect(result).toEqual({
      _tag: 'ClearTweetResponse',
      results: [{ scope: 'bookmark', state: 'cleared' }],
    })
    expect(tabs.sent).toEqual([
      {
        tabId: 2,
        message: {
          _tag: 'ClearTweetRequest',
          tweetId: '1',
          scopes: ['bookmark'],
          allLists: false,
        },
      },
    ])
  })

  it('turns a lost or malformed reply into undefined and never sends a second tab', async () => {
    const tabs = fakeTabs([1, 2], { 2: { _tag: 'ClearTweetResponse', results: [] } })
    const result = await makeTabBroadcaster(tabs).clearTweetInTab(2, '1', ['bookmark'], false)
    expect(result).toBeUndefined()
    expect(tabs.sent.map((s) => s.tabId)).toEqual([2])
  })
})

describe('reportTransferOutcome', () => {
  it('fans the terminal outcome out to every open registered-platform tab', async () => {
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

  it('does not infer artifact kind from a valid media key suffix', async () => {
    const tabs = fakeTabs([1, 2])
    makeTabBroadcaster(tabs).reportTransferOutcome('req-1.json', 'complete', 1234)
    await tick()
    expect(tabs.sent).toHaveLength(2)
  })
})

// defaultTabsPort (the real browser.tabs binding) isn't exported — every other
// test in this file drives the shell through an injected TabsPort fake, since
// fake-browser implements neither tabs.query's url-pattern match nor
// tabs.sendMessage (see the TabsPort doc comment). To pin the LIVE-BUG FIX
// itself — that the query widened off X_HOST_MATCH alone — spy on the global
// `browser.tabs.query` the default port calls through, and construct the
// broadcaster with NO injected port so it falls back to `defaultTabsPort()`.
describe('defaultTabsPort.queryPlatformTabs — registered host query', () => {
  it('queries browser.tabs with every cataloged platform match, not X alone', async () => {
    fakeBrowser.reset()
    const spy = vi.spyOn(fakeBrowser.tabs, 'query')
    await makeTabBroadcaster().queryPlatformTabs()
    expect(spy).toHaveBeenCalledWith({ url: [...allPlatformHostMatch()] })
    const [{ url: queried }] = spy.mock.calls[0]!
    expect(queried).toEqual(expect.arrayContaining(['https://www.instagram.com/*']))
    expect(queried).toEqual(
      expect.arrayContaining(['https://www.threads.net/*', 'https://www.threads.com/*']),
    )
    expect(queried).toEqual(expect.arrayContaining(['https://x.com/*', 'https://twitter.com/*']))
  })
})

describe('broadcastToPlatformTabs', () => {
  const settingsChanged = {
    _tag: 'SettingsChanged' as const,
    settings: projectContentSettings(Schema.decodeUnknownSync(Settings)({})),
  }

  it.each([
    { _tag: 'TransferOutcome' as const, requestId: 'r', outcome: 'complete' as const, at: 0 },
    settingsChanged,
  ])('fans out only a TabBroadcast and swallows a dead tab: $._tag', async (message) => {
    const tabs = fakeTabs([1, 2], { 1: new Error('dead') })
    await expect(makeTabBroadcaster(tabs).broadcastToPlatformTabs(message)).resolves.toBeUndefined()
    expect(tabs.sent.map((s) => s.tabId)).toEqual([1, 2])
  })
})
