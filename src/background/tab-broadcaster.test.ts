import { describe, it, expect, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing'
import {
  makeTabBroadcaster,
  RELEASE_BACKOFF_MS,
  ORPHAN_REPROBE_MS,
  type TabsPort,
} from './tab-broadcaster'
import { allAdapterHostMatch } from '../core/adapters/registry'

// The tab-broadcaster SHELL through an injected TabsPort. Pins the irreversible-clear
// targeting guarantee that clear-session.test.ts mocks away: the origin tab is
// tried FIRST and the loop stops at the first MOUNTED tab, so a background list tab can
// never win and un-bookmark a post meant only for its own feed's clear.

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

const messageTag = (message: unknown): string | undefined => {
  if (typeof message !== 'object' || message === null || !('_tag' in message)) return undefined
  return typeof message._tag === 'string' ? message._tag : undefined
}

/** The release tab's id in every fake port: distinct from any "open tab" id so a
 *  test can always tell a release-tab message from a fan-out one. */
const RELEASE_TAB_ID = 77

/** Instant readiness-poll clock — a never-mounting fake page would otherwise cost
 *  the real poll budget (12s) per test. `now` advances by the poll interval on
 *  every `sleep`, exactly like the real clock, so the leg's wall-clock math
 *  (elapsed, the unreachable/stuck thresholds) runs for real without costing any
 *  actual wall time. Shared across tests — every leg computes `elapsed` relative
 *  to its OWN start, so a monotonically climbing `now` never leaks state between
 *  cases. */
let now = 0
const instantClock = {
  sleep: async () => void (now += 600),
  now: () => now,
}

/** The page-scope pin the ledger entry was seeded with. With all-lists OFF (the
 *  shipped default) a permalink page can click nothing else, so a leg whose pin
 *  authorizes none of the claimed scopes is skipped outright — every test below that
 *  is about the release MECHANICS rather than the pin hands one in. */
const pinned = (scope: 'bookmark' | 'like' = 'bookmark') =>
  ({ source: 'consented', scope }) as const

/** The fail-CLOSED pin: nothing was resolvable when the entry was seeded. */
const NO_PIN = { source: 'none' } as const

/** A fake TabsPort: fixed open-tab ids + a per-tab response (an Error ⇒ a dead tab).
 *  `responses[RELEASE_TAB_ID]` scripts the release tab's answer; `navigateError`
 *  makes the navigation itself reject; `urls` scripts what `tabs.get(id).url` would
 *  return, which only `resolveTabListScope` (the SEED-time reader) consults — an id
 *  with no entry is a closed/off-platform tab. */
function fakeTabs(
  ids: number[],
  responses: Record<number, unknown> = {},
  opts: {
    navigateError?: Error
    urls?: Record<number, string>
    releaseTabId?: number
  } = {},
) {
  const sent: Array<{ tabId: number; message: unknown }> = []
  const navigated: string[] = []
  const reloaded: number[] = []
  // Mirrors the real port: `releaseTabId()` answers `undefined` until the first
  // successful `navigateReleaseTab`, then the reused id for the life of this fake.
  // `opts.releaseTabId` seeds a REUSED tab from an earlier dispatch — the fan-out
  // exclusion tests need one already in place before `sendClearToTabs` ever runs.
  let currentReleaseTabId: number | undefined = opts.releaseTabId
  return {
    sent,
    navigated,
    reloaded,
    queryXTabs: vi.fn<TabsPort['queryXTabs']>(async () => ids),
    sendTabMessage: vi.fn<TabsPort['sendTabMessage']>(async (tabId, message) => {
      sent.push({ tabId, message })
      const configured = responses[tabId]
      const r =
        typeof configured === 'function'
          ? (configured as (message: unknown) => unknown)(message)
          : configured
      if (r instanceof Error) throw r
      return r
    }),
    getTabUrl: vi.fn<TabsPort['getTabUrl']>(async (tabId) => opts.urls?.[tabId]),
    navigateReleaseTab: vi.fn<TabsPort['navigateReleaseTab']>(async (url) => {
      if (opts.navigateError !== undefined) throw opts.navigateError
      navigated.push(url)
      currentReleaseTabId = RELEASE_TAB_ID
      return RELEASE_TAB_ID
    }),
    reloadReleaseTab: vi.fn<TabsPort['reloadReleaseTab']>(async (tabId) => {
      reloaded.push(tabId)
    }),
    releaseTabId: vi.fn<TabsPort['releaseTabId']>(() => currentReleaseTabId),
  }
}

/** A mounted tab's ClearTweetResponse. */
const clearResp = (...scopes: ReadonlyArray<'bookmark' | 'like' | 'notInterested'>) => ({
  mounted: true,
  drainEligible: true,
  results: scopes.map((scope) => ({ scope, ok: true })),
})

/** A release-tab unmounted answer carrying page evidence (Part B) — what the
 *  leg's stuck/error checks actually read. */
const unmountedPage = (page: {
  articles: number
  cells: number
  ready: string
  error: boolean
}) => ({
  mounted: false,
  drainEligible: false,
  results: [],
  page,
})

const stuckPage = unmountedPage({ articles: 0, cells: 0, ready: 'complete', error: false })
const errorPage = unmountedPage({ articles: 0, cells: 0, ready: 'complete', error: true })

const unmounted = (drainEligible: boolean) => ({
  mounted: false,
  drainEligible,
  results: [],
})

describe('sendClearToTabs — clear targeting', () => {
  it('messages the origin tab first and short-circuits at the first mounted tab', async () => {
    const tabs = fakeTabs([1, 2, 3], { 2: clearResp('bookmark') })
    const res = await makeTabBroadcaster(tabs).sendClearToTabs('t1', ['bookmark'], 2)
    expect(res).toEqual([{ scope: 'bookmark', ok: true }])
    expect(tabs.sendTabMessage).toHaveBeenCalledTimes(1) // stopped after the origin tab
    expect(tabs.sent[0]!.tabId).toBe(2) // origin tab tried FIRST, before 1 and 3
    expect(tabs.navigateReleaseTab).not.toHaveBeenCalled()
  })

  it('skips a tab without the article and stops at the first that has it', async () => {
    const tabs = fakeTabs([1, 2, 3], { 1: unmounted(false), 2: clearResp('like') })
    const res = await makeTabBroadcaster(tabs).sendClearToTabs('t1', ['like'])
    expect(res).toEqual([{ scope: 'like', ok: true }])
    expect(tabs.sent.map((s) => s.tabId)).toEqual([1, 2]) // tab 3 never reached
  })

  it('skips a dead tab (thrown sendMessage) and tries the next', async () => {
    const tabs = fakeTabs([1, 2], { 1: new Error('no content script'), 2: clearResp('bookmark') })
    const res = await makeTabBroadcaster(tabs).sendClearToTabs('t1', ['bookmark'])
    expect(res).toEqual([{ scope: 'bookmark', ok: true }])
    expect(tabs.sent.map((s) => s.tabId)).toEqual([1, 2])
  })

  it('fails the claim when no tab has the article and the release tab never mounts it', async () => {
    const tabs = fakeTabs([1, 2], {
      1: unmounted(false),
      2: unmounted(false),
      [RELEASE_TAB_ID]: unmounted(false),
    })
    const res = await makeTabBroadcaster(tabs, { clock: instantClock }).sendClearToTabs(
      't1',
      ['bookmark'],
      undefined,
      undefined,
      pinned(),
    )
    expect(res).toEqual([{ scope: 'bookmark', ok: false }])
    // Budget, not attempt count: 12000ms / 600ms interval = 20 probes.
    expect(tabs.sent.map((s) => s.tabId)).toEqual([1, 2, ...Array(20).fill(RELEASE_TAB_ID)])
  })

  it('falls through past an open-but-empty origin tab to a later mounted tab', async () => {
    // The documented clear-loss case: the origin tab is still OPEN but DOM
    // virtualization scrolled the post out of its view (empty results), so the clear
    // must reach a later tab that still has it — never give up at the origin tab.
    const tabs = fakeTabs([1, 2], { 1: unmounted(true), 2: clearResp('bookmark') })
    const res = await makeTabBroadcaster(tabs).sendClearToTabs('t1', ['bookmark'], 1)
    expect(res).toEqual([{ scope: 'bookmark', ok: true }])
    expect(tabs.navigateReleaseTab).not.toHaveBeenCalled() // a mounted tab short-circuits
    expect(tabs.sent.map((s) => s.tabId)).toEqual([1, 2]) // origin (1) first, then fall through to 2
  })

  it('falls through a wrong-list mounted noop to the matching list tab', async () => {
    const tabs = fakeTabs([1, 2], {
      1: {
        mounted: true,
        drainEligible: false,
        results: [{ scope: 'bookmark', ok: true, noop: true }],
      },
      2: clearResp('bookmark'),
    })

    const res = await makeTabBroadcaster(tabs).sendClearToTabs('t1', ['bookmark'])

    expect(res).toEqual([{ scope: 'bookmark', ok: true }])
    expect(tabs.sent.map((sent) => sent.tabId)).toEqual([1, 2])
  })

  it('tries every immediate tab before navigating the release tab to the permalink', async () => {
    const tabs = fakeTabs([1, 2], {
      1: unmounted(true),
      2: unmounted(false),
      [RELEASE_TAB_ID]: clearResp('bookmark'),
    })

    const res = await makeTabBroadcaster(tabs, { clock: instantClock }).sendClearToTabs(
      't1',
      ['bookmark'],
      undefined,
      undefined,
      pinned(),
    )

    expect(res).toEqual([{ scope: 'bookmark', ok: true }])
    expect(tabs.navigated).toEqual(['https://x.com/i/web/status/t1'])
    expect(tabs.sent).toEqual([
      {
        tabId: 1,
        message: {
          _tag: 'ClearTweetRequest',
          tweetId: 't1',
          scopes: ['bookmark'],
          allLists: undefined,
        },
      },
      {
        tabId: 2,
        message: {
          _tag: 'ClearTweetRequest',
          tweetId: 't1',
          scopes: ['bookmark'],
          allLists: undefined,
        },
      },
      {
        // The release leg forwards the CALLER's allLists (here: absent ⇒ page-scoped),
        // never a hard-coded `true`, and clicks strictly the pinned list — the one the
        // user consented to empty when the download was seeded.
        tabId: RELEASE_TAB_ID,
        message: {
          _tag: 'ClearTweetRequest',
          tweetId: 't1',
          scopes: ['bookmark'],
          allLists: undefined,
          asPageScope: 'bookmark',
        },
      },
    ])
  })

  it('retries a mounted failed clear through the release tab instead of treating the attempt as terminal', async () => {
    const tabs = fakeTabs([1], {
      1: {
        mounted: true,
        drainEligible: true,
        results: [{ scope: 'bookmark', ok: false }],
      },
      [RELEASE_TAB_ID]: clearResp('bookmark'),
    })

    const res = await makeTabBroadcaster(tabs, { clock: instantClock }).sendClearToTabs(
      't1',
      ['bookmark'],
      undefined,
      undefined,
      pinned(),
    )

    expect(res).toEqual([{ scope: 'bookmark', ok: true }])
    expect(tabs.sent.map((sent) => messageTag(sent.message))).toEqual([
      'ClearTweetRequest',
      'ClearTweetRequest',
    ])
  })

  it('never navigates the release tab for a notInterested-only claim (feed-only scope)', async () => {
    const tabs = fakeTabs([1], { 1: unmounted(true) })
    const res = await makeTabBroadcaster(tabs, { clock: instantClock }).sendClearToTabs('t1', [
      'notInterested',
    ])
    expect(res).toEqual([{ scope: 'notInterested', ok: false }])
    expect(tabs.navigateReleaseTab).not.toHaveBeenCalled()
  })

  it('serializes concurrent releases: one navigation of the shared tab at a time', async () => {
    // Two downloads settle back-to-back. The shared release tab can only be on ONE
    // permalink at a time, so the second dispatch must wait out the first — otherwise
    // the loser's clear runs against the winner's page.
    let firstPolls = 0
    let releaseFirst: (() => void) | undefined
    const tabs = fakeTabs([], {
      [RELEASE_TAB_ID]: (message: unknown) => {
        const m = message as { tweetId: string }
        if (m.tweetId === 't1') {
          firstPolls++
          if (firstPolls === 1) {
            return new Promise((resolve) => {
              releaseFirst = () =>
                resolve({
                  mounted: true,
                  drainEligible: false,
                  results: [{ scope: 'bookmark', ok: true }],
                })
            })
          }
        }
        return { mounted: true, drainEligible: false, results: [{ scope: 'like', ok: true }] }
      },
    })
    const b = makeTabBroadcaster(tabs, { clock: instantClock })
    const p1 = b.sendClearToTabs('t1', ['bookmark'], undefined, undefined, pinned())
    const p2 = b.sendClearToTabs('t2', ['like'], undefined, undefined, pinned('like'))
    await vi.waitFor(() => expect(tabs.navigated).toEqual(['https://x.com/i/web/status/t1']))
    expect(tabs.navigated).toHaveLength(1) // t2's navigation is still queued
    releaseFirst!()
    await expect(p1).resolves.toEqual([{ scope: 'bookmark', ok: true }])
    await expect(p2).resolves.toEqual([{ scope: 'like', ok: true }])
    expect(tabs.navigated).toEqual([
      'https://x.com/i/web/status/t1',
      'https://x.com/i/web/status/t2',
    ])
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

  // A1: the release leg used to hard-code allLists:true, so every user on the SHIPPED
  // default (clearAllListsOnSave = false) silently got the aggressive behaviour — a
  // status page has no list scope, so membership gating un-bookmarked AND un-liked any
  // post in both lists, irreversibly. These pin the flag and the page scope that
  // replaces it — a scope PINNED when the entry was seeded, never re-read here.

  it('forwards allLists:true to the release tab and never reads the origin tab url', async () => {
    const tabs = fakeTabs([1], { 1: unmounted(true), [RELEASE_TAB_ID]: clearResp('bookmark') })

    const res = await makeTabBroadcaster(tabs, { clock: instantClock }).sendClearToTabs(
      't1',
      ['bookmark', 'like'],
      1,
      true,
      pinned(),
    )

    expect(res).toEqual([{ scope: 'bookmark', ok: true }])
    // In all-lists mode membership gating is already correct on a permalink page, and a
    // supplied page scope would make shouldClickScope fire a non-member scope — so the
    // wire message carries no `asPageScope` even with a pin in hand.
    expect(tabs.getTabUrl).not.toHaveBeenCalled()
    expect(tabs.sent.at(-1)).toEqual({
      tabId: RELEASE_TAB_ID,
      message: {
        _tag: 'ClearTweetRequest',
        tweetId: 't1',
        scopes: ['bookmark', 'like'],
        allLists: true,
      },
    })
  })

  it('clicks the SEED-TIME pin and never re-reads the origin tab’s url at release time', async () => {
    // The regression this replaces: the origin tab is on /i/bookmarks NOW, but the pin
    // says the user consented on Likes. Re-deriving from the tab would un-bookmark posts
    // they only ever pressed Release for on Likes — irreversible, and reached by nothing
    // more exotic than "now do the other list".
    const t = traceSpy()
    const tabs = fakeTabs(
      [1],
      { 1: unmounted(true), [RELEASE_TAB_ID]: clearResp('like') },
      { urls: { 1: 'https://x.com/i/bookmarks' } },
    )

    const res = await makeTabBroadcaster(tabs, {
      trace: t.trace,
      clock: instantClock,
    }).sendClearToTabs('t1', ['bookmark', 'like'], 1, false, {
      source: 'seeded-origin',
      scope: 'like',
    })

    expect(res).toEqual([{ scope: 'like', ok: true }])
    expect(tabs.getTabUrl).not.toHaveBeenCalled()
    // The fan-out leg is unchanged: a real tab reads its OWN page scope.
    expect(tabs.sent[0]!.message).toEqual({
      _tag: 'ClearTweetRequest',
      tweetId: 't1',
      scopes: ['bookmark', 'like'],
      allLists: false,
    })
    expect(tabs.sent.at(-1)).toEqual({
      tabId: RELEASE_TAB_ID,
      message: {
        _tag: 'ClearTweetRequest',
        tweetId: 't1',
        scopes: ['bookmark', 'like'],
        allLists: false,
        asPageScope: 'like',
      },
    })
    expect(t.releaseScope()).toEqual([
      {
        stage: 'clear-release-scope',
        tweetId: 't1',
        detail: 'origin=1 asPageScope=like source=seeded-origin clickable=true',
      },
    ])
  })

  it('carries a consented sweep scope through to the permalink page', async () => {
    const t = traceSpy()
    const tabs = fakeTabs([1], { 1: unmounted(true), [RELEASE_TAB_ID]: clearResp('bookmark') })

    await makeTabBroadcaster(tabs, { trace: t.trace, clock: instantClock }).sendClearToTabs(
      't1',
      ['bookmark'],
      1,
      false,
      pinned(),
    )

    expect(tabs.sent.at(-1)!.message).toMatchObject({ allLists: false, asPageScope: 'bookmark' })
    expect(t.releaseScope()[0]!.detail).toBe(
      'origin=1 asPageScope=bookmark source=consented clickable=true',
    )
  })
})

// ── The release leg's poll: wall-clock budget, early exits, reload, backoff ──
//
// `tabs=[]` throughout: these are about the LEG mechanics on top of `pinned()`, not
// the fan-out that precedes it (already covered above) — an empty query list means
// every message below is a release-tab probe.
describe('releaseViaStatusTab — poll leg mechanics', () => {
  it('gives up unreachable once every probe has thrown for RELEASE_UNREACHABLE_MS, well short of the budget', async () => {
    const t = traceSpy()
    const tabs = fakeTabs([], { [RELEASE_TAB_ID]: new Error('no content script') })

    const res = await makeTabBroadcaster(tabs, {
      trace: t.trace,
      clock: instantClock,
    }).sendClearToTabs('t1', ['bookmark'], undefined, undefined, pinned())

    expect(res).toEqual([{ scope: 'bookmark', ok: false }])
    // RELEASE_UNREACHABLE_MS(4000) / RELEASE_POLL_INTERVAL_MS(600): elapsed first
    // reaches 4000 on probe 7 (4200ms) — well short of the 20-probe budget.
    expect(tabs.sent.filter((s) => s.tabId === RELEASE_TAB_ID)).toHaveLength(7)
    expect(t.releasePoll()).toEqual([
      {
        stage: 'clear-release-poll',
        tweetId: 't1',
        detail:
          `tab=${RELEASE_TAB_ID} probes=7 threw=7 unmounted=0 lastArticles=none ` +
          'lastCells=none lastReady=none lastError=none reloaded=false elapsedMs=4200 ' +
          'reason=unreachable',
      },
    ])
  })

  it('reloads once on a stuck permalink (articles=0 cells=0 ready=complete) and still exhausts the budget', async () => {
    const t = traceSpy()
    const tabs = fakeTabs([], { [RELEASE_TAB_ID]: stuckPage })

    const res = await makeTabBroadcaster(tabs, {
      trace: t.trace,
      clock: instantClock,
    }).sendClearToTabs('t1', ['bookmark'], undefined, undefined, pinned())

    expect(res).toEqual([{ scope: 'bookmark', ok: false }])
    expect(tabs.reloaded).toEqual([RELEASE_TAB_ID]) // exactly one reload, never a second
    expect(tabs.sent.filter((s) => s.tabId === RELEASE_TAB_ID)).toHaveLength(20) // still pays the full budget
    expect(t.releasePoll()).toEqual([
      {
        stage: 'clear-release-poll',
        tweetId: 't1',
        detail:
          `tab=${RELEASE_TAB_ID} probes=20 threw=0 unmounted=20 lastArticles=0 lastCells=0 ` +
          'lastReady=complete lastError=false reloaded=true elapsedMs=12000 reason=exhausted',
      },
    ])
  })

  it('reloads once on X error, backs off after the second, then recovers after RELEASE_BACKOFF_MS', async () => {
    const t = traceSpy()
    const tabs = fakeTabs([], { [RELEASE_TAB_ID]: errorPage })
    const broadcaster = makeTabBroadcaster(tabs, { trace: t.trace, clock: instantClock })

    const first = await broadcaster.sendClearToTabs(
      't1',
      ['bookmark'],
      undefined,
      undefined,
      pinned(),
    )
    expect(first).toEqual([{ scope: 'bookmark', ok: false }])
    expect(tabs.reloaded).toEqual([RELEASE_TAB_ID]) // the FIRST error reloads once
    expect(t.releasePoll().at(-1)!.detail).toContain('reason=page-error')
    expect(t.releasePoll().at(-1)!.detail).toContain('reloaded=true')
    expect(tabs.navigateReleaseTab).toHaveBeenCalledTimes(1)

    // The breaker: the very next leg fails fast, no navigation at all.
    const second = await broadcaster.sendClearToTabs(
      't1',
      ['bookmark'],
      undefined,
      undefined,
      pinned(),
    )
    expect(second).toEqual([{ scope: 'bookmark', ok: false }])
    expect(tabs.navigateReleaseTab).toHaveBeenCalledTimes(1) // still just the first leg's
    expect(tabs.reloaded).toEqual([RELEASE_TAB_ID]) // no second reload — the leg never ran
    expect(t.releasePoll().at(-1)!.detail).toBe(
      'tab=none probes=0 threw=0 unmounted=0 lastArticles=none lastCells=none lastReady=none ' +
        'lastError=none reloaded=false elapsedMs=0 reason=backoff',
    )

    // Past RELEASE_BACKOFF_MS the breaker clears and the leg navigates again.
    now += RELEASE_BACKOFF_MS
    const third = await broadcaster.sendClearToTabs(
      't1',
      ['bookmark'],
      undefined,
      undefined,
      pinned(),
    )
    expect(third).toEqual([{ scope: 'bookmark', ok: false }])
    expect(tabs.navigateReleaseTab).toHaveBeenCalledTimes(2)
  })

  it('mounts on probe 3: reason=mounted, first request bare, later ones carry probe:true', async () => {
    const t = traceSpy()
    let calls = 0
    const tabs = fakeTabs([], {
      [RELEASE_TAB_ID]: () => {
        calls++
        return calls < 3 ? unmounted(false) : clearResp('bookmark')
      },
    })

    const res = await makeTabBroadcaster(tabs, {
      trace: t.trace,
      clock: instantClock,
    }).sendClearToTabs('t1', ['bookmark'], undefined, undefined, pinned())

    expect(res).toEqual([{ scope: 'bookmark', ok: true }])
    const releaseSent = tabs.sent.filter((s) => s.tabId === RELEASE_TAB_ID)
    expect(releaseSent).toHaveLength(3)
    expect(releaseSent.map((s) => (s.message as { probe?: boolean }).probe)).toEqual([
      undefined,
      true,
      true,
    ])
    expect(t.releasePoll()).toEqual([
      {
        stage: 'clear-release-poll',
        tweetId: 't1',
        detail:
          `tab=${RELEASE_TAB_ID} probes=3 threw=0 unmounted=2 lastArticles=none lastCells=none ` +
          'lastReady=none lastError=none reloaded=false elapsedMs=1800 reason=mounted',
      },
    ])
  })
})

// ── R5: a leg that can click nothing is not worth a tab ──
//
// With all-lists off (the shipped default) a permalink page's own `clearableScope` is
// null, so the pin is the ONLY thing `shouldClickScope` can match. When it matches
// nothing claimed, navigating is a GUARANTEED no-op that still costs a background tab
// plus the whole readiness poll (up to RELEASE_POLL_BUDGET_MS), serialized ahead of
// every release behind it.
describe('sendClearToTabs — guaranteed-noop release leg', () => {
  it('skips the leg — and says why — when nothing was pinned', async () => {
    const t = traceSpy()
    const tabs = fakeTabs([1], { 1: unmounted(true), [RELEASE_TAB_ID]: clearResp('bookmark') })

    const res = await makeTabBroadcaster(tabs, {
      trace: t.trace,
      clock: instantClock,
    }).sendClearToTabs('t1', ['bookmark'], 1, false, NO_PIN)

    expect(res).toEqual([{ scope: 'bookmark', ok: false }]) // claim released, retryable
    expect(tabs.navigateReleaseTab).not.toHaveBeenCalled()
    expect(t.releaseScope()[0]!.detail).toBe(
      'origin=1 asPageScope=none source=none clickable=false',
    )
    expect(t.dispatch()[0]!.detail).toContain(
      'release=none outcome=release-skipped fabricated=true',
    )
  })

  it('skips the leg when the pin names a list none of the claimed scopes can use', async () => {
    // The mirror-image silent failure: a Bookmarks-scoped claim against a Likes pin
    // clicks nothing, yet every scope would report ok:true and prune the ledger entry —
    // the post never released, never retried.
    const t = traceSpy()
    const tabs = fakeTabs([1], { 1: unmounted(true), [RELEASE_TAB_ID]: clearResp('bookmark') })

    await makeTabBroadcaster(tabs, { trace: t.trace, clock: instantClock }).sendClearToTabs(
      't1',
      ['bookmark'],
      1,
      false,
      pinned('like'),
    )

    expect(tabs.navigateReleaseTab).not.toHaveBeenCalled()
    expect(t.releaseScope()[0]!.detail).toBe(
      'origin=1 asPageScope=like source=consented clickable=false',
    )
  })

  it('still releases in all-lists mode, where membership alone can fire', async () => {
    const tabs = fakeTabs([1], { 1: unmounted(true), [RELEASE_TAB_ID]: clearResp('bookmark') })

    const res = await makeTabBroadcaster(tabs, { clock: instantClock }).sendClearToTabs(
      't1',
      ['bookmark'],
      1,
      true,
      NO_PIN,
    )

    expect(res).toEqual([{ scope: 'bookmark', ok: true }])
    expect(tabs.navigated).toEqual(['https://x.com/i/web/status/t1'])
  })

  it('omits the pin entirely and still fails closed (no caller, no click)', async () => {
    const tabs = fakeTabs([1], { 1: unmounted(true), [RELEASE_TAB_ID]: clearResp('bookmark') })
    const res = await makeTabBroadcaster(tabs, { clock: instantClock }).sendClearToTabs('t1', [
      'bookmark',
    ])
    expect(res).toEqual([{ scope: 'bookmark', ok: false }])
    expect(tabs.navigateReleaseTab).not.toHaveBeenCalled()
  })
})

// ── resolveTabListScope (the SEED-time reader) ──
//
// The one place a tab url is turned into a list scope. It is asked once, when a
// download starts, and its answer is pinned for the life of that clear.
describe('resolveTabListScope', () => {
  const scopeOf = (url?: string) =>
    makeTabBroadcaster(
      fakeTabs([1], {}, url === undefined ? {} : { urls: { 1: url } }),
    ).resolveTabListScope(1)

  it('names the Bookmarks and Likes lists', async () => {
    await expect(scopeOf('https://x.com/i/bookmarks')).resolves.toBe('bookmark')
    await expect(scopeOf('https://x.com/i/bookmarks/all')).resolves.toBe('bookmark')
    await expect(scopeOf('https://x.com/lambda_functor/likes')).resolves.toBe('like')
  })

  it('rejects a look-alike path on a NON-X host', async () => {
    // `pageScope` reads the path alone, so without the registry host gate any site with
    // a /likes or /bookmarks path would hand back a membership scope — and authorize an
    // irreversible click from a page that has nothing to do with X.
    await expect(scopeOf('https://example.com/i/bookmarks')).resolves.toBeUndefined()
    await expect(scopeOf('https://www.instagram.com/lambda_functor/likes')).resolves.toBeUndefined()
  })

  it('is undefined off a list page, for an unparsable url, and for a gone tab', async () => {
    await expect(scopeOf('https://x.com/lambda_functor')).resolves.toBeUndefined()
    await expect(scopeOf('https://x.com/home')).resolves.toBeUndefined()
    await expect(scopeOf('junk https://x.com/i/bookmarks')).resolves.toBeUndefined()
    await expect(scopeOf(undefined)).resolves.toBeUndefined()
  })
})

/** Collect (stage, detail, tweetId) triples off the injected trace port. */
function traceSpy() {
  const lines: Array<{ stage: string; detail: string; tweetId?: string | undefined }> = []
  return {
    lines,
    trace: (stage: string, detail: string, tweetId?: string) =>
      void lines.push({ stage, detail, tweetId }),
    dispatch: () => lines.filter((l) => l.stage === 'clear-dispatch'),
    errors: () => lines.filter((l) => l.stage === 'clear-tab-error'),
    releaseScope: () => lines.filter((l) => l.stage === 'clear-release-scope'),
    releasePoll: () => lines.filter((l) => l.stage === 'clear-release-poll'),
  }
}

// The dispatch layer never throws, so the caller's `clear-dispatch-failed` trace can
// never fire from here and four different worlds (no tab, orphaned content script,
// dishonored preference, all-noop answer) reach the caller as the same fabricated
// ok:false. These pin the ONE folded line that tells them apart.
describe('sendClearToTabs — clear-dispatch trace', () => {
  it('reports outcome=mounted, fabricated=false when a tab really flipped', async () => {
    const t = traceSpy()
    const tabs = fakeTabs([1, 2], { 2: clearResp('bookmark') })
    await makeTabBroadcaster(tabs, { trace: t.trace }).sendClearToTabs('t1', ['bookmark'], 2)
    expect(t.dispatch()).toEqual([
      {
        stage: 'clear-dispatch',
        tweetId: 't1',
        detail:
          'tabs=2 prefer=2 preferHonored=true tried=2 answered=2:mounted release=none ' +
          'outcome=mounted fabricated=false excluded=none skipped=0 stale=0',
      },
    ])
    expect(t.errors()).toEqual([]) // zero tab-errors on the happy path
  })

  it('reports release=none when a later tab short-circuits before the release leg runs', async () => {
    // Tab 1 mounts the post but no-ops every scope; tab 2 then flips it and
    // short-circuits. The release tab is never navigated — reporting a release tab
    // here would invent a permalink leg that never ran.
    const t = traceSpy()
    const tabs = fakeTabs([1, 2], {
      1: {
        mounted: true,
        drainEligible: true,
        results: [{ scope: 'bookmark', ok: true, noop: true }],
      },
      2: clearResp('bookmark'),
    })
    await makeTabBroadcaster(tabs, { trace: t.trace }).sendClearToTabs('t1', ['bookmark'])
    expect(tabs.navigateReleaseTab).not.toHaveBeenCalled()
    expect(t.dispatch()[0]!.detail).toBe(
      'tabs=2 prefer=none preferHonored=false tried=1,2 answered=1:mounted-noop,2:mounted ' +
        'release=none outcome=mounted fabricated=false excluded=none skipped=0 stale=0',
    )
  })

  it('reports outcome=release-tab, fabricated=false when the release tab flipped it', async () => {
    const t = traceSpy()
    const tabs = fakeTabs([1, 2], {
      1: unmounted(true),
      2: unmounted(false),
      [RELEASE_TAB_ID]: clearResp('bookmark'),
    })
    await makeTabBroadcaster(tabs, { trace: t.trace, clock: instantClock }).sendClearToTabs(
      't1',
      ['bookmark'],
      undefined,
      undefined,
      pinned(),
    )
    expect(t.dispatch()[0]!.detail).toBe(
      'tabs=2 prefer=none preferHonored=false tried=1,2 answered=1:unmounted,2:unmounted ' +
        `release=${RELEASE_TAB_ID} outcome=release-tab fabricated=false excluded=none skipped=0 stale=0`,
    )
  })

  it('hands mounted:false partial immediate results to the release tab and returns its result set', async () => {
    const t = traceSpy()
    const immediateResults = [{ scope: 'like', ok: true }]
    const releaseResults = [
      { scope: 'like', ok: true, noop: true },
      { scope: 'bookmark', ok: true },
    ]
    const tabs = fakeTabs([1], {
      1: {
        mounted: false,
        drainEligible: true,
        results: immediateResults,
      },
      [RELEASE_TAB_ID]: {
        mounted: true,
        drainEligible: false,
        results: releaseResults,
      },
    })

    const res = await makeTabBroadcaster(tabs, {
      trace: t.trace,
      clock: instantClock,
    }).sendClearToTabs('t1', ['like', 'bookmark'], undefined, undefined, pinned())

    expect(res).toEqual(releaseResults)
    expect(res).not.toEqual(immediateResults)
    expect(tabs.sent).toEqual([
      {
        tabId: 1,
        message: {
          _tag: 'ClearTweetRequest',
          tweetId: 't1',
          scopes: ['like', 'bookmark'],
          allLists: undefined,
        },
      },
      {
        tabId: RELEASE_TAB_ID,
        message: {
          _tag: 'ClearTweetRequest',
          tweetId: 't1',
          scopes: ['like', 'bookmark'],
          allLists: undefined,
          asPageScope: 'bookmark',
        },
      },
    ])
    expect(t.dispatch()).toEqual([
      {
        stage: 'clear-dispatch',
        tweetId: 't1',
        detail:
          'tabs=1 prefer=none preferHonored=false tried=1 answered=1:unmounted ' +
          `release=${RELEASE_TAB_ID} outcome=release-tab fabricated=false excluded=none skipped=0 stale=0`,
      },
    ])
  })

  it('reports outcome=release-failed, fabricated=true when the release tab never mounts the article', async () => {
    const t = traceSpy()
    const tabs = fakeTabs([1], {
      1: unmounted(true),
      [RELEASE_TAB_ID]: unmounted(false),
    })
    const res = await makeTabBroadcaster(tabs, {
      trace: t.trace,
      clock: instantClock,
    }).sendClearToTabs('t1', ['bookmark'], undefined, undefined, pinned())
    expect(res).toEqual([{ scope: 'bookmark', ok: false }]) // the fabricated tail
    expect(t.errors()).toEqual([]) // no per-probe clear-tab-error line any more
    expect(t.releasePoll()).toEqual([
      {
        stage: 'clear-release-poll',
        tweetId: 't1',
        detail:
          `tab=${RELEASE_TAB_ID} probes=20 threw=0 unmounted=20 lastArticles=none ` +
          'lastCells=none lastReady=none lastError=none reloaded=false elapsedMs=12000 ' +
          'reason=exhausted',
      },
    ])
    expect(t.dispatch()[0]!.detail).toBe(
      'tabs=1 prefer=none preferHonored=false tried=1 answered=1:unmounted ' +
        `release=${RELEASE_TAB_ID} outcome=release-failed fabricated=true excluded=none skipped=0 stale=0`,
    )
  })

  it('reports outcome=release-failed with release=none when the release tab cannot be navigated', async () => {
    const t = traceSpy()
    const tabs = fakeTabs(
      [1],
      { 1: unmounted(true) },
      { navigateError: new Error('cannot create') },
    )
    const res = await makeTabBroadcaster(tabs, {
      trace: t.trace,
      clock: instantClock,
    }).sendClearToTabs('t1', ['bookmark'], undefined, undefined, pinned())
    expect(res).toEqual([{ scope: 'bookmark', ok: false }])
    expect(t.errors()).toEqual([
      {
        stage: 'clear-tab-error',
        tweetId: 't1',
        detail: 'phase=release-nav reason=cannot-create',
      },
    ])
    expect(t.releasePoll()).toEqual([
      {
        stage: 'clear-release-poll',
        tweetId: 't1',
        detail:
          'tab=none probes=0 threw=0 unmounted=0 lastArticles=none lastCells=none ' +
          'lastReady=none lastError=none reloaded=false elapsedMs=0 reason=nav-failed',
      },
    ])
    expect(t.dispatch()[0]!.detail).toBe(
      'tabs=1 prefer=none preferHonored=false tried=1 answered=1:unmounted ' +
        'release=none outcome=release-failed fabricated=true excluded=none skipped=0 stale=0',
    )
  })

  it('reports outcome=noop-only for a notInterested-only claim when the post WAS mounted but no-op’d', async () => {
    // notInterested is feed-only: the release tab is never navigated for it, so the
    // fabricated tail is still reachable — this is its remaining shape.
    const t = traceSpy()
    const tabs = fakeTabs([1], {
      1: {
        mounted: true,
        drainEligible: false,
        results: [{ scope: 'notInterested', ok: true, noop: true }],
      },
    })
    await makeTabBroadcaster(tabs, { trace: t.trace }).sendClearToTabs('t1', ['notInterested'])
    expect(tabs.navigateReleaseTab).not.toHaveBeenCalled()
    expect(t.dispatch()[0]!.detail).toBe(
      'tabs=1 prefer=none preferHonored=false tried=1 answered=1:mounted-noop release=none ' +
        'outcome=noop-only fabricated=true excluded=none skipped=0 stale=0',
    )
  })

  it('distinguishes a mounted answer that attempted nothing at all (mounted-empty)', async () => {
    const t = traceSpy()
    const tabs = fakeTabs([1], { 1: { mounted: true, drainEligible: false, results: [] } })
    await makeTabBroadcaster(tabs, { trace: t.trace }).sendClearToTabs('t1', ['notInterested'])
    expect(t.dispatch()[0]!.detail).toContain('answered=1:mounted-empty')
    expect(t.dispatch()[0]!.detail).toContain('outcome=noop-only fabricated=true')
  })

  it('reports outcome=exhausted for a notInterested-only claim with tabs=0', async () => {
    const t = traceSpy()
    const tabs = fakeTabs([])
    await makeTabBroadcaster(tabs, { trace: t.trace }).sendClearToTabs('t1', ['notInterested'])
    expect(t.dispatch()[0]!.detail).toBe(
      'tabs=0 prefer=none preferHonored=false tried=none answered=none release=none ' +
        'outcome=exhausted fabricated=true excluded=none skipped=0 stale=0',
    )
  })

  it('releases even with tabs=0: the release tab opens the permalink on its own', async () => {
    // The whole point of the release tab: no X tab needs to be open at all for a
    // settled download's bookmark to be released.
    const t = traceSpy()
    const tabs = fakeTabs([], { [RELEASE_TAB_ID]: clearResp('bookmark') })
    const res = await makeTabBroadcaster(tabs, {
      trace: t.trace,
      clock: instantClock,
    }).sendClearToTabs('t1', ['bookmark'], undefined, undefined, pinned())
    expect(res).toEqual([{ scope: 'bookmark', ok: true }])
    expect(t.dispatch()[0]!.detail).toBe(
      'tabs=0 prefer=none preferHonored=false tried=none answered=none ' +
        `release=${RELEASE_TAB_ID} outcome=release-tab fabricated=false excluded=none skipped=0 stale=0`,
    )
  })

  it('separates a live-but-silent tab (no-answer) from an unmounted one', async () => {
    const t = traceSpy()
    const tabs = fakeTabs([1, 2], {
      2: unmounted(false),
      [RELEASE_TAB_ID]: unmounted(false),
    })
    await makeTabBroadcaster(tabs, { trace: t.trace, clock: instantClock }).sendClearToTabs(
      't1',
      ['bookmark'],
      undefined,
      undefined,
      pinned(),
    )
    expect(t.dispatch()[0]!.detail).toContain('answered=1:no-answer,2:unmounted')
    expect(t.dispatch()[0]!.detail).toContain('outcome=release-failed')
  })

  it('reports preferHonored=false when the preferred tab is not among the open ids', async () => {
    const t = traceSpy()
    const tabs = fakeTabs([1, 2], {
      1: unmounted(false),
      2: unmounted(false),
      [RELEASE_TAB_ID]: clearResp('bookmark'),
    })
    await makeTabBroadcaster(tabs, { trace: t.trace, clock: instantClock }).sendClearToTabs(
      't1',
      ['bookmark'],
      9,
      undefined,
      pinned(),
    )
    // prefer is still reported (9) so the log shows WHICH tab the user was watching,
    // even though the dispatch silently degraded to broadcast order.
    expect(t.dispatch()[0]!.detail).toContain('tabs=2 prefer=9 preferHonored=false tried=1,2')
    expect(t.dispatch()[0]!.detail).toContain(`release=${RELEASE_TAB_ID} outcome=release-tab`)
  })

  it('folds immediate tab errors into one dispatch line and keeps a release-nav error explicit', async () => {
    const t = traceSpy()
    const tabs = fakeTabs(
      [1, 2],
      {
        1: new Error('Could not establish connection. Receiving end does not exist.'),
        2: unmounted(true),
      },
      { navigateError: new Error('The message port closed before a response was received.') },
    )
    await makeTabBroadcaster(tabs, { trace: t.trace, clock: instantClock }).sendClearToTabs(
      't1',
      ['bookmark'],
      undefined,
      undefined,
      pinned(),
    )

    expect(t.errors()).toEqual([
      {
        stage: 'clear-tab-error',
        tweetId: 't1',
        detail: 'phase=release-nav reason=the-message-port-closed-before-a-response-was-received',
      },
    ])
    expect(t.dispatch()).toHaveLength(1)
    expect(t.dispatch()[0]!.detail).toContain('answered=1:no-receiver,2:unmounted')
    expect(t.dispatch()[0]!.detail).toContain('release=none outcome=release-failed fabricated=true')
    expect(t.dispatch()[0]!.detail).toContain(
      'clearErrors=could-not-establish-connection-receiving-end-does-not-exist:1',
    )
  })

  it('folds a url out of an aggregated clear error instead of leaking a path', async () => {
    const t = traceSpy()
    const tabs = fakeTabs([1], {
      1: new Error('failed on https://x.com/alice/status/123'),
      [RELEASE_TAB_ID]: clearResp('bookmark'),
    })
    await makeTabBroadcaster(tabs, { trace: t.trace, clock: instantClock }).sendClearToTabs(
      't1',
      ['bookmark'],
      undefined,
      undefined,
      pinned(),
    )

    expect(t.dispatch()[0]!.detail).toContain('clearErrors=failed-on-url:1')
    expect(t.dispatch()[0]!.detail).not.toContain('alice')
  })

  it('is a silent no-op with the trace port omitted, returning the identical results', async () => {
    const withTrace = traceSpy()
    const tabs = fakeTabs([1, 2], {
      1: new Error('dead'),
      2: unmounted(false),
      [RELEASE_TAB_ID]: unmounted(false),
    })
    const traced = await makeTabBroadcaster(tabs, {
      trace: withTrace.trace,
      clock: instantClock,
    }).sendClearToTabs('t1', ['bookmark', 'like'], 2, undefined, pinned())
    const plainTabs = fakeTabs([1, 2], {
      1: new Error('dead'),
      2: unmounted(false),
      [RELEASE_TAB_ID]: unmounted(false),
    })
    const plain = makeTabBroadcaster(plainTabs, { clock: instantClock })
    await expect(
      plain.sendClearToTabs('t1', ['bookmark', 'like'], 2, undefined, pinned()),
    ).resolves.toEqual(traced)
    expect(withTrace.lines.length).toBeGreaterThan(0) // the traced run really did emit
    expect(plainTabs.sent).toEqual(tabs.sent) // identical fan-out, no extra messages
  })
})

// ── Part D: exclude the release tab from fan-out, skip proven-dead tabs ──
describe('sendClearToTabs — Part D: fan-out exclusion and orphan skip', () => {
  it('excludes an already-reused release tab from the immediate fan-out, but the leg still uses it', async () => {
    const t = traceSpy()
    const tabs = fakeTabs(
      [1, RELEASE_TAB_ID], // the release tab is open and matches queryXTabs' host pattern
      { 1: unmounted(true), [RELEASE_TAB_ID]: clearResp('bookmark') },
      { releaseTabId: RELEASE_TAB_ID }, // …and already reused from an earlier dispatch
    )

    const res = await makeTabBroadcaster(tabs, {
      trace: t.trace,
      clock: instantClock,
    }).sendClearToTabs('t1', ['bookmark'], undefined, undefined, pinned())

    expect(res).toEqual([{ scope: 'bookmark', ok: true }])
    expect(tabs.sent.map((s) => s.tabId)).toEqual([1, RELEASE_TAB_ID]) // fan-out tried only 1
    expect(tabs.navigated).toEqual(['https://x.com/i/web/status/t1']) // the leg still uses it
    expect(t.dispatch()[0]!.detail).toContain(`excluded=${RELEASE_TAB_ID}`)
    expect(t.dispatch()[0]!.detail).toContain('tried=1 ')
  })

  it('skips a tab after 2 consecutive no-receiver dispatches and re-probes it after 30s', async () => {
    const t = traceSpy()
    let calls = 0
    const tabs = fakeTabs([3], {
      3: () => {
        calls++
        return calls <= 2 ? new Error('no content script') : clearResp('notInterested')
      },
    })
    const b = makeTabBroadcaster(tabs, { trace: t.trace, clock: instantClock })

    await b.sendClearToTabs('t1', ['notInterested']) // dispatch 1: miss #1
    await b.sendClearToTabs('t2', ['notInterested']) // dispatch 2: miss #2 → skipped
    expect(tabs.sendTabMessage).toHaveBeenCalledTimes(2)
    expect(b.staleTabCount()).toBe(1)

    await b.sendClearToTabs('t3', ['notInterested']) // dispatch 3: skipped, not re-probed yet
    expect(tabs.sendTabMessage).toHaveBeenCalledTimes(2) // no third send
    expect(t.dispatch().at(-1)!.detail).toContain('skipped=1')
    expect(t.dispatch().at(-1)!.detail).toContain('stale=1')

    now += ORPHAN_REPROBE_MS
    await b.sendClearToTabs('t4', ['notInterested']) // dispatch 4: due for re-probe
    expect(tabs.sendTabMessage).toHaveBeenCalledTimes(3) // probed again
    expect(t.dispatch().at(-1)!.detail).toContain('skipped=0')
    expect(t.dispatch().at(-1)!.detail).toContain('stale=0') // success cleared the record
    expect(b.staleTabCount()).toBe(0)
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
