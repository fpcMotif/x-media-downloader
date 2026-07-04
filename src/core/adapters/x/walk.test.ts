import { describe, it, expect } from 'vitest'
import type { RawMedia } from '../../resolver'
import { forEachTweetNode, findAuthor, NESTED_TWEET_KEYS, type Author } from './walk'
import { detectFromJson } from './index'
import tweetDetailThread from '../../../test/fixtures/tweet-detail-thread.json'

type Visit = {
  node: object
  tweetId: string
  handle: string
  author: Author
  mediaRaw: RawMedia[]
}

const collect = (json: unknown): Visit[] => {
  const out: Visit[] = []
  forEachTweetNode(json, (v) => out.push(v))
  return out
}

/** A minimal tweet result node carrying media, parameterized by id + author. */
const photoTweet = (rest_id: string, screen_name: string): object => ({
  __typename: 'Tweet',
  rest_id,
  core: { user_results: { result: { legacy: { screen_name } } } },
  legacy: {
    extended_entities: {
      media: [
        {
          type: 'photo',
          id_str: `${rest_id}m`,
          media_url_https: `https://pbs.twimg.com/media/${rest_id}.jpg`,
        },
      ],
    },
  },
})

describe('forEachTweetNode', () => {
  it('yields one visit per tweet node with { node, tweetId, handle, author, mediaRaw }', () => {
    const result = photoTweet('1790', 'alice')
    const visits = collect({ data: { tweetResult: { result } } })
    expect(visits).toHaveLength(1)
    const v = visits[0]!
    expect(v.node).toBe(result)
    expect(v.tweetId).toBe('1790')
    expect(v.handle).toBe('alice')
    expect(v.author).toEqual({ handle: 'alice' })
    expect(v.mediaRaw).toHaveLength(1)
    expect((v.mediaRaw[0] as { media_url_https: string }).media_url_https).toBe(
      'https://pbs.twimg.com/media/1790.jpg',
    )
  })

  it('derives tweetId from legacy.id_str when rest_id is absent', () => {
    const visits = collect({
      data: {
        result: {
          core: { user_results: { result: { legacy: { screen_name: 'idstr' } } } },
          legacy: { id_str: '7100' },
        },
      },
    })
    expect(visits).toHaveLength(1)
    expect(visits[0]!.tweetId).toBe('7100')
  })

  it('unwraps TweetWithVisibilityResults to its inner .tweet', () => {
    const visits = collect({
      data: {
        tweetResult: {
          result: {
            __typename: 'TweetWithVisibilityResults',
            tweet: photoTweet('5500', 'gated'),
          },
        },
      },
    })
    expect(visits).toHaveLength(1)
    expect(visits[0]!.tweetId).toBe('5500')
    expect(visits[0]!.handle).toBe('gated')
  })

  it('SKIPS a TweetTombstone node', () => {
    const visits = collect({
      data: {
        instructions: [
          {
            tweet_results: {
              result: {
                __typename: 'TweetTombstone',
                tombstone: { text: { text: 'unavailable' } },
              },
            },
          },
          { tweet_results: { result: photoTweet('6600', 'live') } },
        ],
      },
    })
    expect(visits.map((v) => v.tweetId)).toEqual(['6600'])
  })

  it('yields a quoted tweet as its OWN separate visit with its own author', () => {
    const visits = collect({
      data: {
        tweetResult: {
          result: {
            rest_id: '5001',
            quoted_status_result: { result: photoTweet('4000', 'QUOTED_AUTHOR') },
            core: { user_results: { result: { legacy: { screen_name: 'REAL_AUTHOR' } } } },
            legacy: {
              extended_entities: {
                media: [
                  {
                    type: 'photo',
                    id_str: 'o1',
                    media_url_https: 'https://pbs.twimg.com/media/Outer.jpg',
                  },
                ],
              },
            },
          },
        },
      },
    })
    const outer = visits.find((v) => v.tweetId === '5001')
    const quoted = visits.find((v) => v.tweetId === '4000')
    expect(outer).toBeDefined()
    expect(quoted).toBeDefined()
    expect(outer!.handle).toBe('REAL_AUTHOR')
    expect(quoted!.handle).toBe('QUOTED_AUTHOR')
  })

  it('yields a retweeted tweet as its OWN separate visit with its own author', () => {
    const visits = collect({
      data: {
        tweetResult: {
          result: {
            rest_id: '9001',
            retweeted_status_result: { result: photoTweet('8000', 'ORIGINAL_AUTHOR') },
            core: { user_results: { result: { legacy: { screen_name: 'RETWEETER' } } } },
            legacy: {
              extended_entities: {
                media: [
                  {
                    type: 'photo',
                    id_str: 'o1',
                    media_url_https: 'https://pbs.twimg.com/media/Own.jpg',
                  },
                ],
              },
            },
          },
        },
      },
    })
    const own = visits.find((v) => v.tweetId === '9001')
    const original = visits.find((v) => v.tweetId === '8000')
    expect(own!.handle).toBe('RETWEETER')
    expect(original!.handle).toBe('ORIGINAL_AUTHOR')
  })

  it('descends into conversationthread items[] yielding the three module-nested tweets', () => {
    const visits = collect(tweetDetailThread)
    expect(visits).toHaveLength(3)
    expect(visits.map((v) => v.tweetId).toSorted()).toEqual(['2001', '2002', '2003'])
    expect(visits.map((v) => v.handle).toSorted()).toEqual([
      'reply_a_author',
      'reply_b_author',
      'root_author',
    ])
  })
})

