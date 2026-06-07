import { describe, it, expect } from 'vitest'
import { isGraphqlMediaUrl } from './tee'

describe('isGraphqlMediaUrl', () => {
  it('matches media-bearing GraphQL operations', () => {
    expect(isGraphqlMediaUrl('https://x.com/i/api/graphql/abc/TweetDetail?variables=%7B%7D')).toBe(true)
    expect(isGraphqlMediaUrl('https://x.com/i/api/graphql/xyz/TweetResultByRestId?x=1')).toBe(true)
  })

  it('ignores non-GraphQL and non-media URLs', () => {
    expect(isGraphqlMediaUrl('https://x.com/i/api/1.1/jot/client_event.json')).toBe(false)
    expect(isGraphqlMediaUrl('https://pbs.twimg.com/media/AAA.jpg')).toBe(false)
    expect(isGraphqlMediaUrl('https://x.com/i/api/graphql/abc/CreateBookmark')).toBe(false)
  })
})
