import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Option } from 'effect'
import {
  handleClearTweet,
  handleClearDrain,
  handleClearVisible,
  handleClearWholeList,
  handleSavedStatusUpdate,
  sweepSavedStatus,
  isSavedStatusScope,
  savedStatusVisible,
  dispatchOverlayMessage,
} from './handlers'
import type { HandlerDeps } from './handlers'
import { findArticle } from '../../core/clear/clearer'

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

/** Only the fields handleClearTweet reads — cast a partial (it never touches the
 *  badge/launcher/store state the full HandlerDeps carries). `platform` defaults to
 *  'x' so every pre-existing call site (all X-DOM scenarios) is unaffected by the
 *  gate; tests proving the off-X no-op override it. */
const makeDeps = (over: {
  clearScope: HandlerDeps['clearScope']
  pathname: string
  runDrain?: HandlerDeps['runDrain']
  platform?: 'x' | 'instagram' | 'threads'
}): HandlerDeps =>
  ({
    adapter: { platform: over.platform ?? 'x' },
    document,
    location: { pathname: over.pathname } as Location,
    clearScope: over.clearScope,
    clearLog: () => {},
    runDrain: over.runDrain ?? (async () => []),
  }) as unknown as HandlerDeps

/** Drive the handler to completion (it returns true sync, then resolves async). */
const run = (
  deps: HandlerDeps,
  message: { tweetId: string; scopes: string[]; allLists?: boolean },
): Promise<{
  mounted: boolean
  drainEligible: boolean
  results: { scope: string; ok: boolean; noop?: boolean }[]
}> =>
  new Promise((resolve) => {
    handleClearTweet(message, deps, (r) => resolve(r as never))
  })

const ALL: string[] = ['bookmark', 'like', 'notInterested']

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

