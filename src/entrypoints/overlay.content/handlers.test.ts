import { readFileSync } from 'node:fs'
import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest'
import { Option } from 'effect'
import {
  decodeSavedStatusResponse,
  handleClearTweet,
  handleDrainPage,
  decodeQueueUpdate,
  handleSweepPage,
  handleSavedStatusUpdate,
  sweepSavedStatus,
  isSavedStatusScope,
  savedStatusVisible,
  dispatchOverlayMessage,
  isPopupActionSender,
} from './handlers'
import type { HandlerDeps } from './handlers'
import { findArticle } from '../../core/clear/clearer'
import type { MediaItem } from '../../core/schema'

// ClearTweet is the one-scope destructive phase. Locate chooses the scope first.

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

const sweepItem = (id: string, postId: string): MediaItem => ({
  id,
  postId,
  platform: 'x',
  author: 'alice',
  type: 'photo',
  url: `https://pbs.twimg.com/media/${id}`,
  ext: 'jpg',
  index: 0,
})

/** Only the fields handleClearTweet reads. */
const makeDeps = (over: {
  clearScopeAttempt: HandlerDeps['clearScopeAttempt']
  pathname: string
  platform?: 'x' | 'instagram' | 'threads'
}): HandlerDeps =>
  ({
    adapter: { platform: over.platform ?? 'x' },
    document,
    location: { pathname: over.pathname } as Location,
    clearScopeAttempt: over.clearScopeAttempt,
    clearLog: () => {},
  }) as unknown as HandlerDeps

/** Drive the handler to completion (it returns true sync, then resolves async). */
const run = (
  deps: HandlerDeps,
  message: { tweetId: string; scopes: string[]; allLists?: boolean },
): Promise<{ results: { scope: string; state: string }[] }> =>
  new Promise((resolve) => {
    handleClearTweet(message, deps, (r) => resolve(r as never))
  })

describe('handleClearTweet — one destructive scope', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('attempts the selected actionable scope', async () => {
    document.body.append(tweetArticle({ tweetId: '101', bookmarked: true, liked: true }))
    const clearScopeAttempt = vi.fn<HandlerDeps['clearScopeAttempt']>(async () => 'cleared')
    const res = await run(makeDeps({ clearScopeAttempt, pathname: '/jack/likes' }), {
      tweetId: '101',
      scopes: ['like'],
      allLists: true,
    })
    expect(clearScopeAttempt).toHaveBeenCalledWith('101', 'like')
    expect(res.results).toEqual([{ scope: 'like', state: 'cleared' }])
  })

  it('treats an unknown attempt rejection as uncertain', async () => {
    document.body.append(tweetArticle({ tweetId: '101', bookmarked: true, liked: true }))
    const clearScopeAttempt = vi
      .fn<HandlerDeps['clearScopeAttempt']>()
      .mockRejectedValue(new Error('content attempt crashed'))

    const res = await run(makeDeps({ clearScopeAttempt, pathname: '/jack/likes' }), {
      tweetId: '101',
      scopes: ['like'],
      allLists: true,
    })

    expect(res.results).toEqual([{ scope: 'like', state: 'uncertain' }])
  })

  it('not mounted → returns retryable preflight failures, never clicks', async () => {
    const clearScopeAttempt = vi.fn<HandlerDeps['clearScopeAttempt']>()
    const res = await run(makeDeps({ clearScopeAttempt, pathname: '/jack/likes' }), {
      tweetId: '999',
      scopes: ['bookmark'],
      allLists: true,
    })
    expect(clearScopeAttempt).not.toHaveBeenCalled()
    expect(res.results).toEqual([{ scope: 'bookmark', state: 'preflight-failed' }])
  })

  it('non-x adapter returns retryable per-scope results, never touches the DOM', async () => {
    document.body.append(tweetArticle({ tweetId: '104', bookmarked: true, liked: true }))
    const clearScopeAttempt = vi.fn<HandlerDeps['clearScopeAttempt']>()
    const res = await run(
      makeDeps({
        clearScopeAttempt,
        pathname: '/jack/likes',
        platform: 'instagram',
      }),
      { tweetId: '104', scopes: ['bookmark'], allLists: true },
    )
    expect(res).toEqual({
      _tag: 'ClearTweetResponse',
      results: [{ scope: 'bookmark', state: 'not-actionable' }],
    })
    expect(clearScopeAttempt).not.toHaveBeenCalled()
  })
})

