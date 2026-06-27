import { describe, it, expect, beforeEach, vi } from 'vitest'
import { handleClearTweet } from './handlers'
import type { HandlerDeps } from './handlers'

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
