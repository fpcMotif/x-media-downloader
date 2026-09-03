import { describe, it, expect } from 'vitest'
import { sourceRank, tweetRecordFromNode } from '../record'
import { findAuthor, forEachTweetNode } from '@/core/adapters/x/walk'
import type { JsonObject, JsonValue } from '@/packages/schema/json'
import thread from '@/test/fixtures/tweet-detail-thread.json'
import links from '@/test/fixtures/tweet-with-links.json'
import cards from '@/test/fixtures/tweet-with-card.json'

/** Pluck a tweet result node out of a fixture by id via the shared traversal. */
const nodeOf = (json: JsonValue, tweetId: string): JsonObject => {
  let hit: JsonObject | undefined
  forEachTweetNode(json, (v) => {
    if (v.tweetId === tweetId) hit = v.node
  })
  if (hit === undefined) throw new Error(`fixture missing tweet ${tweetId}`)
  return hit
}

const rootNode = nodeOf(thread, '2001')
const linksNode = nodeOf(links, '3001')
const flatCardNode = nodeOf(cards.flatCardTweet, '4001')

describe('sourceRank', () => {
  it('ranks tweetDetail above timeline/other', () => {
    expect(sourceRank('tweetDetail')).toBe(2)
    expect(sourceRank('timeline')).toBe(1)
    expect(sourceRank('other')).toBe(1)
  })
})