const runSweep = (deps: HandlerDeps): Promise<unknown> =>
  new Promise((resolve) => {
    expect(handleSweepPage({}, deps, resolve)).toBe(true)
  })

const runDrain = (deps: HandlerDeps): Promise<unknown> =>
  new Promise((resolve) => {
    expect(handleDrainPage({}, deps, resolve)).toBe(true)
  })

const makeDrainDeps = (sendTracked: HandlerDeps['sendTracked']): HandlerDeps =>
  ({
    store: { values: () => [{ id: 'item-1' }] },
    location: { pathname: '/home' } as Location,
    clearLog: () => {},
    sendTracked,
  }) as unknown as HandlerDeps

const makeSweepDeps = (
  notifyContextLost: HandlerDeps['notifyContextLost'] = () => {},
  itemsForTweet: (tweetId: string) => MediaItem[] = () => [sweepItem('item-1', '1')],
): HandlerDeps =>
  ({
    adapter: { platform: 'x' },
    document,
    location: { pathname: '/jack/bookmarks' } as Location,
    clearLog: () => {},
    notifyContextLost,
    store: { valuesForTweet: itemsForTweet },
  }) as unknown as HandlerDeps

const makeSavedStatusDeps = (
  active: boolean,
  platform: 'x' | 'instagram' | 'threads' = 'x',
): HandlerDeps =>
  ({
    adapter: { platform },
    document,
    savedStatusActive: () => active,
  }) as unknown as HandlerDeps

describe('decodeQueueUpdate — exact start acknowledgement', () => {
  const requested = [sweepItem('item-1', '1'), sweepItem('item-2', '2')]
  const baseReply = {
    _tag: 'QueueUpdate' as const,
    planned: ['item-1', 'item-2'],
    started: ['item-1'],
    deferred: ['item-2'],
    duplicates: [],
    failures: [],
    skipped: [],
  }

  it('accepts a complete identity-bound reply', () => {
    expect(decodeQueueUpdate(baseReply, requested)).toEqual(baseReply)
  })

  it('accepts duplicates as success-equivalent main decisions', () => {
    expect(
      decodeQueueUpdate(
        {
          ...baseReply,
          planned: [],
          started: [],
          deferred: [],
          duplicates: ['item-1', 'item-2'],
        },
        requested,
      ),
    ).toMatchObject({ duplicates: ['item-1', 'item-2'] })
  })

  it.each([
    ['wrong tag', { ...baseReply, _tag: 'Other' }],
    ['legacy count field', { ...baseReply, total: 2 }],
    ['extra key', { ...baseReply, extra: true }],
    ['foreign artifact', { ...baseReply, planned: ['item-1', 'foreign'] }],
    [
      'orphan sidecar',
      {
        ...baseReply,
        planned: ['xmd:v1:sidecar:x:6:item-2'],
        started: ['xmd:v1:sidecar:x:6:item-2'],
      },
    ],
    ['duplicate outcome', { ...baseReply, started: ['item-1', 'item-2'], deferred: ['item-2'] }],
    [
      'outcome missing',
      {
        ...baseReply,
        deferred: [],
      },
    ],
    [
      'main assigned twice',
      {
        ...baseReply,
        duplicates: ['item-2'],
      },
    ],
    [
      'bad skipped reason',
      {
        ...baseReply,
        planned: ['item-1'],
        started: ['item-1'],
        deferred: [],
        skipped: [{ requestId: 'item-2', reason: 'other' }],
      },
    ],
    [
      'duplicate is not a skipped decision',
      {
        ...baseReply,
        planned: ['item-1'],
        started: ['item-1'],
        deferred: [],
        skipped: [{ requestId: 'item-2', reason: 'duplicate' }],
      },
    ],
    [
      'bad failure item',
      {
        ...baseReply,
        failures: [{ requestId: 'item-2', reason: 4 }],
      },
    ],
  ])('rejects %s', (_name, reply) => {
    expect(decodeQueueUpdate(reply, requested)).toBeUndefined()
  })
})

