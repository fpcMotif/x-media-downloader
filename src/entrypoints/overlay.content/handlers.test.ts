import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Option } from 'effect'
import {
  GHOST_NOFLIP_LIMIT,
  clearMountedForScope,
  handleClearTweet,
  handleClearDrain,
  handleClearVisible,
  handleClearWholeList,
  handleDrainPage,
  handleSweepPage,
  handleSavedStatusUpdate,
  releaseRunDetail,
  releaseTerminalStage,
  sweepSavedStatus,
  isSavedStatusScope,
  savedStatusVisible,
  dispatchOverlayMessage,
} from './handlers'
import type { HandlerDeps, SendResponse, TrackedSendResult } from './handlers'
import type { ClearTweetResponse, MediaItem } from '@/packages/schema'
import type { PlatformAdapter } from '../../core/adapters/types'
import type { makeDetectionStore } from '../../core/adapters/detection-store'
import type { BadgeState } from '@/packages/overlay/badge'
import { findArticle } from '@/packages/clear/clearer'

/** What a test actually wants to fix about `HandlerDeps` for one scenario. Every
 *  nested port (`adapter`, `location`, `store`, `getBadge`'s return) stays partial
 *  too, since no test ever needs a real `PlatformAdapter`/`Location`/`DetectionStore`
 *  /`BadgeState`, only the one or two fields the handler under test reads off them. */
type HandlerDepsOverrides = Partial<
  Omit<HandlerDeps, 'adapter' | 'location' | 'store' | 'getBadge'>
> & {
  readonly adapter?: Partial<PlatformAdapter>
  readonly location?: Partial<Location>
  readonly store?: Partial<ReturnType<typeof makeDetectionStore>>
  readonly getBadge?: () => Partial<BadgeState>
}

/** Build a `HandlerDeps` test double from only the fields a scenario needs. */
const makeHandlerDeps = (overrides: HandlerDepsOverrides = {}): HandlerDeps => {
  // SAFETY: every field left unset here is simply never read by the handler(s)
  // exercised in this suite — each call site (or the shared `makeDeps`/`depsWith`
  // helpers below) documents which fields matter for its path, same contract the
  // old per-call-site `as unknown as HandlerDeps` casts asserted individually.
  return overrides as HandlerDeps
}

// handleClearTweet is the (previously untested) wiring that decides WHICH scopes
// actually click on a clear: page-scoped by default, membership-driven under
// "Clear from every list", with the detaching page scope ordered LAST and the live
// article re-resolved each iteration. These tests pin that contract — especially the
// "un-bookmarked but not un-liked on the Likes page" regression.

/** A tweet article with a numeric permalink + the requested action controls. Omit a
 *  control to simulate it being absent from the DOM snapshot (e.g. blanked mid
 *  re-render after a prior scope's clear). */
function tweetArticle(opts: {
  tweetId: string
  bookmarked?: boolean
  liked?: boolean
  hideLike?: boolean
}): HTMLElement {
  const el = document.createElement('article')
  el.setAttribute('data-testid', 'tweet')
  const likeBtn = opts.hideLike
    ? ''
    : `<button data-testid="${opts.liked ? 'unlike' : 'like'}"></button>`
  el.innerHTML = `
    <a href="/jack/status/${opts.tweetId}"><time></time></a>
    <button data-testid="${opts.bookmarked ? 'removeBookmark' : 'bookmark'}"></button>
    ${likeBtn}
    <button data-testid="caret"></button>
  `
  return el
}

/** Only the fields handleClearTweet reads (it never touches the badge/launcher/store
 *  state the full HandlerDeps carries). `platform` defaults to 'x' so every
 *  pre-existing call site (all X-DOM scenarios) is unaffected by the gate; tests
 *  proving the off-X no-op override it. */
const makeDeps = (over: {
  clearScope: HandlerDeps['clearScope']
  pathname: string
  runDrain?: HandlerDeps['runDrain']
  reportClear?: HandlerDeps['reportClear']
  platform?: 'x' | 'instagram' | 'threads'
}): HandlerDeps =>
  makeHandlerDeps({
    adapter: { platform: over.platform ?? 'x' },
    document,
    location: { pathname: over.pathname },
    clearScope: over.clearScope,
    clearLog: () => {},
    reportClear: over.reportClear ?? (() => {}),
    runDrain: over.runDrain ?? (async () => []),
  })

/** Narrows a `SendResponse` reply down to `ClearTweetResponse` by its `_tag` —
 *  handleClearTweet only ever answers its sendResponse with this shape (see every
 *  `sendResponse({ _tag: 'ClearTweetResponse', ... })` call in its implementation). */
const isClearTweetResponse = (r: Parameters<SendResponse>[0]): r is ClearTweetResponse =>
  r._tag === 'ClearTweetResponse'

/** Drive the handler to completion (it returns true sync, then resolves async). */
const run = (
  deps: HandlerDeps,
  message: {
    tweetId: string
    scopes: string[]
    allLists?: boolean
    asPageScope?: 'bookmark' | 'like'
    probe?: boolean
  },
): Promise<ClearTweetResponse> =>
  new Promise((resolve) => {
    // This helper exists solely to await handleClearTweet's one async reply for
    // the tests below. handleClearTweet only ever answers with a ClearTweetResponse
    // (see every `sendResponse({ _tag: 'ClearTweetResponse', ... })` call in its
    // implementation) — a mismatched tag throws instead of leaving this Promise to
    // hang forever, so a future regression fails the test fast, not on a timeout.
    handleClearTweet(message, deps, (r) => {
      if (!isClearTweetResponse(r)) {
        throw new Error(`run: expected ClearTweetResponse, got ${r._tag}`)
      }
      resolve(r)
    })
  })

const ALL: string[] = ['bookmark', 'like', 'notInterested']

const mediaItem = (id: string, postId: string): MediaItem => ({
  id,
  platform: 'x',
  postId,
  author: 'jack',
  type: 'photo',
  url: `https://pbs.twimg.com/media/${id}?format=jpg&name=orig`,
  ext: 'jpg',
  index: 0,
})

/** The two inputs `handleSavedStatusUpdate` actually reads — the setting gate and the
 *  platform tag; everything else on HandlerDeps is unreachable from that path. */
const depsWith = (active: boolean, platform: 'x' | 'instagram' | 'threads' = 'x'): HandlerDeps =>
  makeHandlerDeps({
    adapter: { platform },
    document,
    savedStatusActive: () => active,
  })

