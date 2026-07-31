import { describe, it, expect } from 'vitest'
import {
  bodyHasErrorSignal,
  matchReleaseMutationOp,
  tweetIdFromMutationRequestBody,
} from './tracked-mutation'

describe('matchReleaseMutationOp', () => {
  it('matches all four tracked bookmark/like mutation ops', () => {
    expect(matchReleaseMutationOp('https://x.com/i/api/graphql/abc/CreateBookmark')).toBe(
      'CreateBookmark',
    )
    expect(matchReleaseMutationOp('https://x.com/i/api/graphql/abc/DeleteBookmark')).toBe(
      'DeleteBookmark',
    )
    expect(matchReleaseMutationOp('https://x.com/i/api/graphql/abc/FavoriteTweet')).toBe(
      'FavoriteTweet',
    )
    expect(matchReleaseMutationOp('https://x.com/i/api/graphql/abc/UnfavoriteTweet')).toBe(
      'UnfavoriteTweet',
    )
  })

  it('matches regardless of a query string on the URL', () => {
    expect(matchReleaseMutationOp('https://x.com/i/api/graphql/abc/DeleteBookmark?foo=bar')).toBe(
      'DeleteBookmark',
    )
  })

  it('rejects a media-bearing op — the two predicates are disjoint', () => {
    expect(matchReleaseMutationOp('https://x.com/i/api/graphql/abc/TweetDetail')).toBe(null)
    expect(matchReleaseMutationOp('https://x.com/i/api/graphql/abc/Bookmarks')).toBe(null)
  })

  it('rejects near-miss op names — exact LAST-segment match only, not substring', () => {
    expect(matchReleaseMutationOp('https://x.com/i/api/graphql/abc/DeleteBookmarkBatch')).toBe(null)
    expect(matchReleaseMutationOp('https://x.com/i/api/graphql/abc/xCreateBookmark')).toBe(null)
    expect(matchReleaseMutationOp('https://x.com/i/api/graphql/abc/CreateBookmark/extra')).toBe(
      null,
    )
  })

  it('rejects non-GraphQL URLs', () => {
    expect(matchReleaseMutationOp('https://x.com/i/api/1.1/jot/client_event.json')).toBe(null)
    expect(matchReleaseMutationOp('https://pbs.twimg.com/media/AAA.jpg')).toBe(null)
  })

  it('rejects an unparseable URL rather than throwing', () => {
    // Contains the tracked-path substring so it reaches the `new URL()` parse (not
    // the early-return guard above) — a malformed IPv6 host is genuinely unparseable
    // even against a base, unlike almost every other malformed string.
    expect(matchReleaseMutationOp('http://[::1/i/api/graphql/abc/CreateBookmark')).toBe(null)
  })

  it('accepts a bare pathname (no origin) via the safe base', () => {
    expect(matchReleaseMutationOp('/i/api/graphql/abc/CreateBookmark')).toBe('CreateBookmark')
  })
})

describe('bodyHasErrorSignal', () => {
  it('true when the body carries a non-empty errors array', () => {
    expect(bodyHasErrorSignal('{"errors":[{"message":"rate limited"}]}')).toBe(true)
  })

  it('false when errors is absent, empty, or the body is a clean success', () => {
    expect(bodyHasErrorSignal('{"data":{"tweet_bookmark_put":"Done"}}')).toBe(false)
    expect(bodyHasErrorSignal('{"errors":[]}')).toBe(false)
  })

  it('false (never throws) on unparseable or non-object bodies', () => {
    expect(bodyHasErrorSignal('not json')).toBe(false)
    expect(bodyHasErrorSignal('null')).toBe(false)
    expect(bodyHasErrorSignal('"a string"')).toBe(false)
    expect(bodyHasErrorSignal('[1,2,3]')).toBe(false)
  })
})

describe('tweetIdFromMutationRequestBody', () => {
  it('reads variables.tweet_id when present', () => {
    expect(
      tweetIdFromMutationRequestBody('{"variables":{"tweet_id":"1901234567890"},"queryId":"x"}'),
    ).toBe('1901234567890')
  })

  it('undefined when variables or tweet_id is missing', () => {
    expect(tweetIdFromMutationRequestBody('{"queryId":"x"}')).toBe(undefined)
    expect(tweetIdFromMutationRequestBody('{"variables":{}}')).toBe(undefined)
  })

  it('undefined when tweet_id is not a string', () => {
    expect(tweetIdFromMutationRequestBody('{"variables":{"tweet_id":12345}}')).toBe(undefined)
  })

  // Adversarial-review finding: a bare `typeof === 'string'` check let ANY string
  // through — including arbitrary attacker/page-supplied text — straight into the
  // durable, user-exportable diagnostics log. `requestBody` crosses the MAIN-world
  // tee's untrusted boundary (a page script, or another extension's content script
  // sharing the same document, can dispatch a forged 'xmd:mutation-response' event —
  // see inject.content.ts's docstring), so the shape MUST be validated here, not
  // merely typed.
  it('undefined when tweet_id is a non-numeric string (forged/arbitrary text, not a real snowflake id)', () => {
    expect(tweetIdFromMutationRequestBody('{"variables":{"tweet_id":"not-a-real-id"}}')).toBe(
      undefined,
    )
    expect(
      tweetIdFromMutationRequestBody('{"variables":{"tweet_id":"<script>alert(1)</script>"}}'),
    ).toBe(undefined)
  })

  it('undefined when tweet_id is an empty string or exceeds the 20-digit snowflake bound', () => {
    expect(tweetIdFromMutationRequestBody('{"variables":{"tweet_id":""}}')).toBe(undefined)
    expect(
      tweetIdFromMutationRequestBody('{"variables":{"tweet_id":"123456789012345678901"}}'),
    ).toBe(undefined)
  })

  it('undefined (never throws) on unparseable or non-object bodies', () => {
    expect(tweetIdFromMutationRequestBody('not json')).toBe(undefined)
    expect(tweetIdFromMutationRequestBody('null')).toBe(undefined)
    expect(tweetIdFromMutationRequestBody('[1,2,3]')).toBe(undefined)
  })
})
