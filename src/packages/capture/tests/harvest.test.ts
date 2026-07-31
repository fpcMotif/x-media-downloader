import { describe, expect, it, vi } from 'vitest'
import * as walk from '@/core/adapters/x/walk'
import { harvestTweets } from '../harvest'
import thread from '@/test/fixtures/tweet-detail-thread.json'

const at = 1_700_000_000_000

/** A media tweet and a text-only tweet side by side, so the breadth rule can
 *  keep the former and drop the latter on a non-tweetDetail source. */
const mixed = {
  data: {
    home: {
      instructions: [
        {
          type: 'TimelineAddEntries',
          entries: [
            {
              content: {
                itemContent: {
                  tweet_results: {
                    result: {
                      __typename: 'Tweet',
                      rest_id: '900',
                      core: {
                        user_results: {
                          result: {
                            __typename: 'User',
                            rest_id: '90',
                            legacy: { screen_name: 'shooter', name: 'Shooter' },
                          },
                        },
                      },
                      legacy: {
                        id_str: '900',
                        conversation_id_str: '900',
                        full_text: 'one pic https://t.co/pic0000000',
                        entities: {
                          urls: [
                            {
                              url: 'https://t.co/pic0000000',
                              expanded_url: 'https://example.com/pic',
                              display_url: 'example.com/pic',
                              indices: [8, 31],
                            },
                          ],
                          user_mentions: [],
                          hashtags: [],
                        },
                        extended_entities: {
                          media: [
                            {
                              type: 'photo',
                              id_str: 'PIC',
                              media_url_https: 'https://pbs.twimg.com/media/PIC.jpg',
                            },
                          ],
                        },
                      },
                    },
                  },
                },
              },
            },
            {
              content: {
                itemContent: {
                  tweet_results: {
                    result: {
                      __typename: 'Tweet',
                      rest_id: '901',
                      core: {
                        user_results: {
                          result: {
                            __typename: 'User',
                            rest_id: '91',
                            legacy: { screen_name: 'talker', name: 'Talker' },
                          },
                        },
                      },
                      legacy: {
                        id_str: '901',
                        conversation_id_str: '901',
                        full_text: 'just words, no media',
                        entities: { urls: [], user_mentions: [], hashtags: [] },
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      ],
    },
  },
}

const ids = (recs: ReadonlyArray<{ tweetId: string }>): string[] => recs.map((r) => r.tweetId)

describe('harvestTweets breadth rule', () => {
  it('keeps media tweets and drops text-only ones on a timeline source', () => {
    const recs = harvestTweets(mixed, {
      source: 'timeline',
      includeTextOnly: false,
      capturedAt: at,
    })
    expect(ids(recs)).toEqual(['900'])
  })

  it('keeps text-only tweets when source is tweetDetail', () => {
    const recs = harvestTweets(mixed, {
      source: 'tweetDetail',
      includeTextOnly: false,
      capturedAt: at,
    })
    expect(ids(recs)).toEqual(['900', '901'])
  })

  it('keeps text-only tweets when includeTextOnly is set', () => {
    const recs = harvestTweets(mixed, { source: 'timeline', includeTextOnly: true, capturedAt: at })
    expect(ids(recs)).toEqual(['900', '901'])
  })
})

describe('harvestTweets assembly', () => {
  it('returns fully assembled records (expanded links, media refs, source/sourceRank/capturedAt)', () => {
    const recs = harvestTweets(mixed, {
      source: 'timeline',
      includeTextOnly: false,
      capturedAt: at,
    })
    const rec = recs[0]
    expect(rec?.tweetId).toBe('900')
    expect(rec?.author).toEqual({ handle: 'shooter', name: 'Shooter', userId: '90' })
    expect(rec?.text).toBe('one pic https://example.com/pic')
    expect(rec?.links).toEqual([
      { expandedUrl: 'https://example.com/pic', displayUrl: 'example.com/pic' },
    ])
    expect(rec?.media).toEqual([
      {
        id: 'PIC',
        type: 'photo',
        url: 'https://pbs.twimg.com/media/PIC.jpg?name=orig',
        ext: 'jpg',
        index: 0,
      },
    ])
    expect(rec?.source).toBe('timeline')
    expect(rec?.sourceRank).toBe(1)
    expect(rec?.capturedAt).toBe(at)
  })

  it('carries card titles onto the matching link', () => {
    const carded = {
      data: {
        tweetResult: {
          result: {
            __typename: 'Tweet',
            rest_id: '902',
            core: {
              user_results: {
                result: { __typename: 'User', rest_id: '92', legacy: { screen_name: 'card' } },
              },
            },
            legacy: {
              id_str: '902',
              conversation_id_str: '902',
              full_text: 'see https://t.co/card000000',
              entities: {
                urls: [
                  {
                    url: 'https://t.co/card000000',
                    expanded_url: 'https://example.com/post',
                    display_url: 'example.com/post',
                    indices: [4, 27],
                  },
                ],
                user_mentions: [],
                hashtags: [],
              },
            },
            card: {
              legacy: {
                url: 'https://t.co/card000000',
                binding_values: [{ key: 'title', value: { string_value: 'Carded Title' } }],
              },
            },
          },
        },
      },
    }
    const recs = harvestTweets(carded, {
      source: 'tweetDetail',
      includeTextOnly: false,
      capturedAt: at,
    })
    expect(recs[0]?.links).toEqual([
      {
        expandedUrl: 'https://example.com/post',
        displayUrl: 'example.com/post',
        title: 'Carded Title',
      },
    ])
  })
})

describe('harvestTweets over a module-nested thread (reinforces 002)', () => {
  it('returns all three module-nested records by id on a tweetDetail source', () => {
    const recs = harvestTweets(thread, {
      source: 'tweetDetail',
      includeTextOnly: false,
      capturedAt: at,
    })
    expect(ids(recs).toSorted()).toEqual(['2001', '2002', '2003'])
  })
})

describe('harvestTweets traversal', () => {
  it('consumes forEachTweetNode exactly once (no second walk)', () => {
    const spy = vi.spyOn(walk, 'forEachTweetNode')
    harvestTweets(mixed, { source: 'timeline', includeTextOnly: false, capturedAt: at })
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })
})