describe('handleClearTweet — scope wiring', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('on Likes with allLists ON: clears BOTH bookmark and like, page scope (like) LAST', async () => {
    document.body.append(tweetArticle({ tweetId: '101', bookmarked: true, liked: true }))
    const clearScope = vi.fn<HandlerDeps['clearScope']>(async () => true)
    const res = await run(makeDeps({ clearScope, pathname: '/jack/likes' }), {
      tweetId: '101',
      scopes: ALL,
      allLists: true,
    })
    const clicked = clearScope.mock.calls.map((c) => c[1])
    // Both membership scopes fire; notInterested no-ops off the For You feed.
    expect(clicked).toContain('bookmark')
    expect(clicked).toContain('like')
    expect(clicked).not.toContain('notInterested')
    // Detach-last: the cross-list un-bookmark runs BEFORE the page's own un-like.
    expect(clicked.indexOf('bookmark')).toBeLessThan(clicked.indexOf('like'))
    expect(res.results.find((r) => r.scope === 'notInterested')?.noop).toBe(true)
  })

  it('REGRESSION: on Likes, still un-likes when the un-like control is missing from the snapshot (allLists)', async () => {
    // Simulates a prior un-bookmark re-render transiently blanking the un-like button
    // at the moment the handler reads membership. The page's own scope must STILL fire
    // — the post is in this list by definition — or it stays liked ("un-bookmarked but
    // not un-liked"). clearScope does the authoritative re-check at click time.
    document.body.append(tweetArticle({ tweetId: '102', bookmarked: true, hideLike: true }))
    const clearScope = vi.fn<HandlerDeps['clearScope']>(async () => true)
    await run(makeDeps({ clearScope, pathname: '/jack/likes' }), {
      tweetId: '102',
      scopes: ALL,
      allLists: true,
    })
    expect(clearScope.mock.calls.map((c) => c[1])).toContain('like')
  })

  it('on Likes with allLists OFF: only the page scope (like) clicks, bookmark no-ops', async () => {
    document.body.append(tweetArticle({ tweetId: '103', bookmarked: true, liked: true }))
    const clearScope = vi.fn<HandlerDeps['clearScope']>(async () => true)
    const res = await run(makeDeps({ clearScope, pathname: '/jack/likes' }), {
      tweetId: '103',
      scopes: ALL,
      allLists: false,
    })
    expect(clearScope.mock.calls.map((c) => c[1])).toEqual(['like'])
    expect(res.results.find((r) => r.scope === 'bookmark')?.noop).toBe(true)
  })

  it('mounted DOM failure still returns terminal failure results', async () => {
    document.body.append(tweetArticle({ tweetId: '103', liked: true }))
    const res = await run(
      makeDeps({
        clearScope: async () => {
          throw new Error('detached')
        },
        pathname: '/jack/likes',
      }),
      { tweetId: '103', scopes: ['like'], allLists: false },
    )
    expect(res.results).toEqual([{ scope: 'like', ok: false }])
  })

  it('not mounted reports eligibility without starting Drain', async () => {
    const clearScope = vi.fn<HandlerDeps['clearScope']>(async () => true)
    const runDrain = vi.fn<HandlerDeps['runDrain']>()
    const res = await run(makeDeps({ clearScope, runDrain, pathname: '/jack/likes' }), {
      tweetId: '999',
      scopes: ALL,
      allLists: true,
    })
    expect(clearScope).not.toHaveBeenCalled()
    expect(res).toEqual({
      _tag: 'ClearTweetResponse',
      mounted: false,
      drainEligible: true,
      results: [],
      page: { articles: 0, cells: 0, ready: document.readyState, error: false },
    })
    expect(runDrain).not.toHaveBeenCalled()
  })

  it('wrong list is not eligible to Drain when allLists is off', async () => {
    const res = await run(makeDeps({ clearScope: async () => true, pathname: '/jack/likes' }), {
      tweetId: '999',
      scopes: ['bookmark'],
      allLists: false,
    })
    expect(res.drainEligible).toBe(false)
  })

  it('notInterested alone is never eligible for list Drain', async () => {
    const res = await run(makeDeps({ clearScope: async () => true, pathname: '/jack/likes' }), {
      tweetId: '999',
      scopes: ['notInterested'],
      allLists: true,
    })
    expect(res.drainEligible).toBe(false)
  })

  it('REGRESSION: non-x adapter short-circuits to empty results, never touches the DOM', async () => {
    document.body.append(tweetArticle({ tweetId: '104', bookmarked: true, liked: true }))
    const clearScope = vi.fn<HandlerDeps['clearScope']>(async () => true)
    const res = await run(
      makeDeps({ clearScope, pathname: '/jack/likes', platform: 'instagram' }),
      { tweetId: '104', scopes: ALL, allLists: true },
    )
    expect(res).toEqual({
      _tag: 'ClearTweetResponse',
      mounted: false,
      drainEligible: false,
      results: [],
    })
    expect(clearScope).not.toHaveBeenCalled()
  })

  it('worker-authorized Drain returns its terminal results', async () => {
    const runDrain = vi.fn<HandlerDeps['runDrain']>(async () => [{ scope: 'like', ok: true }])
    const response = await new Promise<unknown>((resolve) => {
      handleClearDrain(
        { tweetId: '999', scopes: ['like'], allLists: false },
        makeDeps({
          clearScope: async () => true,
          runDrain,
          pathname: '/jack/likes',
        }),
        resolve,
      )
    })

    expect(runDrain).toHaveBeenCalledWith('999', ['like'], false)
    expect(response).toEqual({
      _tag: 'ClearDrainResponse',
      results: [{ scope: 'like', ok: true }],
    })
  })

  it('worker-authorized Drain converts a thrown DOM path into failure results', async () => {
    const response = await new Promise<unknown>((resolve) => {
      handleClearDrain(
        { tweetId: '999', scopes: ['like'], allLists: false },
        makeDeps({
          clearScope: async () => true,
          runDrain: async () => {
            throw new Error('DOM detached')
          },
          pathname: '/jack/likes',
        }),
        resolve,
      )
    })

    expect(response).toEqual({
      _tag: 'ClearDrainResponse',
      results: [{ scope: 'like', ok: false }],
    })
  })
})

