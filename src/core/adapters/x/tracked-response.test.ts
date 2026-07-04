import { describe, it, expect } from 'vitest'
import { isGraphqlMediaUrl } from './tracked-response'

describe('isGraphqlMediaUrl', () => {
  it('matches a media-bearing GraphQL operation URL', () => {
    expect(isGraphqlMediaUrl('https://x.com/i/api/graphql/abc/TweetDetail?variables=%7B%7D')).toBe(
      true,
    )
    expect(isGraphqlMediaUrl('https://x.com/i/api/graphql/xyz/TweetResultByRestId?x=1')).toBe(true)
    expect(isGraphqlMediaUrl('https://x.com/i/api/graphql/xyz/ListTweetsTimeline?x=1')).toBe(true)
  })

  it('ignores the optional requestHeaders parameter (X filters on URL alone)', () => {
    expect(
      isGraphqlMediaUrl('https://x.com/i/api/graphql/abc/TweetDetail', { 'x-csrf-token': 'z' }),
    ).toBe(true)
  })

  it('rejects non-GraphQL and non-media-op URLs', () => {
    expect(isGraphqlMediaUrl('https://x.com/i/api/1.1/jot/client_event.json')).toBe(false)
    expect(isGraphqlMediaUrl('https://pbs.twimg.com/media/AAA.jpg')).toBe(false)
    expect(isGraphqlMediaUrl('https://x.com/i/api/graphql/abc/CreateBookmark')).toBe(false)
  })
})