describe('decodeSavedStatusResponse — exact Saved status reply', () => {
  it('re-exports the canonical bounded decoder', () => {
    const source = readFileSync('src/entrypoints/overlay.content/handlers.ts', 'utf8')
    expect(source).toMatch(
      /export \{ decodeSavedStatusResponse \} from ['"]\.\.\/\.\.\/core\/schema\/saved-status['"]/,
    )
  })

  it('accepts the current response shape', () => {
    expect(
      decodeSavedStatusResponse({
        _tag: 'SavedStatusResponse',
        saved: ['1', '2'],
      }),
    ).toEqual({
      _tag: 'SavedStatusResponse',
      saved: ['1', '2'],
    })
  })

  it.each([
    { saved: {} },
    { saved: '12' },
    { _tag: 'SavedStatusResponse', saved: [1] },
    { _tag: 'SavedStatusResponse', saved: [], stale: true },
  ])('rejects malformed reply %#', (reply) => {
    expect(decodeSavedStatusResponse(reply)).toBeUndefined()
  })

  it('rejects an ID outside the requested batch', () => {
    expect(
      decodeSavedStatusResponse({ _tag: 'SavedStatusResponse', saved: ['2'] }, ['1']),
    ).toBeUndefined()
  })
})

describe('handleDrainPage — verified start acknowledgement', () => {
  it('keeps the message channel open until the background acknowledgement arrives', async () => {
    let resolve!: (start: Awaited<ReturnType<HandlerDeps['sendTracked']>>) => void
    const pending = new Promise<Awaited<ReturnType<HandlerDeps['sendTracked']>>>((done) => {
      resolve = done
    })
    const sendTracked = vi.fn<HandlerDeps['sendTracked']>(() => pending)
    const response = vi.fn<(reply: unknown) => void>()

    expect(handleDrainPage({}, makeDrainDeps(sendTracked), response)).toBe(true)
    await Promise.resolve()
    expect(response).not.toHaveBeenCalled()

    resolve({ _tag: 'started' })
    await Promise.resolve()
    expect(response).toHaveBeenCalledWith({
      _tag: 'DrainPageResponse',
      ok: true,
      count: 1,
    })
  })

  it.each([
    ['context', { _tag: 'context' }, 'context'],
    ['unclaimed', { _tag: 'unclaimed' }, 'background'],
    ['transport', { _tag: 'transport' }, 'background'],
    ['invalid reply', { _tag: 'invalid-reply' }, 'background'],
    ['partial', { _tag: 'partial' }, 'background'],
  ] as const)('maps %s to its exact failure reply', async (_name, start, reason) => {
    await expect(runDrain(makeDrainDeps(async () => start))).resolves.toEqual({
      _tag: 'DrainPageResponse',
      ok: false,
      reason,
    })
  })

  it('catches a rejected start and still replies', async () => {
    await expect(
      runDrain(
        makeDrainDeps(async () => {
          throw new Error('worker crashed')
        }),
      ),
    ).resolves.toEqual({
      _tag: 'DrainPageResponse',
      ok: false,
      reason: 'background',
    })
  })
})

describe('handleSweepPage — background reply contract', () => {
  const originalSendMessage = browser.runtime.sendMessage

  beforeEach(() => {
    document.body.innerHTML = ''
    document.body.append(tweetArticle({ tweetId: '1', bookmarked: true }))
  })
  afterEach(() => {
    browser.runtime.sendMessage = originalSendMessage
  })

  it('accepts only an exact reply bounded by the sent post count', async () => {
    browser.runtime.sendMessage = (async () => ({
      _tag: 'SweepEnqueueResponse',
      queued: 1,
      skipped: 0,
    })) as typeof browser.runtime.sendMessage

    await expect(runSweep(makeSweepDeps())).resolves.toEqual({
      _tag: 'SweepPageResponse',
      ok: true,
      queued: 1,
      skipped: 0,
    })
  })

  it('commits Sweep batches in order and sums their replies', async () => {
    document.body.innerHTML = ''
    const tweetIds = Array.from({ length: 17 }, (_, n) => `${n + 1}`)
    document.body.append(...tweetIds.map((tweetId) => tweetArticle({ tweetId, bookmarked: true })))
    const send = vi
      .fn<(message: unknown) => Promise<unknown>>()
      .mockResolvedValueOnce({
        _tag: 'SweepEnqueueResponse',
        queued: 15,
        skipped: 1,
      })
      .mockResolvedValueOnce({
        _tag: 'SweepEnqueueResponse',
        queued: 1,
        skipped: 0,
      })
    browser.runtime.sendMessage = send as typeof browser.runtime.sendMessage

    await expect(
      runSweep(
        makeSweepDeps(
          () => {},
          (tweetId) => [sweepItem(`item-${tweetId}`, tweetId)],
        ),
      ),
    ).resolves.toEqual({
      _tag: 'SweepPageResponse',
      ok: true,
      queued: 16,
      skipped: 1,
    })
    expect(
      send.mock.calls.map(([message]) => (message as unknown as { posts: unknown[] }).posts.length),
    ).toEqual([16, 1])
  })

  it('keeps committed Sweep counts when a later batch fails', async () => {
    document.body.innerHTML = ''
    const tweetIds = Array.from({ length: 17 }, (_, n) => `${n + 1}`)
    document.body.append(...tweetIds.map((tweetId) => tweetArticle({ tweetId, bookmarked: true })))
    browser.runtime.sendMessage = vi
      .fn<(message: unknown) => Promise<unknown>>()
      .mockResolvedValueOnce({
        _tag: 'SweepEnqueueResponse',
        queued: 15,
        skipped: 1,
      })
      .mockResolvedValueOnce(undefined) as typeof browser.runtime.sendMessage

    await expect(
      runSweep(
        makeSweepDeps(
          () => {},
          (tweetId) => [sweepItem(`item-${tweetId}`, tweetId)],
        ),
      ),
    ).resolves.toEqual({
      _tag: 'SweepPageResponse',
      ok: false,
      queued: 15,
      skipped: 1,
      reason: 'background',
    })
  })

  it('finishes an empty Sweep locally', async () => {
    document.body.innerHTML = ''
    const send = vi.fn<(message: unknown) => Promise<unknown>>()
    browser.runtime.sendMessage = send as typeof browser.runtime.sendMessage

    await expect(runSweep(makeSweepDeps())).resolves.toEqual({
      _tag: 'SweepPageResponse',
      ok: true,
      queued: 0,
      skipped: 0,
    })
    expect(send).not.toHaveBeenCalled()
  })

  it('rejects an invalid Sweep producer before it sends', async () => {
    const send = vi.fn<(message: unknown) => Promise<unknown>>()
    browser.runtime.sendMessage = send as typeof browser.runtime.sendMessage

    await expect(
      runSweep(
        makeSweepDeps(
          () => {},
          () => [sweepItem('item-1', 'other')],
        ),
      ),
    ).resolves.toEqual({
      _tag: 'SweepPageResponse',
      ok: false,
      queued: 0,
      skipped: 0,
      reason: 'local-invalid',
    })
    expect(send).not.toHaveBeenCalled()
  })

  it('keeps explicit background unavailability distinct from an empty success', async () => {
    browser.runtime.sendMessage = (async () => ({
      _tag: 'SweepEnqueueUnavailable',
    })) as typeof browser.runtime.sendMessage

    await expect(runSweep(makeSweepDeps())).resolves.toEqual({
      _tag: 'SweepPageResponse',
      ok: false,
      queued: 0,
      skipped: 0,
      reason: 'background',
    })
  })

  it.each([
    ['unclaimed reply', async () => undefined],
    ['router rejection', async () => Promise.reject(new Error('router failed'))],
    ['wrong tag', async () => ({ _tag: 'Other', queued: 1, skipped: 0 })],
    [
      'extra key',
      async () => ({
        _tag: 'SweepEnqueueResponse',
        queued: 1,
        skipped: 0,
        extra: true,
      }),
    ],
    [
      'unsafe count',
      async () => ({
        _tag: 'SweepEnqueueResponse',
        queued: Number.MAX_SAFE_INTEGER + 1,
        skipped: 0,
      }),
    ],
    [
      'overclassified count',
      async () => ({
        _tag: 'SweepEnqueueResponse',
        queued: 1,
        skipped: 1,
      }),
    ],
  ])('never converts %s into zero-success', async (_name, send) => {
    browser.runtime.sendMessage = send as typeof browser.runtime.sendMessage

    await expect(runSweep(makeSweepDeps())).resolves.toEqual({
      _tag: 'SweepPageResponse',
      ok: false,
      queued: 0,
      skipped: 0,
      reason: 'background',
    })
  })

  it('keeps the context-invalidated path distinct', async () => {
    const notifyContextLost = vi.fn<HandlerDeps['notifyContextLost']>()
    browser.runtime.sendMessage = (async () => {
      throw new Error('Extension context invalidated')
    }) as typeof browser.runtime.sendMessage

    await expect(runSweep(makeSweepDeps(notifyContextLost))).resolves.toEqual({
      _tag: 'SweepPageResponse',
      ok: false,
      queued: 0,
      skipped: 0,
      reason: 'context',
    })
    expect(notifyContextLost).toHaveBeenCalledOnce()
  })
})

describe('sweepSavedStatus — Saved ✓ chip', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('injects exactly one chip on a saved post and none on an unsaved one', async () => {
    document.body.append(tweetArticle({ tweetId: '1' }), tweetArticle({ tweetId: '2' }))
    const requestSavedStatus = vi.fn<(tweetIds: string[]) => Promise<string[]>>(async () => ['1'])

    await sweepSavedStatus({
      document,
      inScope: () => true,
      requestSavedStatus,
    })

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

    await sweepSavedStatus({
      document,
      inScope: () => true,
      requestSavedStatus,
    })
    await sweepSavedStatus({
      document,
      inScope: () => true,
      requestSavedStatus,
    })

    expect(document.querySelectorAll('.xdl-saved-chip').length).toBe(1)
  })

  it('skips entirely when out of scope — no request, no chip', async () => {
    document.body.append(tweetArticle({ tweetId: '1' }))
    const requestSavedStatus = vi.fn<(tweetIds: string[]) => Promise<string[]>>(async () => ['1'])

    await sweepSavedStatus({
      document,
      inScope: () => false,
      requestSavedStatus,
    })

    expect(requestSavedStatus).not.toHaveBeenCalled()
    expect(document.querySelectorAll('.xdl-saved-chip').length).toBe(0)
  })

  it('does not inject a reply after its scope closes in flight', async () => {
    document.body.append(tweetArticle({ tweetId: '1' }))
    let inScope = true
    let resolve!: (saved: string[]) => void
    const requestSavedStatus = (): Promise<string[]> =>
      new Promise((done) => {
        resolve = done
      })

    const sweep = sweepSavedStatus({
      document,
      inScope: () => inScope,
      requestSavedStatus,
    })
    inScope = false
    resolve(['1'])
    await sweep

    expect(document.querySelectorAll('.xdl-saved-chip')).toHaveLength(0)
  })

  it('fail-safe: an empty reply marks nothing', async () => {
    document.body.append(tweetArticle({ tweetId: '1' }))
    const requestSavedStatus = vi.fn<(tweetIds: string[]) => Promise<string[]>>(
      async () => [] as string[],
    )

    await sweepSavedStatus({
      document,
      inScope: () => true,
      requestSavedStatus,
    })

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

    handleSavedStatusUpdate(msg, makeSavedStatusDeps(true), () => {})
    expect(
      Option.getOrNull(findArticle(document, '1'))?.querySelectorAll('.xdl-saved-chip').length,
    ).toBe(1)
    expect(
      Option.getOrNull(findArticle(document, '2'))?.querySelectorAll('.xdl-saved-chip').length,
    ).toBe(0)

    // Re-push (chips are idempotent, like the sweep's).
    handleSavedStatusUpdate(msg, makeSavedStatusDeps(true), () => {})
    expect(document.querySelectorAll('.xdl-saved-chip').length).toBe(1)
  })

  it('no-ops when the Saved status is off / out of scope on this page', () => {
    document.body.append(tweetArticle({ tweetId: '1' }))

    handleSavedStatusUpdate(
      { _tag: 'SavedStatusUpdate', saved: ['1'] },
      makeSavedStatusDeps(false),
      () => {},
    )

    expect(document.querySelectorAll('.xdl-saved-chip').length).toBe(0)
  })

  it('fail-safe: malformed or empty payloads mark nothing', () => {
    document.body.append(tweetArticle({ tweetId: '1' }))

    handleSavedStatusUpdate({ _tag: 'SavedStatusUpdate' }, makeSavedStatusDeps(true), () => {})
    handleSavedStatusUpdate(
      { _tag: 'SavedStatusUpdate', saved: [] },
      makeSavedStatusDeps(true),
      () => {},
    )
    handleSavedStatusUpdate(
      { _tag: 'SavedStatusUpdate', saved: 'nope' },
      makeSavedStatusDeps(true),
      () => {},
    )
    handleSavedStatusUpdate(
      { _tag: 'SavedStatusUpdate', saved: [42] },
      makeSavedStatusDeps(true),
      () => {},
    )

    expect(document.querySelectorAll('.xdl-saved-chip').length).toBe(0)
  })

  it('REGRESSION: non-x adapter no-ops even when active — the sweep DOM is X-specific', () => {
    document.body.append(tweetArticle({ tweetId: '1' }))

    handleSavedStatusUpdate(
      { _tag: 'SavedStatusUpdate', saved: ['1'] },
      makeSavedStatusDeps(true, 'instagram'),
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
  const authority = {
    extensionId: 'ours',
    popupUrl: 'chrome-extension://ours/popup.html',
  }
  const worker = { id: authority.extensionId }
  const popup = {
    id: authority.extensionId,
    url: authority.popupUrl,
    documentId: 'popup',
  }

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
      store: {
        get: () => undefined,
        reconcileDetected: () => ({ added: 0, updated: 0, changed: false }),
        values: () => [],
      },
      adapter: { platform: 'x', detectRenderedMedia: () => [] },
      document,
      location: { pathname: '/home' } as Location,
    } as unknown as HandlerDeps
    const sendResponse = vi.fn<(r: unknown) => void>()
    const kept = dispatchOverlayMessage(raw, deps, sendResponse, worker, authority)
    expect(kept).toBe(true)
    expect(sendResponse).toHaveBeenCalledWith({
      _tag: 'RefreshMediaUrlResponse',
    })
  })

  it('ClearTweetRequest dispatches an exact retryable non-X reply', () => {
    const raw = {
      _tag: 'ClearTweetRequest',
      tweetId: '99',
      scopes: ['bookmark'],
      allLists: true,
    }
    const deps = {
      adapter: { platform: 'instagram' },
      document,
      location: { pathname: '/jack' } as Location,
      clearLog: () => {},
    } as unknown as HandlerDeps
    const sendResponse = vi.fn<(r: unknown) => void>()
    dispatchOverlayMessage(raw, deps, sendResponse, worker, authority)
    expect(sendResponse).toHaveBeenCalledWith({
      _tag: 'ClearTweetResponse',
      results: [{ scope: 'bookmark', state: 'not-actionable' }],
    })
  })

  it('LocateClearTweetRequest is read-only and exact on an unmounted tweet', () => {
    const raw = {
      _tag: 'LocateClearTweetRequest',
      tweetId: '99',
      scopes: ['bookmark'],
      allLists: false,
    }
    const deps = {
      adapter: { platform: 'x' },
      document,
      location: { pathname: '/jack/bookmarks' } as Location,
      clearScopeAttempt: vi.fn<HandlerDeps['clearScopeAttempt']>(),
    } as unknown as HandlerDeps
    const sendResponse = vi.fn<(r: unknown) => void>()
    dispatchOverlayMessage(raw, deps, sendResponse, worker, authority)
    expect(sendResponse).toHaveBeenCalledWith({
      _tag: 'LocateClearTweetResponse',
      mounted: false,
    })
    expect(deps.clearScopeAttempt).not.toHaveBeenCalled()
  })

  it('LocateClearTweetRequest reports mounted scope states without clicking', () => {
    document.body.append(tweetArticle({ tweetId: '99', bookmarked: true, liked: false }))
    const attempt = vi.fn<HandlerDeps['clearScopeAttempt']>()
    const deps = {
      adapter: { platform: 'x' },
      document,
      location: { pathname: '/jack/likes' } as Location,
      clearScopeAttempt: attempt,
    } as unknown as HandlerDeps
    const sendResponse = vi.fn<(r: unknown) => void>()
    dispatchOverlayMessage(
      {
        _tag: 'LocateClearTweetRequest',
        tweetId: '99',
        scopes: ['bookmark', 'like'],
        allLists: true,
      },
      deps,
      sendResponse,
      worker,
      authority,
    )
    expect(sendResponse).toHaveBeenCalledWith({
      _tag: 'LocateClearTweetResponse',
      mounted: true,
      results: [
        { scope: 'bookmark', state: 'actionable' },
        { scope: 'like', state: 'already-clear' },
      ],
    })
    expect(attempt).not.toHaveBeenCalled()
  })

  it.each(['ClearVisibleRequest', 'ClearWholeListRequest'])(
    'rejects retired unsafe popup action %s',
    (tag) => {
      const sendResponse = vi.fn<(r: unknown) => void>()
      expect(
        dispatchOverlayMessage({ _tag: tag }, {} as HandlerDeps, sendResponse, popup, authority),
      ).toBeUndefined()
      expect(sendResponse).not.toHaveBeenCalled()
    },
  )

  it('DrainPageRequest — the real popup usePageAction literal ({ _tag }) dispatches', async () => {
    const raw = { _tag: 'DrainPageRequest' }
    const deps = {
      store: { values: () => [] },
      location: { pathname: '/home' } as Location,
      clearLog: () => {},
      sendTracked: vi.fn<HandlerDeps['sendTracked']>(async () => ({
        _tag: 'started',
      })),
    } as unknown as HandlerDeps
    const sendResponse = vi.fn<(r: unknown) => void>()
    const kept = dispatchOverlayMessage(raw, deps, sendResponse, popup, authority)
    expect(kept).toBe(true)
    await Promise.resolve()
    expect(sendResponse).toHaveBeenCalledWith({
      _tag: 'DrainPageResponse',
      ok: true,
      count: 0,
    })
  })

  it('SweepPageRequest — the real popup usePageAction literal ({ _tag }) dispatches', () => {
    const raw = { _tag: 'SweepPageRequest' }
    const deps = {
      location: { pathname: '/jack' } as Location, // not a Likes/Bookmarks list page
      clearLog: () => {},
    } as unknown as HandlerDeps
    const sendResponse = vi.fn<(r: unknown) => void>()
    const kept = dispatchOverlayMessage(raw, deps, sendResponse, popup, authority)
    expect(kept).toBe(true)
    expect(sendResponse).toHaveBeenCalledWith({
      _tag: 'SweepPageResponse',
      ok: false,
      queued: 0,
      skipped: 0,
      reason: 'not-list-page',
    })
  })

  it('rejects a content-script or foreign sender before any popup-only action runs', () => {
    const deps = {
      adapter: { platform: 'threads' },
      location: { pathname: '/jack/bookmarks' } as Location,
      clearLog: vi.fn<HandlerDeps['clearLog']>(),
    } as unknown as HandlerDeps
    for (const sender of [
      { id: 'ours', tab: { id: 7 }, url: authority.popupUrl },
      { id: 'foreign', url: authority.popupUrl },
    ]) {
      const sendResponse = vi.fn<(r: unknown) => void>()
      expect(
        dispatchOverlayMessage({ _tag: 'DrainPageRequest' }, deps, sendResponse, sender, authority),
      ).toBe(true)
      expect(sendResponse).toHaveBeenCalledWith({
        _tag: 'DrainPageResponse',
        ok: false,
        reason: 'unauthorized',
      })
    }
    expect(isPopupActionSender({ id: 'ours', url: authority.popupUrl }, authority)).toBe(true)
  })

  it('a TabBroadcast tag the table also handles (TransferOutcome) still dispatches', () => {
    const raw = {
      _tag: 'TransferOutcome',
      requestId: 'req-1',
      outcome: 'complete',
      at: 1234,
    }
    const deps = {
      onTransferOutcome: () => false,
    } as unknown as HandlerDeps
    const sendResponse = vi.fn<(r: unknown) => void>()
    // handleTransferOutcome is fire-and-forget: `false`, distinct from the
    // `undefined` a DROPPED (decode-failed / unmapped) message returns below.
    expect(dispatchOverlayMessage(raw, deps, sendResponse, worker, authority)).toBe(false)
  })

  it('accepts worker-only messages only from the extension worker', () => {
    const raw = {
      _tag: 'TransferOutcome',
      requestId: 'req-1',
      outcome: 'complete',
      at: 1234,
    }
    const onTransferOutcome = vi.fn<HandlerDeps['onTransferOutcome']>()
    const deps = { onTransferOutcome } as unknown as HandlerDeps
    for (const sender of [
      popup,
      { id: authority.extensionId, tab: { id: 1 } },
      { id: 'foreign' },
    ]) {
      expect(dispatchOverlayMessage(raw, deps, vi.fn(), sender, authority)).toBeUndefined()
      expect(onTransferOutcome).not.toHaveBeenCalled()
    }
    expect(dispatchOverlayMessage(raw, deps, vi.fn(), worker, authority)).toBe(false)
    expect(onTransferOutcome).toHaveBeenCalledOnce()
  })

  it('drops a popup-forged ClearTweetRequest before any clear attempt', () => {
    const clearScopeAttempt = vi.fn<HandlerDeps['clearScopeAttempt']>()
    const deps = {
      adapter: { platform: 'x' },
      clearScopeAttempt,
    } as unknown as HandlerDeps
    expect(
      dispatchOverlayMessage(
        {
          _tag: 'ClearTweetRequest',
          tweetId: '1',
          scopes: ['bookmark'],
          allLists: false,
        },
        deps,
        vi.fn(),
        popup,
        authority,
      ),
    ).toBeUndefined()
    expect(clearScopeAttempt).not.toHaveBeenCalled()
  })

  it('drops a malformed known-tag payload without dispatching, and warns UNCONDITIONALLY (parity with background.ts)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const deps = { adapter: { platform: 'x' } } as unknown as HandlerDeps
    const sendResponse = vi.fn<(r: unknown) => void>()
    const kept = dispatchOverlayMessage(
      { _tag: 'ClearTweetRequest', tweetId: 5 },
      deps,
      sendResponse,
      worker,
      authority,
    )
    expect(kept).toBeUndefined()
    expect(sendResponse).not.toHaveBeenCalled()
    // NOT DEV-gated: the silent-drop signature must be visible in any build.
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('ClearTweetRequest FAILED overlay schema decode')
    warn.mockRestore()
  })

  it('leaves a valid worker SettingsChanged broadcast to the settings listener without warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const deps = { adapter: { platform: 'x' } } as unknown as HandlerDeps
    const sendResponse = vi.fn<(r: unknown) => void>()
    const settings = {
      quickGrabEnabled: true,
      quickGrabModifier: 'alt',
      downloadBadgeEnabled: true,
      downloadDockEnabled: true,
      dockGlassEnabled: true,
      autoRevealSensitiveEnabled: false,
      clearOnSave: false,
      autoNotInterestedOnSave: false,
      showSavedStatus: true,
      captureEnabled: true,
      captureAllScrolled: false,
      autoUnbookmarkOnSave: false,
      autoUnlikeOnSave: false,
      downloadStrategy: 'fetched',
    }

    expect(
      dispatchOverlayMessage(
        { _tag: 'SettingsChanged', settings },
        deps,
        sendResponse,
        worker,
        authority,
      ),
    ).toBeUndefined()
    expect(sendResponse).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('leaves a valid worker CaptureEpochChanged wake to its listener without warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const deps = { adapter: { platform: 'x' } } as unknown as HandlerDeps
    const sendResponse = vi.fn<(r: unknown) => void>()

    expect(
      dispatchOverlayMessage(
        { _tag: 'CaptureEpochChanged' },
        deps,
        sendResponse,
        worker,
        authority,
      ),
    ).toBeUndefined()
    expect(sendResponse).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('drops duplicate-scope Locate and Clear requests before any attempt', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const clearScopeAttempt = vi.fn<HandlerDeps['clearScopeAttempt']>()
    const deps = {
      adapter: { platform: 'x' },
      clearScopeAttempt,
    } as unknown as HandlerDeps
    const sendResponse = vi.fn<(r: unknown) => void>()
    for (const _tag of ['LocateClearTweetRequest', 'ClearTweetRequest'] as const) {
      expect(
        dispatchOverlayMessage(
          {
            _tag,
            tweetId: '1',
            scopes: ['bookmark', 'bookmark'],
            allLists: false,
          },
          deps,
          sendResponse,
          worker,
          authority,
        ),
      ).toBeUndefined()
    }
    expect(sendResponse).not.toHaveBeenCalled()
    expect(clearScopeAttempt).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('drops an unknown/garbage tag without dispatching (warns only when a string tag exists to name)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const deps = { adapter: { platform: 'x' } } as unknown as HandlerDeps
    const sendResponse = vi.fn<(r: unknown) => void>()
    const kept = dispatchOverlayMessage(
      { _tag: 'NotARealTag', foo: 1 },
      deps,
      sendResponse,
      worker,
      authority,
    )
    expect(kept).toBeUndefined()
    expect(sendResponse).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    // Tagless garbage: dropped silently — no string tag to name (same gate as
    // background.ts's `typeof rawTag === 'string'`).
    expect(dispatchOverlayMessage('garbage', deps, sendResponse, worker, authority)).toBeUndefined()
    expect(dispatchOverlayMessage(null, deps, sendResponse, worker, authority)).toBeUndefined()
    expect(sendResponse).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})