describe('handleClearTweet — Release diagnostics', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('reports request and not-mounted decisions with the tweet id', async () => {
    const reportClear = vi.fn<HandlerDeps['reportClear']>()
    const res = await run(
      makeDeps({ clearScope: async () => true, pathname: '/jack/likes', reportClear }),
      { tweetId: '999', scopes: ['bookmark', 'like'], allLists: true },
    )

    expect(res.mounted).toBe(false)
    expect(reportClear.mock.calls).toEqual([
      [
        'clear-tweet-request',
        'pageScope=like scopes=bookmark,like allLists=true drainEligible=true',
        '999',
      ],
      ['clear-tweet-not-mounted', 'pageScope=like articles=0 drainEligible=true', '999'],
    ])
  })

  it('a quiet probe (probe:true, unmounted) emits neither request nor not-mounted, but still carries page evidence', async () => {
    document.body.append(tweetArticle({ tweetId: '1', bookmarked: true }))
    const reportClear = vi.fn<HandlerDeps['reportClear']>()
    const res = await run(
      makeDeps({ clearScope: async () => true, pathname: '/jack/likes', reportClear }),
      { tweetId: '999', scopes: ['bookmark', 'like'], allLists: true, probe: true },
    )

    expect(res.mounted).toBe(false)
    expect(reportClear).not.toHaveBeenCalled()
    expect(res.page).toEqual({ articles: 1, cells: 0, ready: document.readyState, error: false })
  })

  it('a mounted answer on a probe behaves exactly like a non-probe request: it clicks and reports', async () => {
    document.body.append(tweetArticle({ tweetId: '105', liked: true }))
    const clearScope = vi.fn<HandlerDeps['clearScope']>(async () => true)
    const reportClear = vi.fn<HandlerDeps['reportClear']>()
    const res = await run(makeDeps({ clearScope, pathname: '/jack/likes', reportClear }), {
      tweetId: '105',
      scopes: ['like'],
      allLists: false,
      probe: true,
    })

    expect(res.results).toEqual([{ scope: 'like', ok: true }])
    expect(res.page).toBeUndefined()
    expect(reportClear.mock.calls).toEqual([
      [
        'clear-tweet-request',
        'pageScope=like scopes=like allLists=false drainEligible=true',
        '105',
      ],
      [
        'clear-tweet-result',
        'pageScope=like mounted=true drainEligible=true results=like:ok',
        '105',
      ],
    ])
  })

  it('reports mounted clear results with the tweet id', async () => {
    document.body.append(tweetArticle({ tweetId: '105', liked: true }))
    const clearScope = vi.fn<HandlerDeps['clearScope']>(async () => true)
    const reportClear = vi.fn<HandlerDeps['reportClear']>()
    const res = await run(makeDeps({ clearScope, pathname: '/jack/likes', reportClear }), {
      tweetId: '105',
      scopes: ['like'],
      allLists: false,
    })

    expect(res.results).toEqual([{ scope: 'like', ok: true }])
    expect(reportClear.mock.calls).toEqual([
      [
        'clear-tweet-request',
        'pageScope=like scopes=like allLists=false drainEligible=true',
        '105',
      ],
      [
        'clear-tweet-result',
        'pageScope=like mounted=true drainEligible=true results=like:ok',
        '105',
      ],
    ])
  })
  it('REGRESSION: Bookmarks allLists remounts when page scope fails after cross-scope detach', async () => {
    const tweetId = '2082291973432455198'
    document.body.append(tweetArticle({ tweetId, bookmarked: true, liked: true }))
    const reportClear = vi.fn<HandlerDeps['reportClear']>()
    const clearScope = vi.fn<HandlerDeps['clearScope']>(async (_, scope) => {
      if (scope === 'like') {
        const live = findArticle(document, tweetId)
        if (Option.isSome(live)) live.value.remove()
        return true
      }
      return false
    })

    const res = await run(makeDeps({ clearScope, pathname: '/i/bookmarks', reportClear }), {
      tweetId,
      scopes: ['bookmark', 'like'],
      allLists: true,
    })

    expect(clearScope.mock.calls.map((c) => c[1])).toEqual(['like', 'bookmark'])
    expect(res).toEqual({
      _tag: 'ClearTweetResponse',
      mounted: false,
      drainEligible: true,
      results: [
        { scope: 'like', ok: true },
        { scope: 'bookmark', ok: false },
      ],
    })
    expect(reportClear.mock.calls).toEqual([
      [
        'clear-tweet-request',
        'pageScope=bookmark scopes=bookmark,like allLists=true drainEligible=true',
        tweetId,
      ],
      ['clear-tweet-remount-needed', 'pageScope=bookmark', tweetId],
    ])
  })
  it('keeps mounted true when the page-scope failure leaves the article mounted', async () => {
    const tweetId = '107'
    document.body.append(tweetArticle({ tweetId, bookmarked: true, liked: true }))
    const reportClear = vi.fn<HandlerDeps['reportClear']>()
    const clearScope = vi.fn<HandlerDeps['clearScope']>(async (_, scope) => scope !== 'bookmark')

    const res = await run(makeDeps({ clearScope, pathname: '/i/bookmarks', reportClear }), {
      tweetId,
      scopes: ['bookmark', 'like'],
      allLists: true,
    })

    expect(res).toEqual({
      _tag: 'ClearTweetResponse',
      mounted: true,
      drainEligible: true,
      results: [
        { scope: 'like', ok: true },
        { scope: 'bookmark', ok: false },
      ],
    })
    expect(reportClear.mock.calls.at(-1)).toEqual([
      'clear-tweet-result',
      'pageScope=bookmark mounted=true drainEligible=true results=like:ok,bookmark:failed',
      tweetId,
    ])
  })

  it('keeps mounted true when only a non-page scope fails after the article detaches', async () => {
    const tweetId = '108'
    document.body.append(tweetArticle({ tweetId, bookmarked: true, liked: true }))
    const reportClear = vi.fn<HandlerDeps['reportClear']>()
    const clearScope = vi.fn<HandlerDeps['clearScope']>(async (_, scope) => {
      if (scope === 'bookmark') {
        const live = findArticle(document, tweetId)
        if (Option.isSome(live)) live.value.remove()
        return false
      }
      return true
    })

    const res = await run(makeDeps({ clearScope, pathname: '/jack/likes', reportClear }), {
      tweetId,
      scopes: ['bookmark', 'like'],
      allLists: true,
    })

    expect(res).toEqual({
      _tag: 'ClearTweetResponse',
      mounted: true,
      drainEligible: true,
      results: [
        { scope: 'bookmark', ok: false },
        { scope: 'like', ok: true },
      ],
    })
    expect(reportClear.mock.calls.at(-1)).toEqual([
      'clear-tweet-result',
      'pageScope=like mounted=true drainEligible=true results=bookmark:failed,like:ok',
      tweetId,
    ])
  })

  it('reports mounted clear errors with the tweet id', async () => {
    document.body.append(tweetArticle({ tweetId: '106', liked: true }))
    const reportClear = vi.fn<HandlerDeps['reportClear']>()
    const res = await run(
      makeDeps({
        clearScope: async () => {
          throw new Error('detached')
        },
        pathname: '/jack/likes',
        reportClear,
      }),
      { tweetId: '106', scopes: ['like'], allLists: false },
    )

    expect(res.results).toEqual([{ scope: 'like', ok: false }])
    expect(reportClear.mock.calls).toEqual([
      [
        'clear-tweet-request',
        'pageScope=like scopes=like allLists=false drainEligible=true',
        '106',
      ],
      [
        'clear-tweet-failed',
        'pageScope=like mounted=true drainEligible=true reason=detached results=like:failed',
        '106',
      ],
    ])
  })

  // A1 regression: the permalink release page owns NO list scope, so a page-scoped
  // clear there has nothing to scope to. These three pin the three outcomes.

  it('clears ONLY the background-supplied asPageScope on a permalink page', async () => {
    document.body.append(tweetArticle({ tweetId: '105', bookmarked: true, liked: true }))
    const clearScope = vi.fn<HandlerDeps['clearScope']>(async () => true)

    const res = await run(makeDeps({ clearScope, pathname: '/i/web/status/105' }), {
      tweetId: '105',
      scopes: ['bookmark', 'like'],
      allLists: false,
      asPageScope: 'bookmark',
    })

    expect(clearScope.mock.calls).toEqual([['105', 'bookmark', 'settle']])
    expect(res.results).toEqual([
      { scope: 'like', ok: true, noop: true },
      { scope: 'bookmark', ok: true },
    ])
  })

  it('clicks NOTHING on a permalink page when no asPageScope was supplied', async () => {
    document.body.append(tweetArticle({ tweetId: '105', bookmarked: true, liked: true }))
    const clearScope = vi.fn<HandlerDeps['clearScope']>(async () => true)

    const res = await run(makeDeps({ clearScope, pathname: '/i/web/status/105' }), {
      tweetId: '105',
      scopes: ['bookmark', 'like'],
      allLists: false,
    })

    expect(clearScope).not.toHaveBeenCalled()
    expect(res.results).toEqual([
      { scope: 'bookmark', ok: true, noop: true },
      { scope: 'like', ok: true, noop: true },
    ])
  })

  it('never lets a supplied asPageScope override a real page’s OWN list scope', async () => {
    document.body.append(tweetArticle({ tweetId: '105', bookmarked: true, liked: true }))
    const clearScope = vi.fn<HandlerDeps['clearScope']>(async () => true)

    await run(makeDeps({ clearScope, pathname: '/jack/likes' }), {
      tweetId: '105',
      scopes: ['bookmark', 'like'],
      allLists: false,
      asPageScope: 'bookmark',
    })

    expect(clearScope.mock.calls).toEqual([['105', 'like', 'settle']])
  })

  it('appends asPageScope to the request trace only when one was supplied', async () => {
    const reportClear = vi.fn<HandlerDeps['reportClear']>()
    await run(
      makeDeps({ clearScope: async () => true, pathname: '/i/web/status/105', reportClear }),
      { tweetId: '105', scopes: ['bookmark'], allLists: false, asPageScope: 'bookmark' },
    )

    expect(reportClear.mock.calls[0]).toEqual([
      'clear-tweet-request',
      'pageScope=none scopes=bookmark allLists=false drainEligible=false asPageScope=bookmark',
      '105',
    ])
  })
})

describe('handleClearVisible — platform gate', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('REGRESSION: non-x adapter short-circuits to a not-x reason, never scans the DOM', () => {
    document.body.append(tweetArticle({ tweetId: '201', bookmarked: true }))
    const deps = makeHandlerDeps({
      adapter: { platform: 'instagram' },
      location: { pathname: '/i/bookmarks' },
      clearLog: () => {},
    })
    const querySpy = vi.spyOn(document, 'querySelectorAll')
    const sendResponse = vi.fn<SendResponse>()
    const kept = handleClearVisible({}, deps, sendResponse)
    expect(sendResponse).toHaveBeenCalledWith({
      _tag: 'ClearVisibleResponse',
      cleared: 0,
      reason: 'not-x',
    })
    expect(querySpy).not.toHaveBeenCalled()
    expect(kept).toBeUndefined()
    querySpy.mockRestore()
  })
})

describe('handleClearWholeList — platform gate', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('REGRESSION: non-x adapter short-circuits to a not-x reason, never scrolls or scans', () => {
    document.body.append(tweetArticle({ tweetId: '202', bookmarked: true }))
    const deps = makeHandlerDeps({
      adapter: { platform: 'threads' },
      location: { pathname: '/i/bookmarks' },
      document,
      clearLog: () => {},
    })
    const querySpy = vi.spyOn(document, 'querySelectorAll')
    const sendResponse = vi.fn<SendResponse>()
    const kept = handleClearWholeList({}, deps, sendResponse)
    expect(sendResponse).toHaveBeenCalledWith({
      _tag: 'ClearWholeListResponse',
      cleared: 0,
      reason: 'not-x',
    })
    expect(querySpy).not.toHaveBeenCalled()
    expect(kept).toBe(true)
    querySpy.mockRestore()
  })
})

