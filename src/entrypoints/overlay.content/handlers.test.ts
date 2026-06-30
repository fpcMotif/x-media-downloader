import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Option } from 'effect'
import {
  handleClearTweet,
  sweepSavedStatus,
  isSavedStatusScope,
  savedStatusVisible,
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
 *  badge/launcher/store state the full HandlerDeps carries). */
const makeDeps = (over: {
  clearScope: HandlerDeps['clearScope']
  pathname: string
  queueDrain?: HandlerDeps['queueDrain']
}): HandlerDeps =>
  ({
    document,
    location: { pathname: over.pathname } as Location,
    clearScope: over.clearScope,
    clearLog: () => {},
    queueDrain: over.queueDrain ?? (() => {}),
  }) as unknown as HandlerDeps

/** Drive the handler to completion (it returns true sync, then resolves async). */
const run = (
  deps: HandlerDeps,
  message: { tweetId: string; scopes: string[]; allLists?: boolean },
): Promise<{ results: { scope: string; ok: boolean; noop?: boolean }[] }> =>
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

  it('not mounted → queues the clear for the scroll-drain, never clicks, empty results', async () => {
    const clearScope = vi.fn<HandlerDeps['clearScope']>(async () => true)
    const queueDrain = vi.fn<HandlerDeps['queueDrain']>()
    const res = await run(makeDeps({ clearScope, queueDrain, pathname: '/jack/likes' }), {
      tweetId: '999',
      scopes: ALL,
      allLists: true,
    })
    expect(clearScope).not.toHaveBeenCalled()
    expect(res.results).toEqual([])
    // The post virtualized out → hand it to the drain instead of dropping it.
    expect(queueDrain).toHaveBeenCalledWith('999', ALL, true)
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
