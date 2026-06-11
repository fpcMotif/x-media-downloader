import { describe, it, expect } from 'vitest'
import { sourceFromPath, detectCandidates } from './capture'

/**
 * Inline fixtures mirror the shape of `src/test/fixtures/tweet-detail.json`:
 * a `legacy` object carries the viewer flags (`bookmarked` / `favorited`), the
 * media, text, links; `rest_id` (or `legacy.id_str`) carries the tweet id; the
 * author `screen_name` lives in a nested `core.user_results.result.legacy`.
 */
const photo = (idStr: string, basename: string) => ({
  type: 'photo',
  id_str: idStr,
  media_url_https: `https://pbs.twimg.com/media/${basename}.jpg`,
})

const tweetNode = (opts: {
  restId: string
  screenName?: string
  bookmarked?: boolean
  favorited?: boolean
  fullText?: string
  createdAt?: unknown
  media?: ReadonlyArray<unknown>
  urls?: ReadonlyArray<unknown>
}) => ({
  __typename: 'Tweet',
  rest_id: opts.restId,
  core:
    opts.screenName === undefined
      ? undefined
      : { user_results: { result: { legacy: { screen_name: opts.screenName } } } },
  legacy: {
    full_text: opts.fullText,
    bookmarked: opts.bookmarked,
    favorited: opts.favorited,
    ...(opts.createdAt !== undefined ? { created_at: opts.createdAt } : {}),
    ...(opts.urls !== undefined ? { entities: { urls: opts.urls } } : {}),
    ...(opts.media !== undefined ? { extended_entities: { media: opts.media } } : {}),
  },
})

/** A timeline-ish wrapper around tweet result nodes (any endpoint shape). */
const timeline = (...results: ReadonlyArray<unknown>) => ({
  data: {
    bookmark_timeline_v2: {
      timeline: {
        instructions: [
          {
            type: 'TimelineAddEntries',
            entries: results.map((r, i) => ({
              entryId: `tweet-${i}`,
              content: { itemContent: { tweet_results: { result: r } } },
            })),
          },
        ],
      },
    },
  },
})

describe('sourceFromPath', () => {
  it('maps a final-segment Bookmarks op to bookmarks', () => {
    expect(sourceFromPath('/i/api/graphql/abc123/Bookmarks')).toBe('bookmarks')
  })

  it('maps a final-segment Likes op to likes', () => {
    expect(sourceFromPath('/i/api/graphql/QID-9/Likes')).toBe('likes')
  })

  it('matches only the FINAL segment — BookmarksFoo / Likes-extra => null', () => {
    expect(sourceFromPath('/i/api/graphql/abc/BookmarksFoo')).toBeNull()
    expect(sourceFromPath('/i/api/graphql/abc/Likes2')).toBeNull()
    expect(sourceFromPath('/i/api/graphql/Bookmarks/abc')).toBeNull()
  })

  it('returns null for unrelated endpoints and empty input', () => {
    expect(sourceFromPath('/i/api/graphql/abc/TweetDetail')).toBeNull()
    expect(sourceFromPath('')).toBeNull()
    expect(sourceFromPath('/Bookmarks')).toBe('bookmarks')
  })
})