// Manual Releases are only ever visible via the production trace sink
// (`reportClear` → background `DownloadTraceEvent`), never `clearLog` (DEV-only, page
// console). These pin that the handler wires its stage events through the injected
// sink — behavior observed through `reportClear`, no implementation poking.
describe('handleClearVisible / handleClearWholeList — production trace (reportClear)', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('ClearVisibleRequest emits clear-visible-start and clear-visible-end with the cleared count', async () => {
    document.body.append(tweetArticle({ tweetId: '301', bookmarked: true }))
    const reportClear = vi.fn<HandlerDeps['reportClear']>()
    const deps = makeHandlerDeps({
      adapter: { platform: 'x' },
      document,
      location: { pathname: '/i/bookmarks' },
      clearLog: () => {},
      reportClear,
    })
    const sendResponse = vi.fn<SendResponse>()
    const kept = handleClearVisible({}, deps, sendResponse)
    expect(kept).toBe(true)
    await vi.runAllTimersAsync()

    expect(reportClear).toHaveBeenCalledWith('clear-visible-start', 'bookmark')
    expect(reportClear).toHaveBeenCalledWith('clear-visible-end', 'cleared 1 bookmark')
    expect(sendResponse).toHaveBeenCalledWith({ _tag: 'ClearVisibleResponse', cleared: 1 })
  })

  // Manual release has no poll loop (unlike settle/drain's tweet-clear.ts) — a single
  // read at the existing 350ms pace boundary, reusing the SAME classifyFlip/
  // flipConfirmed vocabulary so `origin=manual` lines read exactly like the other two
  // origins, just with `attempt=1` (one look, not six).
  it('ClearVisibleRequest traces a confirmed flip with origin=manual (single-shot, no poll)', async () => {
    const article = tweetArticle({ tweetId: '310', bookmarked: true })
    article
      .querySelector('[data-testid="removeBookmark"]')!
      .addEventListener('click', () =>
        article
          .querySelector('[data-testid="removeBookmark"]')!
          .setAttribute('data-testid', 'bookmark'),
      )
    document.body.append(article)
    const reportClear = vi.fn<HandlerDeps['reportClear']>()
    const deps = makeHandlerDeps({
      adapter: { platform: 'x' },
      document,
      location: { pathname: '/i/bookmarks' },
      clearLog: () => {},
      reportClear,
    })
    const sendResponse = vi.fn<SendResponse>()
    handleClearVisible({}, deps, sendResponse)
    await vi.runAllTimersAsync()

    expect(reportClear).toHaveBeenCalledWith(
      'clear-flip',
      'scope=bookmark arm=testid attempt=1 elapsedMs=350 target=button disabled=false reresolved=cleared origin=manual',
      '310',
    )
  })

  it('ClearVisibleRequest traces clear-attempt-fail reason=no-flip with origin=manual when the control never changes', async () => {
    document.body.append(tweetArticle({ tweetId: '311', bookmarked: true }))
    const reportClear = vi.fn<HandlerDeps['reportClear']>()
    const deps = makeHandlerDeps({
      adapter: { platform: 'x' },
      document,
      location: { pathname: '/i/bookmarks' },
      clearLog: () => {},
      reportClear,
    })
    const sendResponse = vi.fn<SendResponse>()
    handleClearVisible({}, deps, sendResponse)
    await vi.runAllTimersAsync()

    expect(reportClear).toHaveBeenCalledWith(
      'clear-attempt-fail',
      'scope=bookmark reason=no-flip attempts=1 elapsedMs=350 target=button disabled=false testids=removeBookmark,like origin=manual',
      '311',
    )
  })

  it('ClearVisibleRequest traces a distinct clear-flip-fabricated line when the clicked node detaches but a fresh node for the same id is still a member (origin=manual)', async () => {
    const captured = tweetArticle({ tweetId: '312', bookmarked: true })
    document.body.append(captured)
    captured.querySelector('[data-testid="removeBookmark"]')!.addEventListener('click', () => {
      // The virtualizer detaches the clicked node and mounts a fresh one for the SAME
      // tweetId — still bookmarked, i.e. no mutation ever landed.
      captured.remove()
      document.body.append(tweetArticle({ tweetId: '312', bookmarked: true }))
    })
    const reportClear = vi.fn<HandlerDeps['reportClear']>()
    const deps = makeHandlerDeps({
      adapter: { platform: 'x' },
      document,
      location: { pathname: '/i/bookmarks' },
      clearLog: () => {},
      reportClear,
    })
    const sendResponse = vi.fn<SendResponse>()
    handleClearVisible({}, deps, sendResponse)
    await vi.runAllTimersAsync()

    const detail =
      'scope=bookmark arm=detached attempt=1 elapsedMs=350 target=button disabled=false reresolved=member origin=manual'
    expect(reportClear).toHaveBeenCalledWith('clear-flip', detail, '312')
    expect(reportClear).toHaveBeenCalledWith('clear-flip-fabricated', detail, '312')
  })

  it('ClearVisibleRequest off a list page emits a terminal clear-visible-skip, never a dangling start', async () => {
    const reportClear = vi.fn<HandlerDeps['reportClear']>()
    const deps = makeHandlerDeps({
      adapter: { platform: 'x' },
      document,
      location: { pathname: '/home' },
      clearLog: () => {},
      reportClear,
    })
    const sendResponse = vi.fn<SendResponse>()
    handleClearVisible({}, deps, sendResponse)
    await vi.runAllTimersAsync()

    expect(reportClear).toHaveBeenCalledWith('clear-visible-skip', 'not a Likes/Bookmarks list')
    const stages = reportClear.mock.calls.map((c) => c[0])
    expect(stages).not.toContain('clear-visible-start')
    expect(sendResponse).toHaveBeenCalledWith({
      _tag: 'ClearVisibleResponse',
      cleared: 0,
      reason: 'not-list-page',
    })
  })

  // The two Release rows must refuse with the SAME discriminator: `releasedPageResult`
  // and `releasedListResult` each branch on this one literal, so a rename on one side
  // only would silently return that row to rendering a success-shaped count.
  it('REGRESSION: both Release refusals off a list page carry the identical not-list-page reason', async () => {
    const deps = makeHandlerDeps({
      adapter: { platform: 'x' },
      document,
      location: { pathname: '/home' },
      clearLog: () => {},
      reportClear: () => {},
    })
    const visible = vi.fn<SendResponse>()
    const list = vi.fn<SendResponse>()
    handleClearVisible({}, deps, visible)
    handleClearWholeList({}, deps, list)
    await vi.runAllTimersAsync()

    // ONE literal, asserted against both replies — that shared binding IS the
    // "identical discriminator" claim; two hand-typed strings could drift apart.
    const refusal = { reason: 'not-list-page' }
    expect(visible).toHaveBeenCalledWith(expect.objectContaining(refusal))
    expect(list).toHaveBeenCalledWith(expect.objectContaining(refusal))
  })

  it('ClearWholeListRequest on a bookmarks-page fake emits clear-list stage events through reportClear', async () => {
    const reportClear = vi.fn<HandlerDeps['reportClear']>()
    const deps = makeHandlerDeps({
      adapter: { platform: 'x' },
      document,
      location: { pathname: '/i/bookmarks' },
      reportClear,
    })
    const sendResponse = vi.fn<SendResponse>()
    const kept = handleClearWholeList({}, deps, sendResponse)
    expect(kept).toBe(true)
    await vi.runAllTimersAsync()

    const stages = reportClear.mock.calls.map((c) => c[0])
    expect(stages).toContain('clear-list-start')
    expect(stages).toContain('clear-list-end')
    expect(sendResponse).toHaveBeenCalledWith({ _tag: 'ClearWholeListResponse', cleared: 0 })
  })

  it('REGRESSION: a mid-run Likes→Bookmarks switch stops the sweep — no un-like clicks on the new list', async () => {
    const article = tweetArticle({ tweetId: '203', liked: true })
    document.body.append(article)
    // A mutable Location stand-in: the SPA route change happens DURING the run, which
    // is exactly what the request-time closure could not see.
    const location = { pathname: '/jack/likes' }
    const clicks = vi.fn<() => void>()
    article.addEventListener('click', () => {
      clicks()
      location.pathname = '/i/bookmarks'
    })
    const reportClear = vi.fn<HandlerDeps['reportClear']>()
    const deps = makeHandlerDeps({
      adapter: { platform: 'x' },
      document,
      location,
      reportClear,
    })
    const sendResponse = vi.fn<SendResponse>()
    const kept = handleClearWholeList({}, deps, sendResponse)
    expect(kept).toBe(true)
    await vi.runAllTimersAsync()

    // One pass, not 400: the article stays "liked" (nothing re-renders it here), so a
    // scope-blind loop would keep re-clicking its un-like control on the Bookmarks page.
    expect(clicks).toHaveBeenCalledTimes(1)
    expect(sendResponse).toHaveBeenCalledWith({
      _tag: 'ClearWholeListResponse',
      cleared: 1,
      reason: 'scope-changed',
    })
    expect(reportClear.mock.calls.map((c) => c[0])).toContain('clear-list-abort')
  })
})

