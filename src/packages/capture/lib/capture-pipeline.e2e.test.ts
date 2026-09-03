import { describe, expect, it } from 'vitest'
import richThread from '@/test/fixtures/tweet-detail-thread.json'
import { toJsonl, toMarkdown } from './export'
import { harvestTweets } from '../harvest'
import type { TweetRecord } from '../record'
import { mergeRecord } from '../store'
import { buildTree } from './tree'

const T1 = 1_700_000_000_000
const T2 = 1_700_000_999_000

/** A second rich TweetDetail page in conversation 2001: a reply (2004) that quotes
 *  an out-of-thread tweet (3001), so the walk emits both 2004 (quotedTweetId 3001)
 *  and 3001 as their own records — the substrate for the quote-inlining assertion. */
const richQuotePage = {
  data: {
    threaded_conversation_with_injections_v2: {
      instructions: [
        {
          type: 'TimelineAddEntries',
          entries: [
            {
              entryId: 'tweet-2004',
              content: {
                itemContent: {
                  tweet_results: {
                    result: {
                      __typename: 'Tweet',
                      rest_id: '2004',
                      core: {
                        user_results: {
                          result: {
                            __typename: 'User',
                            rest_id: '504',
                            legacy: { screen_name: 'quoter', name: 'Quoter' },
                          },
                        },
                      },
                      quoted_status_result: {
                        result: {
                          __typename: 'Tweet',
                          rest_id: '3001',
                          core: {
                            user_results: {
                              result: {
                                __typename: 'User',
                                rest_id: '601',
                                legacy: { screen_name: 'sage', name: 'Sage' },
                              },
                            },
                          },
                          legacy: {
                            id_str: '3001',
                            conversation_id_str: '3001',
                            full_text: 'the quoted insight',
                            entities: { urls: [], user_mentions: [], hashtags: [] },
                          },
                        },
                      },
                      legacy: {
                        id_str: '2004',
                        conversation_id_str: '2001',
                        in_reply_to_status_id_str: '2001',
                        in_reply_to_screen_name: 'root_author',
                        full_text: 'quoting an out-of-thread tweet',
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

/** A thin timeline page that re-serves the root tweet 2001 LATER (T2 > T1) with a
 *  degraded body — the sighting that §6.4 must keep from clobbering the rich one. */
const thinTimeline = {
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
                      rest_id: '2001',
                      core: {
                        user_results: {
                          result: {
                            __typename: 'User',
                            rest_id: '501',
                            legacy: { screen_name: 'root_author', name: 'Root Author' },
                          },
                        },
                      },
                      legacy: {
                        id_str: '2001',
                        conversation_id_str: '2001',
                        full_text: 'THIN sighting — should lose to the rich thread',
                        entities: { urls: [], user_mentions: [], hashtags: [] },
                        extended_entities: {
                          media: [
                            {
                              type: 'photo',
                              id_str: 'THIN',
                              media_url_https: 'https://pbs.twimg.com/media/THIN.jpg',
                            },
                          ],
                        },
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

/** Read-merge-write each record into a tweetId-keyed map via the §6.4 rule, then
 *  return the merged set. */
const mergeAll = (batches: ReadonlyArray<TweetRecord[]>): TweetRecord[] => {
  const byId = new Map<string, TweetRecord>()
  for (const batch of batches) {
    for (const incoming of batch) {
      byId.set(incoming.tweetId, mergeRecord(byId.get(incoming.tweetId), incoming))
    }
  }
  return [...byId.values()]
}

describe('capture pipeline e2e (harvest → merge → tree → export)', () => {
  const rich = harvestTweets(richThread, {
    source: 'tweetDetail',
    includeTextOnly: false,
    capturedAt: T1,
  })
  const quotePage = harvestTweets(richQuotePage, {
    source: 'tweetDetail',
    includeTextOnly: false,
    capturedAt: T1,
  })
  const thin = harvestTweets(thinTimeline, {
    source: 'timeline',
    includeTextOnly: false,
    capturedAt: T2,
  })

  const records = mergeAll([rich, quotePage, thin])
  const tree = buildTree(records).find((t) => t.conversationId === '2001')!
  const markdown = toMarkdown(tree, records)
  const jsonl = toJsonl(records)

  it('re-serves the same root tweet thin, then merges it against the rich thread', () => {
    expect(rich.map((r) => r.tweetId).toSorted()).toEqual(['2001', '2002', '2003'])
    expect(thin.map((r) => r.tweetId)).toEqual(['2001'])
    const root = records.find((r) => r.tweetId === '2001')!
    // The thin sighting was the LAST write for 2001 yet must not win.
    expect(thin[0]!.capturedAt).toBeGreaterThan(rich[0]!.capturedAt)
    expect(root.source).toBe('tweetDetail')
    expect(root.sourceRank).toBe(2)
  })

  it('exports the RICH thread for the re-served tweet, not the thin sighting', () => {
    expect(markdown).toContain('root tweet of the thread')
    expect(markdown).not.toContain('THIN sighting')
    // SAFETY: toJsonl(records) produces JSONL where each line is {id, text, kind} record; records contain the expected root tweet
    const rootLine = jsonl
      .split('\n')
      .map((l) => JSON.parse(l) as { id: string; text: string; kind: string })
      .find((r) => r.id === '2001')!
    expect(rootLine.text).toBe('root tweet of the thread')
    expect(rootLine.kind).toBe('tweet')
  })

  it("inlines a quoted tweet's text where the outer tweet references it", () => {
    const quoter = records.find((r) => r.tweetId === '2004')!
    expect(quoter.quotedTweetId).toBe('3001')
    expect(markdown).toMatch(/> quote https:\/\/x\.com\/\S*status\/3001: the quoted insight/)
  })
})
