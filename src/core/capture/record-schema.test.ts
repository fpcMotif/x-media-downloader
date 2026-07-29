import { describe, expect, it } from 'vitest'
import { Schema } from 'effect'
import { MAX_CAPTURE_RECORD_BYTES } from './contract'
import { harvestTweets } from './harvest'
import { TweetRecord as ParserTweetRecord } from './record'
import { TweetRecord } from './record-schema'
import thread from '../../test/fixtures/tweet-detail-thread.json'

const record = {
  tweetId: '1',
  conversationId: '1',
  author: { handle: 'alice', userId: '2' },
  text: 'hello',
  rawText: 'hello',
  links: [],
  media: [],
  mentions: [],
  hashtags: [],
  source: 'timeline',
  sourceRank: 1,
  capturedAt: 1,
}

const decode = Schema.decodeUnknownSync(TweetRecord)

describe('capture record schema', () => {
  it('decodes records at the leaf and remains the parser re-export', () => {
    expect(decode(record)).toEqual(record)
    expect(ParserTweetRecord).toBe(TweetRecord)
  })

  it.each([
    ['non-snowflake id', { tweetId: 'tweet' }],
    ['negative timestamp', { capturedAt: -1 }],
    ['cross-source rank', { source: 'tweetDetail', sourceRank: 1 }],
    ['duplicate mention', { mentions: ['alice', 'ALICE'] }],
    ['overlong URL', { links: [{ expandedUrl: `https://x.test/${'x'.repeat(8_192)}` }] }],
    [
      'too many media entries',
      {
        media: Array.from({ length: 5 }, (_, index) => ({
          id: String(index),
          type: 'photo',
          url: `https://x.test/${index}`,
          ext: 'jpg',
          index,
        })),
      },
    ],
  ])('rejects %s', (_name, override) => {
    expect(() => decode({ ...record, ...override })).toThrow(/.+/)
  })

  it('uses the whole-record byte budget without a short text product cap', () => {
    expect(
      decode({
        ...record,
        text: 'x'.repeat(120_000),
        rawText: 'x'.repeat(120_000),
      }),
    ).toMatchObject({ tweetId: '1' })
    expect(() =>
      decode({ ...record, text: 'x'.repeat(MAX_CAPTURE_RECORD_BYTES), rawText: '' }),
    ).toThrow('byte budget')
  })

  it('accepts existing harvested X records', () => {
    const harvested = harvestTweets(thread, {
      source: 'tweetDetail',
      includeTextOnly: false,
      capturedAt: 1_700_000_000_000,
    })
    expect(Schema.decodeUnknownSync(Schema.Array(TweetRecord))(harvested)).toEqual(harvested)
  })
})