describe('handleDrainPage — Release diagnostics', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('Download-this-page stamps one run on the start, hands it to sendTracked, and only replies once the send settles', async () => {
    const items = [mediaItem('m401', '401'), mediaItem('m402', '402')]
    let resolveSend: ((value: TrackedSendResult) => void) | undefined
    const sendDone = new Promise<TrackedSendResult>((resolve) => {
      resolveSend = resolve
    })
    const sendTracked = vi.fn<HandlerDeps['sendTracked']>(() => sendDone)
    const reportClear = vi.fn<HandlerDeps['reportClear']>()
    const deps = makeHandlerDeps({
      store: { values: () => items },
      location: { pathname: '/i/bookmarks' },
      clearLog: () => {},
      sendTracked,
      reportClear,
    })
    const sendResponse = vi.fn<SendResponse>()

    const kept = handleDrainPage({}, deps, sendResponse)

    expect(kept).toBe(true)
    // The run is minted HERE and handed down: that argument, not the page URL, is what
    // authorizes the single terminal (written by sendTracked).
    const release = sendTracked.mock.calls[0]![1]!
    expect(release).toEqual({ scope: 'bookmark', items: 2, run: expect.any(String) })
    expect(reportClear.mock.calls).toEqual([
      ['clear-download-page-start', `scope=bookmark run=${release.run} items=2`],
    ])
    // TERMINAL reply: nothing is answered while the send is still in flight — the old
    // immediate `{ count }` was measured before any work happened.
    expect(sendResponse).not.toHaveBeenCalled()

    resolveSend?.({ ok: true, admitted: 2, skipped: 0 })
    await sendDone
    await Promise.resolve()

    expect(sendResponse).toHaveBeenCalledWith({
      _tag: 'DrainPageResponse',
      count: 2,
      admitted: 2,
      skipped: 0,
      ok: true,
      onList: true,
    })
    // Exactly one line from the handler: the terminal belongs to sendTracked.
    expect(reportClear.mock.calls).toEqual([
      ['clear-download-page-start', `scope=bookmark run=${release.run} items=2`],
    ])
  })

  it('Download-this-page still terminates the trace AND the reply when the send itself throws', async () => {
    const items = [mediaItem('m501', '501')]
    const sendTracked = vi.fn<HandlerDeps['sendTracked']>(async () => {
      throw new Error('background boom')
    })
    const reportClear = vi.fn<HandlerDeps['reportClear']>()
    const deps = makeHandlerDeps({
      store: { values: () => items },
      location: { pathname: '/jack/likes' },
      clearLog: () => {},
      sendTracked,
      reportClear,
    })
    const sendResponse = vi.fn<SendResponse>()

    handleDrainPage({}, deps, sendResponse)
    await Promise.resolve()
    await Promise.resolve()

    expect(sendResponse).toHaveBeenCalledWith({
      _tag: 'DrainPageResponse',
      count: 1,
      admitted: 0,
      skipped: 0,
      ok: false,
      onList: true,
    })
    const release = sendTracked.mock.calls[0]![1]!
    expect(reportClear.mock.calls).toEqual([
      ['clear-download-page-start', `scope=like run=${release.run} items=1`],
      [
        'clear-download-page-failed',
        `scope=like run=${release.run} items=1 reason=background-boom`,
      ],
    ])
  })

  it('off a Likes/Bookmarks list the run still starts, still enqueues, and terminates as a SKIP', async () => {
    const items = [mediaItem('m601', '601')]
    const sendTracked = vi.fn<HandlerDeps['sendTracked']>(async () => ({
      ok: true,
      admitted: 1,
      skipped: 0,
    }))
    const reportClear = vi.fn<HandlerDeps['reportClear']>()
    const deps = makeHandlerDeps({
      store: { values: () => items },
      // A profile timeline: pageScope is None, so the page owns no list to release.
      location: { pathname: '/lambda_functor' },
      clearLog: () => {},
      sendTracked,
      reportClear,
    })
    const sendResponse = vi.fn<SendResponse>()

    handleDrainPage({}, deps, sendResponse)
    await Promise.resolve()
    await Promise.resolve()

    const release = sendTracked.mock.calls[0]![1]!
    // `scope: null` is what makes the terminal a skip — and the items still go out.
    expect(release.scope).toBeNull()
    expect(sendTracked).toHaveBeenCalledWith(items, release)
    expect(reportClear.mock.calls).toEqual([
      ['clear-download-page-start', `scope=none run=${release.run} items=1`],
    ])
    expect(releaseTerminalStage(release.scope, true)).toBe('clear-download-page-skip')
    // …and the reply says so, so the popup cannot promise "each post releases as it
    // finishes" on a page the run has already resolved as having no list.
    expect(sendResponse).toHaveBeenCalledWith({
      _tag: 'DrainPageResponse',
      count: 1,
      admitted: 1,
      skipped: 0,
      ok: true,
      onList: false,
    })
  })

  it('reports the REAL outcome of a fully-deduped batch, not the detection-store size', async () => {
    // The live regression: 7 detected, background answers `0 admitted, 7 skipped`.
    const items = [mediaItem('m701', '701'), mediaItem('m702', '702'), mediaItem('m703', '703')]
    const sendTracked = vi.fn<HandlerDeps['sendTracked']>(async () => ({
      ok: true,
      admitted: 0,
      skipped: 3,
    }))
    const deps = makeHandlerDeps({
      store: { values: () => items },
      location: { pathname: '/jack/likes' },
      clearLog: () => {},
      sendTracked,
      reportClear: vi.fn<HandlerDeps['reportClear']>(),
    })
    const sendResponse = vi.fn<SendResponse>()

    handleDrainPage({}, deps, sendResponse)
    await Promise.resolve()
    await Promise.resolve()

    // `ok` is TRUE here (completed 0 === total 0) — only `admitted` tells the truth.
    expect(sendResponse).toHaveBeenCalledWith({
      _tag: 'DrainPageResponse',
      count: 3,
      admitted: 0,
      skipped: 3,
      ok: true,
      onList: true,
    })
  })

  it('gives consecutive presses distinct run ids', async () => {
    const sendTracked = vi.fn<HandlerDeps['sendTracked']>(async () => ({
      ok: true,
      admitted: 0,
      skipped: 0,
    }))
    const deps = makeHandlerDeps({
      store: { values: () => [] },
      location: { pathname: '/i/bookmarks' },
      clearLog: () => {},
      sendTracked,
      reportClear: vi.fn<HandlerDeps['reportClear']>(),
    })

    handleDrainPage({}, deps, vi.fn<SendResponse>())
    handleDrainPage({}, deps, vi.fn<SendResponse>())
    await Promise.resolve()
    await Promise.resolve()

    const first = sendTracked.mock.calls[0]![1]!.run
    const second = sendTracked.mock.calls[1]![1]!.run
    expect(second).not.toBe(first)
  })
})