describe('tweetRecordFromNode', () => {
  const at = 1_700_000_000_000

  it('derives tweetId from rest_id with a legacy.id_str fallback', () => {
    const fromRestId = tweetRecordFromNode({
      node: rootNode,
      author: findAuthor(rootNode),
      mediaRaw: [],
      source: 'tweetDetail',
      capturedAt: at,
    })
    expect(fromRestId?.tweetId).toBe('2001')

    const noRestId = {
      __typename: 'Tweet',
      core: {
        user_results: {
          result: {
            __typename: 'User',
            rest_id: '900',
            legacy: { screen_name: 'fallback_author' },
          },
        },
      },
      legacy: {
        id_str: '8888',
        conversation_id_str: '8888',
        full_text: 'no rest_id here',
        entities: { urls: [], user_mentions: [], hashtags: [] },
      },
    }
    const rec = tweetRecordFromNode({
      node: noRestId,
      author: findAuthor(noRestId),
      mediaRaw: [],
      source: 'timeline',
      capturedAt: at,
    })
    expect(rec?.tweetId).toBe('8888')
  })

  it('attaches the OUTER author even when the node quotes another tweet', () => {
    const outerQuotesInner = {
      __typename: 'Tweet',
      rest_id: '5001',
      // X serializes the quoted tweet's own author here too, often before `core`.
      quoted_status_result: {
        result: {
          __typename: 'Tweet',
          rest_id: '5002',
          core: {
            user_results: {
              result: {
                __typename: 'User',
                rest_id: '999',
                legacy: { screen_name: 'inner_author', name: 'Inner Author' },
              },
            },
          },
          legacy: { id_str: '5002', conversation_id_str: '5002', full_text: 'the quoted tweet' },
        },
      },
      core: {
        user_results: {
          result: {
            __typename: 'User',
            rest_id: '500',
            legacy: { screen_name: 'outer_author', name: 'Outer Author' },
          },
        },
      },
      legacy: {
        id_str: '5001',
        conversation_id_str: '5001',
        full_text: 'the outer tweet quoting another',
        entities: { urls: [], user_mentions: [], hashtags: [] },
      },
    }
    const rec = tweetRecordFromNode({
      node: outerQuotesInner,
      author: findAuthor(outerQuotesInner),
      mediaRaw: [],
      source: 'tweetDetail',
      capturedAt: at,
    })
    expect(rec?.author).toEqual({ handle: 'outer_author', name: 'Outer Author', userId: '500' })
    expect(rec?.author.name).not.toBe('Inner Author')
    expect(rec?.author.userId).not.toBe('999')
    expect(rec?.quotedTweetId).toBe('5002')
  })

  it('expands t.co in text while keeping the original in rawText', () => {
    const rec = tweetRecordFromNode({
      node: linksNode,
      author: findAuthor(linksNode),
      mediaRaw: [],
      source: 'timeline',
      capturedAt: at,
    })
    expect(rec?.rawText).toBe('Two reads: https://t.co/yt00000000 and https://t.co/arx0000000')
    expect(rec?.text).toBe(
      'Two reads: https://www.youtube.com/watch?v=dQw4w9WgXcQ and https://arxiv.org/abs/1706.03762',
    )
  })

  it('stamps source/sourceRank and the passed capturedAt', () => {
    const detail = tweetRecordFromNode({
      node: rootNode,
      author: findAuthor(rootNode),
      mediaRaw: [],
      source: 'tweetDetail',
      capturedAt: at,
    })
    expect(detail?.source).toBe('tweetDetail')
    expect(detail?.sourceRank).toBe(2)
    expect(detail?.capturedAt).toBe(at)

    const timeline = tweetRecordFromNode({
      node: rootNode,
      author: findAuthor(rootNode),
      mediaRaw: [],
      source: 'timeline',
      capturedAt: at,
    })
    expect(timeline?.sourceRank).toBe(1)
  })

  it('joins card metadata onto the matching link, leaving other links untouched', () => {
    const rec = tweetRecordFromNode({
      node: flatCardNode,
      author: findAuthor(flatCardNode),
      mediaRaw: [],
      source: 'tweetDetail',
      capturedAt: at,
    })
    expect(rec?.links).toEqual([
      {
        expandedUrl: 'https://example.com/blog/post',
        displayUrl: 'example.com/blog/post',
        title: 'Example Blog Post',
        description: 'A short description of the blog post.',
        domain: 'example.com',
      },
    ])

    // A second, non-card link must stay as-is (the non-target map branch).
    const twoLinks = {
      __typename: 'Tweet',
      rest_id: '7100',
      core: {
        user_results: {
          result: { __typename: 'User', rest_id: '71', legacy: { screen_name: 'two' } },
        },
      },
      legacy: {
        id_str: '7100',
        conversation_id_str: '7100',
        full_text: 'https://t.co/card000000 and https://t.co/plain00000',
        entities: {
          urls: [
            {
              url: 'https://t.co/card000000',
              expanded_url: 'https://example.com/carded',
              display_url: 'example.com/carded',
              indices: [0, 23],
            },
            {
              url: 'https://t.co/plain00000',
              expanded_url: 'https://example.org/plain',
              display_url: 'example.org/plain',
              indices: [28, 51],
            },
          ],
          user_mentions: [],
          hashtags: [],
        },
      },
      card: {
        legacy: {
          url: 'https://t.co/card000000',
          binding_values: [{ key: 'title', value: { string_value: 'Carded' } }],
        },
      },
    }
    const recTwo = tweetRecordFromNode({
      node: twoLinks,
      author: findAuthor(twoLinks),
      mediaRaw: [],
      source: 'timeline',
      capturedAt: at,
    })
    expect(recTwo?.links).toEqual([
      {
        expandedUrl: 'https://example.com/carded',
        displayUrl: 'example.com/carded',
        title: 'Carded',
      },
      { expandedUrl: 'https://example.org/plain', displayUrl: 'example.org/plain' },
    ])
  })

  it('leaves links untouched when the card url matches no entity', () => {
    const noMatch = {
      __typename: 'Tweet',
      rest_id: '7001',
      core: {
        user_results: {
          result: { __typename: 'User', rest_id: '70', legacy: { screen_name: 'a' } },
        },
      },
      legacy: {
        id_str: '7001',
        conversation_id_str: '7001',
        full_text: 'see https://t.co/known00000',
        entities: {
          urls: [
            {
              url: 'https://t.co/known00000',
              expanded_url: 'https://example.com/known',
              display_url: 'example.com/known',
              indices: [4, 27],
            },
          ],
          user_mentions: [],
          hashtags: [],
        },
      },
      card: {
        legacy: {
          url: 'https://t.co/unrelated0',
          binding_values: [{ key: 'title', value: { string_value: 'Unrelated' } }],
        },
      },
    }
    const rec = tweetRecordFromNode({
      node: noMatch,
      author: findAuthor(noMatch),
      mediaRaw: [],
      source: 'timeline',
      capturedAt: at,
    })
    expect(rec?.links).toEqual([
      { expandedUrl: 'https://example.com/known', displayUrl: 'example.com/known' },
    ])
  })

  it('carries createdAt (epoch ms), lang, reply parentage, mentions, hashtags and media', () => {
    const full = {
      __typename: 'Tweet',
      rest_id: '6001',
      core: {
        user_results: {
          result: {
            __typename: 'User',
            rest_id: '60',
            legacy: { screen_name: 'maker', name: 'Maker' },
          },
        },
      },
      legacy: {
        id_str: '6001',
        conversation_id_str: '5999',
        in_reply_to_status_id_str: '5999',
        in_reply_to_screen_name: 'parent_author',
        full_text: 'hi @bob #effect',
        created_at: 'Thu Apr 24 10:25:00 +0000 2025',
        lang: 'en',
        entities: {
          urls: [],
          // 'garbage' (non-object) and {} (no screen_name/text) exercise the
          // map's undefined paths before the filter drops them.
          user_mentions: [{ screen_name: 'bob' }, 'garbage', {}],
          hashtags: [{ text: 'effect' }, 'garbage', {}],
        },
      },
    }
    const rec = tweetRecordFromNode({
      node: full,
      author: findAuthor(full),
      mediaRaw: [
        {
          type: 'photo',
          media_url_https: 'https://pbs.twimg.com/media/AbcdEfg.jpg',
        },
      ],
      source: 'tweetDetail',
      capturedAt: at,
    })
    expect(rec?.conversationId).toBe('5999')
    expect(rec?.inReplyToTweetId).toBe('5999')
    expect(rec?.inReplyToHandle).toBe('parent_author')
    expect(rec?.createdAt).toBe(Date.parse('Thu Apr 24 10:25:00 +0000 2025'))
    expect(rec?.lang).toBe('en')
    expect(rec?.mentions).toEqual(['bob'])
    expect(rec?.hashtags).toEqual(['effect'])
    expect(rec?.media).toEqual([
      {
        id: 'AbcdEfg',
        type: 'photo',
        url: 'https://pbs.twimg.com/media/AbcdEfg.jpg?name=orig',
        ext: 'jpg',
        index: 0,
      },
    ])
    expect(rec?.retweetOf).toBeUndefined()
  })

  it('falls back conversationId to tweetId and tolerates a malformed created_at', () => {
    const thin = {
      __typename: 'Tweet',
      rest_id: '6100',
      core: {
        user_results: {
          result: { __typename: 'User', rest_id: '61', legacy: { screen_name: 'thin' } },
        },
      },
      legacy: {
        id_str: '6100',
        full_text: 'thin one',
        created_at: 'not a date',
      },
      retweeted_status_result: { result: { __typename: 'Tweet', rest_id: '6000' } },
    }
    const rec = tweetRecordFromNode({
      node: thin,
      author: findAuthor(thin),
      mediaRaw: [],
      source: 'other',
      capturedAt: at,
    })
    expect(rec?.conversationId).toBe('6100')
    expect(rec?.createdAt).toBeUndefined()
    expect(rec?.lang).toBeUndefined()
    expect(rec?.mentions).toEqual([])
    expect(rec?.hashtags).toEqual([])
    expect(rec?.text).toBe('thin one')
    expect(rec?.retweetOf).toBe('6000')
    expect(rec?.source).toBe('other')
  })

  it('returns null for a node without a tweet legacy', () => {
    expect(
      tweetRecordFromNode({
        node: { __typename: 'Tweet', rest_id: '1' },
        author: { handle: '' },
        mediaRaw: [],
        source: 'timeline',
        capturedAt: at,
      }),
    ).toBeNull()
  })

  it('empties tweetId and rawText when neither id nor full_text is present', () => {
    const rec = tweetRecordFromNode({
      node: { __typename: 'Tweet', legacy: {} },
      author: { handle: '' },
      mediaRaw: [],
      source: 'timeline',
      capturedAt: at,
    })
    expect(rec?.tweetId).toBe('')
    expect(rec?.rawText).toBe('')
    expect(rec?.text).toBe('')
    expect(rec?.conversationId).toBe('')
  })
})