describe('handleClearVisible — platform gate', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('REGRESSION: non-x adapter short-circuits to cleared:0, never scans the DOM', () => {
    document.body.append(tweetArticle({ tweetId: '201', bookmarked: true }))
    const deps = {
      adapter: { platform: 'instagram' },
      location: { pathname: '/jack/bookmarks' } as Location,
      clearLog: () => {},
    } as unknown as HandlerDeps
    const querySpy = vi.spyOn(document, 'querySelectorAll')
    const sendResponse = vi.fn<(r: unknown) => void>()
    const kept = handleClearVisible({}, deps, sendResponse)
    expect(sendResponse).toHaveBeenCalledWith({ _tag: 'ClearVisibleResponse', cleared: 0 })
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
    const deps = {
      adapter: { platform: 'threads' },
      location: { pathname: '/jack/bookmarks' } as Location,
      document,
      clearLog: () => {},
    } as unknown as HandlerDeps
    const querySpy = vi.spyOn(document, 'querySelectorAll')
    const sendResponse = vi.fn<(r: unknown) => void>()
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

// Ticket #61: manual Releases are only ever visible via the production trace sink
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
    const deps = {
      adapter: { platform: 'x' },
      document,
      location: { pathname: '/jack/bookmarks' } as Location,
      clearLog: () => {},
      reportClear,
    } as unknown as HandlerDeps
    const sendResponse = vi.fn<(r: unknown) => void>()
    const kept = handleClearVisible({}, deps, sendResponse)
    expect(kept).toBe(true)
    await vi.runAllTimersAsync()

    expect(reportClear).toHaveBeenCalledWith('clear-visible-start', 'bookmark')
    expect(reportClear).toHaveBeenCalledWith('clear-visible-end', 'cleared 1 bookmark')
    expect(sendResponse).toHaveBeenCalledWith({ _tag: 'ClearVisibleResponse', cleared: 1 })
  })

  it('ClearWholeListRequest on a bookmarks-page fake emits clear-list stage events through reportClear', async () => {
    const reportClear = vi.fn<HandlerDeps['reportClear']>()
    const deps = {
      adapter: { platform: 'x' },
      document,
      location: { pathname: '/jack/bookmarks' } as Location,
      reportClear,
    } as unknown as HandlerDeps
    const sendResponse = vi.fn<(r: unknown) => void>()
    const kept = handleClearWholeList({}, deps, sendResponse)
    expect(kept).toBe(true)
    await vi.runAllTimersAsync()

    const stages = reportClear.mock.calls.map((c) => c[0])
    expect(stages).toContain('clear-list-start')
    expect(stages).toContain('clear-list-end')
    expect(sendResponse).toHaveBeenCalledWith({ _tag: 'ClearWholeListResponse', cleared: 0 })
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
      async () => [] as string[],
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

  const depsWith = (active: boolean, platform: 'x' | 'instagram' | 'threads' = 'x'): HandlerDeps =>
    ({
      adapter: { platform },
      document,
      savedStatusActive: () => active,
    }) as unknown as HandlerDeps

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
    const deps = {
      store: { get: () => undefined, addDetected: () => [], values: () => [] },
      adapter: { platform: 'x', detectRenderedMedia: () => [] },
      document,
      location: { pathname: '/home' } as Location,
    } as unknown as HandlerDeps
    const sendResponse = vi.fn<(r: unknown) => void>()
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
    const deps = {
      adapter: { platform: 'instagram' },
      document,
      location: { pathname: '/jack' } as Location,
      clearLog: () => {},
    } as unknown as HandlerDeps
    const sendResponse = vi.fn<(r: unknown) => void>()
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
    const deps = {
      adapter: { platform: 'threads' },
      location: { pathname: '/jack/bookmarks' } as Location,
      clearLog: () => {},
    } as unknown as HandlerDeps
    const sendResponse = vi.fn<(r: unknown) => void>()
    dispatchOverlayMessage(raw, deps, sendResponse)
    expect(sendResponse).toHaveBeenCalledWith({ _tag: 'ClearVisibleResponse', cleared: 0 })
  })

  it('ClearWholeListRequest — the real popup usePageAction literal ({ _tag }) dispatches', () => {
    const raw = { _tag: 'ClearWholeListRequest' }
    const deps = {
      adapter: { platform: 'threads' },
      location: { pathname: '/jack/bookmarks' } as Location,
      document,
      clearLog: () => {},
    } as unknown as HandlerDeps
    const sendResponse = vi.fn<(r: unknown) => void>()
    const kept = dispatchOverlayMessage(raw, deps, sendResponse)
    expect(kept).toBe(true)
    expect(sendResponse).toHaveBeenCalledWith({
      _tag: 'ClearWholeListResponse',
      cleared: 0,
      reason: 'not-x',
    })
  })

  it('DrainPageRequest — the real popup usePageAction literal ({ _tag }) dispatches', () => {
    const raw = { _tag: 'DrainPageRequest' }
    const deps = {
      store: { values: () => [] },
      location: { pathname: '/home' } as Location,
      clearLog: () => {},
      sendTracked: vi.fn<HandlerDeps['sendTracked']>(async () => true),
    } as unknown as HandlerDeps
    const sendResponse = vi.fn<(r: unknown) => void>()
    const kept = dispatchOverlayMessage(raw, deps, sendResponse)
    expect(kept).toBe(true)
    expect(sendResponse).toHaveBeenCalledWith({ _tag: 'DrainPageResponse', count: 0 })
  })

  it('SweepPageRequest — the real popup usePageAction literal ({ _tag }) dispatches', () => {
    const raw = { _tag: 'SweepPageRequest' }
    const deps = {
      location: { pathname: '/jack' } as Location, // not a Likes/Bookmarks list page
      clearLog: () => {},
    } as unknown as HandlerDeps
    const sendResponse = vi.fn<(r: unknown) => void>()
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
    const deps = {
      getBadge: () => ({ key: null }),
      getBadgeMedia: () => null,
      getBadgeRequestId: () => null,
      getBadgeRequestKey: () => null,
      getLauncherBatchIds: () => new Set<string>(),
    } as unknown as HandlerDeps
    const sendResponse = vi.fn<(r: unknown) => void>()
    // handleTransferOutcome is fire-and-forget: `false`, distinct from the
    // `undefined` a DROPPED (decode-failed / unmapped) message returns below.
    expect(dispatchOverlayMessage(raw, deps, sendResponse)).toBe(false)
  })

  it('drops a malformed known-tag payload without dispatching, and warns UNCONDITIONALLY (parity with background.ts)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const deps = { adapter: { platform: 'x' } } as unknown as HandlerDeps
    const sendResponse = vi.fn<(r: unknown) => void>()
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
    const deps = { adapter: { platform: 'x' } } as unknown as HandlerDeps
    const sendResponse = vi.fn<(r: unknown) => void>()
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