describe('Release run line builders', () => {
  it('releaseRunDetail joins a start to its terminal via the run token', () => {
    expect(releaseRunDetail({ scope: 'bookmark', items: 12, run: '4' })).toBe(
      'scope=bookmark run=4 items=12',
    )
  })

  it('releaseRunDetail renders a scope-less run as scope=none', () => {
    expect(releaseRunDetail({ scope: null, items: 7, run: '1' })).toBe('scope=none run=1 items=7')
  })

  it('releaseTerminalStage: a list page ends or fails, a SUCCEEDING scope-less page skips', () => {
    expect(releaseTerminalStage('like', true)).toBe('clear-download-page-end')
    expect(releaseTerminalStage('like', false)).toBe('clear-download-page-failed')
    // A skip is TERMINAL, not a failure — the downloads still went out (mirrors
    // clear-visible-skip).
    expect(releaseTerminalStage(null, true)).toBe('clear-download-page-skip')
  })

  it('releaseTerminalStage: a FAILED run is -failed even off a list page', () => {
    // The scope-first form logged this as `-skip`, so a run on a profile page where the
    // queue answered `completed=3 total=7` left NO failure stage in the log at all —
    // invisible to a diagnostician grepping for one. Same reasoning `sendTracked`'s
    // dead-channel arm already applies: the run started, so losing it is a failure.
    expect(releaseTerminalStage(null, false)).toBe('clear-download-page-failed')
  })
})

describe('handleSweepPage — Release diagnostics', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('Sweep reports request, candidate counts, and queue response without media URLs', async () => {
    document.body.append(
      tweetArticle({ tweetId: '601', bookmarked: true }),
      tweetArticle({ tweetId: '602', bookmarked: true }),
    )
    const items601 = [mediaItem('m601a', '601'), mediaItem('m601b', '601')]
    const items602 = [mediaItem('m602', '602')]
    // No parameter: this stub never reads what's sent, and a zero-arg function
    // assigns cleanly to every overload of the real (multi-overload) sendMessage —
    // unlike a one-parameter stub, which forces a choice among them.
    const sendMessage = vi.fn<() => Promise<{ queued: number; skipped: number }>>(async () => ({
      queued: 2,
      skipped: 1,
    }))
    vi.spyOn(browser.runtime, 'sendMessage').mockImplementation(sendMessage)
    const reportClear = vi.fn<HandlerDeps['reportClear']>()
    const deps = makeHandlerDeps({
      document,
      location: { pathname: '/i/bookmarks' },
      store: {
        valuesForTweet: (tweetId: string) =>
          tweetId === '601' ? items601 : tweetId === '602' ? items602 : [],
      },
      clearLog: () => {},
      notifyContextLost: vi.fn<HandlerDeps['notifyContextLost']>(),
      reportClear,
    })

    const response = await new Promise<unknown>((resolve) => {
      expect(handleSweepPage({}, deps, resolve)).toBe(true)
    })

    expect(sendMessage).toHaveBeenCalledWith({
      _tag: 'SweepEnqueueRequest',
      scope: 'bookmark',
      posts: [
        { tweetId: '601', items: items601 },
        { tweetId: '602', items: items602 },
      ],
    })
    expect(response).toEqual({ _tag: 'SweepPageResponse', ok: true, queued: 2, skipped: 1 })
    expect(reportClear.mock.calls).toEqual([
      ['clear-sweep-request', 'scope=bookmark'],
      ['clear-sweep-candidates', 'scope=bookmark tweets=2 items=3 tweetIds=601,602'],
      ['clear-sweep-response', 'scope=bookmark ok=true queued=2 skipped=1'],
    ])
    for (const [, detail] of reportClear.mock.calls) expect(detail).not.toContain('https://')
  })

  it('Sweep reports failure when the queue channel is gone', async () => {
    document.body.append(tweetArticle({ tweetId: '603', bookmarked: true }))
    const items603 = [mediaItem('m603', '603')]
    // No parameter — see the sibling test above for why.
    const sendMessage = vi.fn<() => Promise<never>>(async () => {
      throw new Error('Extension context invalidated')
    })
    vi.spyOn(browser.runtime, 'sendMessage').mockImplementation(sendMessage)
    const reportClear = vi.fn<HandlerDeps['reportClear']>()
    const notifyContextLost = vi.fn<HandlerDeps['notifyContextLost']>()
    const deps = makeHandlerDeps({
      document,
      location: { pathname: '/i/bookmarks' },
      store: { valuesForTweet: () => items603 },
      clearLog: () => {},
      notifyContextLost,
      reportClear,
    })

    const response = await new Promise<unknown>((resolve) => {
      handleSweepPage({}, deps, resolve)
    })

    expect(notifyContextLost).toHaveBeenCalledTimes(1)
    expect(response).toEqual({
      _tag: 'SweepPageResponse',
      ok: false,
      queued: 0,
      skipped: 0,
      reason: 'context',
    })
    expect(reportClear.mock.calls).toEqual([
      ['clear-sweep-request', 'scope=bookmark'],
      ['clear-sweep-candidates', 'scope=bookmark tweets=1 items=1 tweetIds=603'],
      ['clear-sweep-failed', 'scope=bookmark reason=context candidates=1 items=1'],
    ])
  })

  // The background router answers a THROWN `handleSweepEnqueue` with its generic
  // `{ ok: false, error }` envelope. Read with `?? 0` that is indistinguishable
  // from a legitimately empty sweep — the durable log would claim `ok=true
  // queued=0` and the popup would blame the list ("No new media detected") for an
  // extension crash. The reply must be judged on `queued` being PRESENT.
  it('Sweep reports failure when the background answers its handler-failed envelope', async () => {
    document.body.append(tweetArticle({ tweetId: '604', bookmarked: true }))
    const items604 = [mediaItem('m604', '604')]
    vi.spyOn(browser.runtime, 'sendMessage').mockImplementation(async () => ({
      ok: false,
      error: 'handler failed',
    }))
    const reportClear = vi.fn<HandlerDeps['reportClear']>()
    const deps = makeHandlerDeps({
      document,
      location: { pathname: '/i/bookmarks' },
      store: { valuesForTweet: () => items604 },
      clearLog: () => {},
      notifyContextLost: vi.fn<HandlerDeps['notifyContextLost']>(),
      reportClear,
    })

    const response = await new Promise<unknown>((resolve) => {
      handleSweepPage({}, deps, resolve)
    })

    expect(response).toEqual({
      _tag: 'SweepPageResponse',
      ok: false,
      queued: 0,
      skipped: 0,
      reason: 'malformed-reply',
    })
    expect(reportClear.mock.calls).toEqual([
      ['clear-sweep-request', 'scope=bookmark'],
      ['clear-sweep-candidates', 'scope=bookmark tweets=1 items=1 tweetIds=604'],
      ['clear-sweep-failed', 'scope=bookmark reason=malformed-reply candidates=1 items=1'],
    ])
  })

  // The guard is on PRESENCE, not truthiness: a background that genuinely queued
  // nothing still answers a well-formed reply, and must keep the empty-sweep copy.
  it('Sweep treats a genuine zero-queued reply as a real, successful answer', async () => {
    document.body.append(tweetArticle({ tweetId: '605', bookmarked: true }))
    vi.spyOn(browser.runtime, 'sendMessage').mockImplementation(async () => ({
      queued: 0,
      skipped: 0,
    }))
    const reportClear = vi.fn<HandlerDeps['reportClear']>()
    const deps = makeHandlerDeps({
      document,
      location: { pathname: '/i/bookmarks' },
      store: { valuesForTweet: () => [mediaItem('m605', '605')] },
      clearLog: () => {},
      notifyContextLost: vi.fn<HandlerDeps['notifyContextLost']>(),
      reportClear,
    })

    const response = await new Promise<unknown>((resolve) => {
      handleSweepPage({}, deps, resolve)
    })

    expect(response).toEqual({ _tag: 'SweepPageResponse', ok: true, queued: 0, skipped: 0 })
    expect(reportClear.mock.calls.at(-1)).toEqual([
      'clear-sweep-response',
      'scope=bookmark ok=true queued=0 skipped=0',
    ])
  })
})

