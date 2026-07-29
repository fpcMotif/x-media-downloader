import { Result } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  MAX_RECOVER_TWEET_MEDIA_BODY_BYTES,
  decodeBackgroundRequest,
  decodeRecoverTweetMediaResponse,
  readBackgroundRequestTag,
} from './background'

describe('background ingress direction', () => {
  it.each([
    { _tag: 'TransferOutcome', requestId: 'a', outcome: 'complete', at: 1 },
    { _tag: 'SettingsChanged', settings: {} },
    {
      _tag: 'ClearTweetRequest',
      tweetId: '1',
      scopes: ['bookmark'],
      allLists: false,
    },
    {
      _tag: 'QueueUpdate',
      planned: ['media-1'],
      started: ['media-1'],
      deferred: [],
      duplicates: [],
      failures: [],
      skipped: [],
    },
  ])('rejects a non-worker direction: $._tag', (value) => {
    expect(Result.isFailure(decodeBackgroundRequest(value))).toBe(true)
  })

  it('rejects an excess field before dispatch', () => {
    expect(Result.isFailure(decodeBackgroundRequest({ _tag: 'HistoryRequest', extra: true }))).toBe(
      true,
    )
  })

  it('never invokes a hostile tag getter', () => {
    const value: Record<string, unknown> = {}
    Object.defineProperty(value, '_tag', {
      enumerable: true,
      get: () => {
        throw new Error('must not execute')
      },
    })
    expect(readBackgroundRequestTag(value)).toBeUndefined()
    expect(Result.isFailure(decodeBackgroundRequest(value))).toBe(true)
  })

  it('contains a revoked proxy at tag dispatch', () => {
    const { proxy, revoke } = Proxy.revocable({ _tag: 'MetricsRequest' }, {})
    revoke()
    expect(readBackgroundRequestTag(proxy)).toBeUndefined()
    expect(Result.isFailure(decodeBackgroundRequest(proxy))).toBe(true)
  })

  it('dispatches from the tag without walking an untrusted payload', () => {
    let invoked = false
    const value = { _tag: 'MetricsRequest' } as Record<string, unknown>
    Object.defineProperty(value, 'extra', {
      enumerable: true,
      get: () => {
        invoked = true
        return true
      },
    })
    expect(readBackgroundRequestTag(value)).toBe('MetricsRequest')
    expect(Result.isFailure(decodeBackgroundRequest(value))).toBe(true)
    expect(invoked).toBe(false)
  })
})

describe('syndication recovery reply', () => {
  it('accepts the full raw-body budget despite JSON envelope escaping', () => {
    const body = '\u0000'.repeat(MAX_RECOVER_TWEET_MEDIA_BODY_BYTES)
    expect(decodeRecoverTweetMediaResponse({ _tag: 'RecoverTweetMediaResponse', body })).toEqual({
      _tag: 'RecoverTweetMediaResponse',
      body,
    })
  })

  it('enforces UTF-8 body bytes, not only UTF-16 length', () => {
    expect(
      decodeRecoverTweetMediaResponse({
        _tag: 'RecoverTweetMediaResponse',
        body: '€'.repeat(Math.floor(MAX_RECOVER_TWEET_MEDIA_BODY_BYTES / 3)),
      }),
    ).toBeDefined()
    expect(
      decodeRecoverTweetMediaResponse({
        _tag: 'RecoverTweetMediaResponse',
        body: '€'.repeat(Math.floor(MAX_RECOVER_TWEET_MEDIA_BODY_BYTES / 3) + 1),
      }),
    ).toBeUndefined()
  })
})