describe('detectCandidates', () => {
  it('captures a bookmarked tweet under "bookmarks" with handle, text, media', () => {
    const json = timeline(
      tweetNode({
        restId: '100',
        screenName: 'alice',
        bookmarked: true,
        favorited: false,
        fullText: 'hello world',
        createdAt: 'Wed Jun 11 00:00:00 +0000 2026',
        media: [photo('p1', 'AAA'), photo('p2', 'BBB')],
      }),
    )
    const out = detectCandidates(json, 'bookmarks')
    expect(out).toHaveLength(1)
    const c = out[0]!
    expect(c).toMatchObject({ tweetId: '100', handle: 'alice', source: 'bookmarks' })
    expect(c.text).toBe('hello world')
    expect(c.createdAt).toBe('Wed Jun 11 00:00:00 +0000 2026')
    expect(c.items).toHaveLength(2)
    expect(c.items[0]).toMatchObject({ type: 'photo', tweetId: '100', handle: 'alice' })
    expect(c.items[0]!.url).toContain('name=orig')
  })

  it('does NOT capture a bookmarked-but-not-favorited tweet under "likes"', () => {
    const json = timeline(
      tweetNode({ restId: '100', screenName: 'alice', bookmarked: true, favorited: false }),
    )
    expect(detectCandidates(json, 'likes')).toEqual([])
  })

  it('captures a favorited tweet under "likes" (viewer flag matches source)', () => {
    const json = timeline(
      tweetNode({ restId: '200', screenName: 'bob', bookmarked: false, favorited: true }),
    )
    const out = detectCandidates(json, 'likes')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ tweetId: '200', handle: 'bob', source: 'likes' })
  })

  it('skips a retweet wrapper but captures its inner bookmarked tweet once', () => {
    // The wrapper carries legacy.retweeted_status_result and is itself skipped;
    // the inner tweet (bookmarked) is visited on its own and captured ONCE.
    const inner = tweetNode({
      restId: '300',
      screenName: 'carol',
      bookmarked: true,
      media: [photo('q1', 'CCC')],
    })
    const wrapper = {
      __typename: 'Tweet',
      rest_id: '999',
      core: { user_results: { result: { legacy: { screen_name: 'retweeter' } } } },
      legacy: {
        bookmarked: true,
        full_text: 'RT @carol: ...',
        retweeted_status_result: { result: inner },
      },
    }
    const json = timeline(wrapper)
    const out = detectCandidates(json, 'bookmarks')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ tweetId: '300', source: 'bookmarks' })
    // never the wrapper's own id
    expect(out.some((c) => c.tweetId === '999')).toBe(false)
  })

  it('excludes a quoted stranger tweet that the viewer has not bookmarked', () => {
    // Outer is bookmarked; the quoted inner tweet is a stranger's (not bookmarked).
    const quoted = tweetNode({
      restId: '500',
      screenName: 'stranger',
      bookmarked: false,
      favorited: false,
      fullText: 'stranger quote',
    })
    const outer = {
      __typename: 'Tweet',
      rest_id: '400',
      core: { user_results: { result: { legacy: { screen_name: 'alice' } } } },
      legacy: {
        bookmarked: true,
        full_text: 'check this out',
        quoted_status_result: { result: quoted },
      },
    }
    const json = timeline(outer)
    const out = detectCandidates(json, 'bookmarks')
    expect(out).toHaveLength(1)
    expect(out[0]!.tweetId).toBe('400')
    expect(out.some((c) => c.tweetId === '500')).toBe(false)
  })

  it('yields a text-only bookmarked tweet with items:[] (no extended_entities)', () => {
    const json = timeline(
      tweetNode({
        restId: '600',
        screenName: 'dave',
        bookmarked: true,
        fullText: 'a thread with no media',
      }),
    )
    const out = detectCandidates(json, 'bookmarks')
    expect(out).toHaveLength(1)
    expect(out[0]!.items).toEqual([])
    expect(out[0]!.text).toBe('a thread with no media')
  })

  it('falls back to "" for missing full_text and missing screen_name', () => {
    const json = timeline(tweetNode({ restId: '700', bookmarked: true }))
    const out = detectCandidates(json, 'bookmarks')
    expect(out).toHaveLength(1)
    expect(out[0]!.text).toBe('')
    expect(out[0]!.handle).toBe('')
  })

  it('omits createdAt when legacy.created_at is not a string', () => {
    const json = timeline(
      tweetNode({ restId: '710', screenName: 'eve', bookmarked: true, createdAt: 12345 }),
    )
    const out = detectCandidates(json, 'bookmarks')
    expect(out).toHaveLength(1)
    expect(out[0]!.createdAt).toBeUndefined()
  })

  it('extracts links from legacy.entities (expanded_url preferred)', () => {
    const json = timeline(
      tweetNode({
        restId: '720',
        screenName: 'frank',
        bookmarked: true,
        urls: [{ url: 'https://t.co/x', expanded_url: 'https://arxiv.org/abs/2401.1' }],
      }),
    )
    const out = detectCandidates(json, 'bookmarks')
    expect(out[0]!.links).toHaveLength(1)
    expect(out[0]!.links[0]).toMatchObject({
      url: 'https://arxiv.org/abs/2401.1',
      publisher: 'arxiv',
    })
  })

  it('uses legacy.id_str as the tweet id when rest_id is absent', () => {
    const node = {
      __typename: 'Tweet',
      core: { user_results: { result: { legacy: { screen_name: 'grace' } } } },
      legacy: { id_str: '808', bookmarked: true, full_text: 'no rest_id' },
    }
    const out = detectCandidates(timeline(node), 'bookmarks')
    expect(out).toHaveLength(1)
    expect(out[0]!.tweetId).toBe('808')
  })

  it('dedupes the same tweetId (first wins) when it appears twice in the tree', () => {
    const node = tweetNode({
      restId: '900',
      screenName: 'heidi',
      bookmarked: true,
      fullText: 'first',
    })
    const dup = tweetNode({
      restId: '900',
      screenName: 'heidi',
      bookmarked: true,
      fullText: 'second',
    })
    const out = detectCandidates(timeline(node, dup), 'bookmarks')
    expect(out).toHaveLength(1)
    expect(out[0]!.text).toBe('first')
  })

  it('captures nothing from a node lacking a viewer flag for the source', () => {
    // bookmarked omitted entirely => not a bookmark candidate
    const json = timeline(tweetNode({ restId: '1000', screenName: 'ivan', favorited: true }))
    expect(detectCandidates(json, 'bookmarks')).toEqual([])
  })

  it('tolerates non-tree / empty input', () => {
    expect(detectCandidates(null, 'bookmarks')).toEqual([])
    expect(detectCandidates(undefined, 'likes')).toEqual([])
    expect(detectCandidates(42, 'bookmarks')).toEqual([])
    expect(detectCandidates({}, 'bookmarks')).toEqual([])
    expect(detectCandidates([], 'likes')).toEqual([])
  })
})