describe('sweepSavedStatus — Saved ✓ chip', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('injects exactly one chip on a saved post and none on an unsaved one', async () => {
    document.body.append(tweetArticle({ tweetId: '1' }), tweetArticle({ tweetId: '2' }))
    const requestSavedStatus = vi.fn<(tweetIds: string[]) => Promise<string[]>>(async () => ['1'])

    await sweepSavedStatus({ document, inScope: () => true, requestSavedStatus })

    expect(
      Option.getOrNull(findArticle(document, '1'))?.querySelectorAll('.xdl-saved-chip').length,
    ).toBe(1)
    expect(
      Option.getOrNull(findArticle(document, '2'))?.querySelectorAll('.xdl-saved-chip').length,
    ).toBe(0)
    expect(requestSavedStatus).toHaveBeenCalledWith(['1', '2'])
  })

  it('is idempotent — a second sweep does not double-inject', async () => {
    document.body.append(tweetArticle({ tweetId: '1' }))
    const requestSavedStatus = vi.fn<(tweetIds: string[]) => Promise<string[]>>(async () => ['1'])

    await sweepSavedStatus({ document, inScope: () => true, requestSavedStatus })
    await sweepSavedStatus({ document, inScope: () => true, requestSavedStatus })

    expect(document.querySelectorAll('.xdl-saved-chip').length).toBe(1)
  })

  it('skips entirely when out of scope — no request, no chip', async () => {
    document.body.append(tweetArticle({ tweetId: '1' }))
    const requestSavedStatus = vi.fn<(tweetIds: string[]) => Promise<string[]>>(async () => ['1'])

    await sweepSavedStatus({ document, inScope: () => false, requestSavedStatus })

    expect(requestSavedStatus).not.toHaveBeenCalled()
    expect(document.querySelectorAll('.xdl-saved-chip').length).toBe(0)
  })

  it('fail-safe: an empty reply marks nothing', async () => {
    document.body.append(tweetArticle({ tweetId: '1' }))
    const requestSavedStatus = vi.fn<(tweetIds: string[]) => Promise<string[]>>(
      async (): Promise<string[]> => [],
    )

    await sweepSavedStatus({ document, inScope: () => true, requestSavedStatus })

    expect(document.querySelectorAll('.xdl-saved-chip').length).toBe(0)
  })

  it('paints nothing when scope is lost while the request is in flight', async () => {
    document.body.append(tweetArticle({ tweetId: '1' }))
    let inScope = true
    let resolveRequest: ((ids: string[]) => void) | undefined
    const requestSavedStatus = vi.fn<(tweetIds: string[]) => Promise<string[]>>(
      () =>
        new Promise<string[]>((resolve) => {
          resolveRequest = resolve
        }),
    )

    const sweep = sweepSavedStatus({ document, inScope: () => inScope, requestSavedStatus })
    inScope = false // route changed / setting toggled mid-flight
    resolveRequest?.(['1'])
    await sweep

    expect(requestSavedStatus).toHaveBeenCalledWith(['1'])
    expect(document.querySelectorAll('.xdl-saved-chip').length).toBe(0)
  })
})

describe('handleSavedStatusUpdate — late cross-device chips', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('chips the mounted articles named by the push, idempotently', () => {
    document.body.append(tweetArticle({ tweetId: '1' }), tweetArticle({ tweetId: '2' }))
    const msg = { _tag: 'SavedStatusUpdate', saved: ['1'] }

    handleSavedStatusUpdate(msg, depsWith(true), () => {})
    expect(
      Option.getOrNull(findArticle(document, '1'))?.querySelectorAll('.xdl-saved-chip').length,
    ).toBe(1)
    expect(
      Option.getOrNull(findArticle(document, '2'))?.querySelectorAll('.xdl-saved-chip').length,
    ).toBe(0)

    // Re-push (chips are idempotent, like the sweep's).
    handleSavedStatusUpdate(msg, depsWith(true), () => {})
    expect(document.querySelectorAll('.xdl-saved-chip').length).toBe(1)
  })

  it('no-ops when the Saved status is off / out of scope on this page', () => {
    document.body.append(tweetArticle({ tweetId: '1' }))

    handleSavedStatusUpdate({ _tag: 'SavedStatusUpdate', saved: ['1'] }, depsWith(false), () => {})

    expect(document.querySelectorAll('.xdl-saved-chip').length).toBe(0)
  })

  it('fail-safe: malformed or empty payloads mark nothing', () => {
    document.body.append(tweetArticle({ tweetId: '1' }))

    handleSavedStatusUpdate({ _tag: 'SavedStatusUpdate' }, depsWith(true), () => {})
    handleSavedStatusUpdate({ _tag: 'SavedStatusUpdate', saved: [] }, depsWith(true), () => {})
    handleSavedStatusUpdate({ _tag: 'SavedStatusUpdate', saved: 'nope' }, depsWith(true), () => {})
    handleSavedStatusUpdate({ _tag: 'SavedStatusUpdate', saved: [42] }, depsWith(true), () => {})

    expect(document.querySelectorAll('.xdl-saved-chip').length).toBe(0)
  })

  it('REGRESSION: non-x adapter no-ops even when active — the sweep DOM is X-specific', () => {
    document.body.append(tweetArticle({ tweetId: '1' }))

    handleSavedStatusUpdate(
      { _tag: 'SavedStatusUpdate', saved: ['1'] },
      depsWith(true, 'instagram'),
      () => {},
    )

    expect(document.querySelectorAll('.xdl-saved-chip').length).toBe(0)
  })
})

describe('isSavedStatusScope', () => {
  it('is true on the home timeline and List timelines', () => {
    expect(isSavedStatusScope('/home')).toBe(true)
    expect(isSavedStatusScope('/i/lists/1234567890')).toBe(true)
  })
  it('is false on profiles, likes, and bookmarks', () => {
    expect(isSavedStatusScope('/jack')).toBe(false)
    expect(isSavedStatusScope('/jack/likes')).toBe(false)
    expect(isSavedStatusScope('/i/bookmarks')).toBe(false)
  })
})

describe('savedStatusVisible — setting gate × scope', () => {
  it('requires the setting ON and an in-scope timeline', () => {
    expect(savedStatusVisible('/home', true)).toBe(true)
    expect(savedStatusVisible('/i/lists/42', true)).toBe(true)
  })
  it('is false when the toggle is off, even on an in-scope page', () => {
    expect(savedStatusVisible('/home', false)).toBe(false)
    expect(savedStatusVisible('/i/lists/42', false)).toBe(false)
  })
  it('is false on an out-of-scope page even when the toggle is on', () => {
    expect(savedStatusVisible('/jack', true)).toBe(false)
  })
})