describe('findAuthor', () => {
  it('reads handle, name, and userId from the same core subtree', () => {
    const author = findAuthor({
      core: {
        user_results: {
          result: { rest_id: '501', legacy: { screen_name: 'root_author', name: 'Root Author' } },
        },
      },
    })
    expect(author).toEqual({ handle: 'root_author', name: 'Root Author', userId: '501' })
  })

  it('returns an empty handle when no author subtree exists', () => {
    expect(findAuthor({ rest_id: '8300', legacy: {} })).toEqual({ handle: '' })
  })

  it('does not let a quoted tweet author leak into the outer record', () => {
    const author = findAuthor({
      rest_id: '5001',
      quoted_status_result: {
        result: { core: { user_results: { result: { legacy: { screen_name: 'QUOTED' } } } } },
      },
      core: { user_results: { result: { legacy: { screen_name: 'REAL' } } } },
    })
    expect(author.handle).toBe('REAL')
  })
})

describe('NESTED_TWEET_KEYS', () => {
  it('names the quote and retweet subtree keys', () => {
    expect(NESTED_TWEET_KEYS.has('quoted_status_result')).toBe(true)
    expect(NESTED_TWEET_KEYS.has('retweeted_status_result')).toBe(true)
  })
})

describe('detectFromJson refactored onto forEachTweetNode', () => {
  it('returns the SAME MediaItem[] for the thread fixture as before', () => {
    // The thread tweets carry no media, so the detector yields nothing — but the
    // walk still descends to all three (guarded above). Behavior is preserved.
    expect(detectFromJson(tweetDetailThread)).toEqual([])
  })

  it("attributes a quoting tweet's media to its OWN author (unchanged detector output)", () => {
    const items = detectFromJson({
      data: {
        tweetResult: {
          result: {
            rest_id: '5001',
            quoted_status_result: { result: photoTweet('4000', 'QUOTED_AUTHOR') },
            core: { user_results: { result: { legacy: { screen_name: 'REAL_AUTHOR' } } } },
            legacy: {
              extended_entities: {
                media: [
                  {
                    type: 'photo',
                    id_str: 'o1',
                    media_url_https: 'https://pbs.twimg.com/media/Outer.jpg',
                  },
                ],
              },
            },
          },
        },
      },
    })
    expect(items.find((i) => i.postId === '5001')!.author).toBe('REAL_AUTHOR')
    expect(items.find((i) => i.postId === '4000')!.author).toBe('QUOTED_AUTHOR')
  })
})