// dispatchOverlayMessage is the overlay's single `runtime.onMessage` entry point:
// decode-gate against the inventoried inbound set, THEN table dispatch. These tests
// pin the gate mechanics with the REAL sender literals (copied verbatim from the
// sender code), not synthetic shapes — a schema drift that stops matching the real
// senders must fail here, not silently drop production traffic.
describe('dispatchOverlayMessage — decode gate + table dispatch', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('RefreshMediaUrlRequest — the real background sender literal (media-url-refresh.ts) dispatches', () => {
    const raw = {
      _tag: 'RefreshMediaUrlRequest',
      itemId: 'media-1',
      tweetId: '123',
      index: 0,
      type: 'photo',
    }
    const deps = makeHandlerDeps({
      store: { get: () => undefined, addDetected: () => [], values: () => [] },
      adapter: { platform: 'x', detectRenderedMedia: () => [] },
      document,
      location: { pathname: '/home' },
    })
    const sendResponse = vi.fn<SendResponse>()
    const kept = dispatchOverlayMessage(raw, deps, sendResponse)
    expect(kept).toBe(true)
    expect(sendResponse).toHaveBeenCalledWith({ _tag: 'RefreshMediaUrlResponse' })
  })

  it('ClearTweetRequest — the real tab-broadcaster.sendClearToTabs literal dispatches', () => {
    const raw = {
      _tag: 'ClearTweetRequest',
      tweetId: 't99',
      scopes: ['bookmark', 'like'],
      allLists: true,
    }
    const deps = makeHandlerDeps({
      adapter: { platform: 'instagram' },
      document,
      location: { pathname: '/jack' },
      clearLog: () => {},
    })
    const sendResponse = vi.fn<SendResponse>()
    dispatchOverlayMessage(raw, deps, sendResponse)
    expect(sendResponse).toHaveBeenCalledWith({
      _tag: 'ClearTweetResponse',
      mounted: false,
      drainEligible: false,
      results: [],
    })
  })

  it('ClearVisibleRequest — the real popup usePageAction literal ({ _tag }) dispatches', () => {
    const raw = { _tag: 'ClearVisibleRequest' }
    const deps = makeHandlerDeps({
      adapter: { platform: 'threads' },
      location: { pathname: '/i/bookmarks' },
      clearLog: () => {},
    })
    const sendResponse = vi.fn<SendResponse>()
    dispatchOverlayMessage(raw, deps, sendResponse)
    expect(sendResponse).toHaveBeenCalledWith({
      _tag: 'ClearVisibleResponse',
      cleared: 0,
      reason: 'not-x',
    })
  })

  it('ClearWholeListRequest — the real popup usePageAction literal ({ _tag }) dispatches', () => {
    const raw = { _tag: 'ClearWholeListRequest' }
    const deps = makeHandlerDeps({
      adapter: { platform: 'threads' },
      location: { pathname: '/i/bookmarks' },
      document,
      clearLog: () => {},
    })
    const sendResponse = vi.fn<SendResponse>()
    const kept = dispatchOverlayMessage(raw, deps, sendResponse)
    expect(kept).toBe(true)
    expect(sendResponse).toHaveBeenCalledWith({
      _tag: 'ClearWholeListResponse',
      cleared: 0,
      reason: 'not-x',
    })
  })

  it('DrainPageRequest — the real popup usePageAction literal ({ _tag }) dispatches', async () => {
    const raw = { _tag: 'DrainPageRequest' }
    const deps = makeHandlerDeps({
      store: { values: () => [] },
      location: { pathname: '/home' },
      clearLog: () => {},
      sendTracked: vi.fn<HandlerDeps['sendTracked']>(async () => ({
        ok: true,
        admitted: 0,
        skipped: 0,
      })),
      reportClear: vi.fn<HandlerDeps['reportClear']>(),
    })
    const sendResponse = vi.fn<SendResponse>()
    const kept = dispatchOverlayMessage(raw, deps, sendResponse)
    expect(kept).toBe(true)
    // The reply is TERMINAL now — it lands only after the send settles.
    await Promise.resolve()
    await Promise.resolve()
    expect(sendResponse).toHaveBeenCalledWith({
      _tag: 'DrainPageResponse',
      count: 0,
      admitted: 0,
      skipped: 0,
      ok: true,
      onList: false,
    })
  })

  it('SweepPageRequest — the real popup usePageAction literal ({ _tag }) dispatches', () => {
    const raw = { _tag: 'SweepPageRequest' }
    const deps = makeHandlerDeps({
      location: { pathname: '/jack' }, // not a Likes/Bookmarks list page
      clearLog: () => {},
      reportClear: vi.fn<HandlerDeps['reportClear']>(),
    })
    const sendResponse = vi.fn<SendResponse>()
    const kept = dispatchOverlayMessage(raw, deps, sendResponse)
    expect(kept).toBe(true)
    expect(sendResponse).toHaveBeenCalledWith({
      _tag: 'SweepPageResponse',
      ok: false,
      queued: 0,
      skipped: 0,
      reason: 'not-list-page',
    })
  })

  it('a Message-union broadcast tag the table also handles (TransferOutcome) still dispatches', () => {
    const raw = { _tag: 'TransferOutcome', requestId: 'req-1', outcome: 'complete', at: 1234 }
    const deps = makeHandlerDeps({
      getBadge: () => ({ key: null }),
      getBadgeMedia: () => null,
      getBadgeRequestId: () => null,
      getBadgeRequestKey: () => null,
      getLauncherBatchIds: () => new Set<string>(),
    })
    const sendResponse = vi.fn<SendResponse>()
    // handleTransferOutcome is fire-and-forget: `false`, distinct from the
    // `undefined` a DROPPED (decode-failed / unmapped) message returns below.
    expect(dispatchOverlayMessage(raw, deps, sendResponse)).toBe(false)
  })

  it('drops a malformed known-tag payload without dispatching, and warns UNCONDITIONALLY (parity with background.ts)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const deps = makeHandlerDeps({ adapter: { platform: 'x' } })
    const sendResponse = vi.fn<SendResponse>()
    const kept = dispatchOverlayMessage(
      { _tag: 'ClearTweetRequest', tweetId: 5 },
      deps,
      sendResponse,
    )
    expect(kept).toBeUndefined()
    expect(sendResponse).not.toHaveBeenCalled()
    // NOT DEV-gated: the silent-drop signature must be visible in any build.
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('ClearTweetRequest FAILED overlay schema decode')
    warn.mockRestore()
  })

  it('drops an unknown/garbage tag without dispatching (warns only when a string tag exists to name)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const deps = makeHandlerDeps({ adapter: { platform: 'x' } })
    const sendResponse = vi.fn<SendResponse>()
    const kept = dispatchOverlayMessage({ _tag: 'NotARealTag', foo: 1 }, deps, sendResponse)
    expect(kept).toBeUndefined()
    expect(sendResponse).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    // Tagless garbage: dropped silently — no string tag to name (same gate as
    // background.ts's `typeof rawTag === 'string'`).
    expect(dispatchOverlayMessage('garbage', deps, sendResponse)).toBeUndefined()
    expect(dispatchOverlayMessage(null, deps, sendResponse)).toBeUndefined()
    expect(sendResponse).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})

// The manual sweep's ghost memo (#92-adjacent, live 2026-08-23): a row whose post
// was already cleared from another tab keeps rendering `removeBookmark` on the
// stale list; every pass re-clicked it, X no-op'd, and the log filled with
// honest-but-useless `no-flip` failures. After GHOST_NOFLIP_LIMIT consecutive
// failures the sweep skips the id (and says so) until a flip succeeds.
describe('clearMountedForScope — ghost-row skip', () => {
  const mountedPost = (id: string): HTMLElement => {
    const art = document.createElement('article')
    art.setAttribute('data-testid', 'tweet')
    art.innerHTML = `<a href="/u/status/${id}"><time></time></a><button data-testid="removeBookmark"></button>`
    document.body.appendChild(art)
    return art
  }
  const trackClicks = (art: HTMLElement): (() => number) => {
    let n = 0
    art.querySelector('button')!.addEventListener('click', () => {
      n++
    })
    return () => n
  }

  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it(`skips an id after GHOST_NOFLIP_LIMIT consecutive no-flips and says so`, async () => {
    const art = mountedPost('2085341199993565645')
    const ghosts = new Map<string, number>()
    const lines: Array<{ stage: string; tweetId?: string }> = []
    const trace = (stage: string, _detail: string, tweetId?: string) =>
      lines.push({ stage, ...(tweetId === undefined ? {} : { tweetId }) })

    for (let pass = 0; pass < GHOST_NOFLIP_LIMIT; pass++) {
      await clearMountedForScope({ document, scope: 'bookmark', paceMs: 0, trace, ghosts })
    }
    expect(ghosts.get('2085341199993565645')).toBe(GHOST_NOFLIP_LIMIT)

    const clicksGhost = trackClicks(art)
    await clearMountedForScope({ document, scope: 'bookmark', paceMs: 0, trace, ghosts })
    expect(clicksGhost()).toBe(0) // no third click on the ghost
    expect(lines.at(-1)?.stage).toBe('clear-ghost-skip')
    expect(lines.at(-1)?.tweetId).toBe('2085341199993565645')
  })

  it('still clears other posts in the same pass as a skipped ghost', async () => {
    const ghost = mountedPost('111')
    const fresh = mountedPost('222')
    const ghosts = new Map<string, number>()
    ghosts.set('111', GHOST_NOFLIP_LIMIT)
    const clicksGhost = trackClicks(ghost)
    const clicksFresh = trackClicks(fresh)
    const cleared = await clearMountedForScope({
      document,
      scope: 'bookmark',
      paceMs: 0,
      trace: () => {},
      ghosts,
    })
    expect(clicksGhost()).toBe(0)
    expect(clicksFresh()).toBe(1)
    expect(cleared).toBe(1)
  })

  it('is inert without a ghosts map — prior callers unchanged', async () => {
    const art = mountedPost('333')
    const clicksArt = trackClicks(art)
    await clearMountedForScope({ document, scope: 'bookmark', paceMs: 0, trace: () => {} })
    expect(clicksArt()).toBe(1)
  })
})
