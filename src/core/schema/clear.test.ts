import { describe, expect, it } from 'vitest'
import { Result, Schema } from 'effect'
import {
  CLEAR_LOG_LIMIT,
  MAX_CLEAR_RESPONSE_BYTES,
  CLEAR_VISIBILITY_PULSE_LIMIT,
  ClearLogRecord,
  ClearTweetRequest,
  ClearVisibilityPulse,
  LocateClearTweetRequest,
  decodeClearLogRequest,
  decodeClearLogResponse,
  decodeClearTweetResponse,
  decodeLocateClearTweetResponse,
} from './clear'

describe('Clear wire schema', () => {
  it('keeps Locate multi-scope and Clear single-scope', () => {
    const shared = {
      tweetId: '12345678901234567890',
      scopes: ['bookmark', 'like'],
      allLists: false,
    }
    expect(
      Schema.decodeUnknownSync(LocateClearTweetRequest)({
        _tag: 'LocateClearTweetRequest',
        ...shared,
      }).scopes,
    ).toEqual(shared.scopes)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(ClearTweetRequest)({ _tag: 'ClearTweetRequest', ...shared }),
      ),
    ).toBe(true)
  })

  it('requires exact Locate replies and complete unique scope coverage', () => {
    const valid = {
      _tag: 'LocateClearTweetResponse',
      mounted: true,
      results: [
        { scope: 'bookmark', state: 'actionable' },
        { scope: 'like', state: 'already-clear' },
      ],
    }
    expect(decodeLocateClearTweetResponse(valid, ['bookmark', 'like'])).toEqual(valid)
    for (const reply of [
      { ...valid, extra: true },
      { ...valid, results: [valid.results[0]] },
      { ...valid, results: [valid.results[0], valid.results[0]] },
      { ...valid, results: [{ scope: 'bookmark', state: 'future' }, valid.results[1]] },
      { _tag: 'LocateClearTweetResponse', mounted: false, results: [] },
    ])
      expect(decodeLocateClearTweetResponse(reply, ['bookmark', 'like'])).toBeUndefined()

    let gets = 0
    const hostile = new Proxy(valid, {
      get: () => {
        gets += 1
        throw new Error('must not execute')
      },
    })
    expect(decodeLocateClearTweetResponse(hostile, ['bookmark', 'like'])).toEqual(valid)
    expect(gets).toBe(0)
    let toJsonGets = 0
    const toJson = new Proxy(
      Object.defineProperty({ ...valid }, 'toJSON', {
        enumerable: true,
        value: () => valid,
      }),
      {
        get: () => {
          toJsonGets += 1
          throw new Error('must not execute')
        },
      },
    )
    expect(decodeLocateClearTweetResponse(toJson, ['bookmark', 'like'])).toBeUndefined()
    expect(toJsonGets).toBe(0)
    expect(
      decodeLocateClearTweetResponse({ ...valid, extra: 'x'.repeat(MAX_CLEAR_RESPONSE_BYTES) }, [
        'bookmark',
        'like',
      ]),
    ).toBeUndefined()
  })

  it('requires exact destructive replies and the requested single scope', () => {
    const valid = {
      _tag: 'ClearTweetResponse',
      results: [{ scope: 'bookmark', state: 'cleared' }],
    }
    expect(decodeClearTweetResponse(valid, ['bookmark'])).toEqual(valid)
    for (const reply of [
      { ...valid, extra: true },
      { ...valid, results: [] },
      { ...valid, results: [{ scope: 'like', state: 'cleared' }] },
      { ...valid, results: [{ scope: 'bookmark', state: 'future' }] },
      {
        ...valid,
        results: [valid.results[0], { scope: 'like', state: 'cleared' }],
      },
    ])
      expect(decodeClearTweetResponse(reply, ['bookmark'])).toBeUndefined()

    let gets = 0
    const hostile = new Proxy(valid, {
      get: () => {
        gets += 1
        throw new Error('must not execute')
      },
    })
    expect(decodeClearTweetResponse(hostile, ['bookmark'])).toEqual(valid)
    expect(gets).toBe(0)
    let toJsonGets = 0
    const toJson = new Proxy(
      Object.defineProperty({ ...valid }, 'toJSON', {
        enumerable: true,
        value: () => valid,
      }),
      {
        get: () => {
          toJsonGets += 1
          throw new Error('must not execute')
        },
      },
    )
    expect(decodeClearTweetResponse(toJson, ['bookmark'])).toBeUndefined()
    expect(toJsonGets).toBe(0)
    expect(
      decodeClearTweetResponse({ ...valid, extra: 'x'.repeat(MAX_CLEAR_RESPONSE_BYTES) }, [
        'bookmark',
      ]),
    ).toBeUndefined()
  })

  it('caps reply arrays before it allocates or reads rows', () => {
    const huge: unknown[] = []
    huge.length = 0xffff_ffff
    expect(
      decodeLocateClearTweetResponse(
        { _tag: 'LocateClearTweetResponse', mounted: true, results: huge },
        ['bookmark'],
      ),
    ).toBeUndefined()

    let descriptors = 0
    let gets = 0
    const proxiedHuge = new Proxy(huge, {
      get: () => {
        gets += 1
        throw new Error('must not execute')
      },
      getOwnPropertyDescriptor: (target, key) => {
        descriptors += 1
        return Reflect.getOwnPropertyDescriptor(target, key)
      },
    })
    expect(
      decodeClearTweetResponse({ _tag: 'ClearTweetResponse', results: proxiedHuge }, ['bookmark']),
    ).toBeUndefined()
    expect(descriptors).toBe(1)
    expect(gets).toBe(0)
  })

  it('accepts only exact, safe, bounded Clear Log records', () => {
    const first = {
      tweetId: '2',
      scope: 'bookmark',
      at: 2,
      mechanism: 'dom-click',
      permalink: 'https://x.com/i/status/2',
    }
    const second = {
      tweetId: '1',
      scope: 'like',
      at: 1,
      mechanism: 'dom-click',
      permalink: 'https://x.com/i/status/1',
    }
    expect(decodeClearLogResponse({ _tag: 'ClearLogSuccess', records: [first, second] })).toEqual({
      _tag: 'ClearLogSuccess',
      records: [first, second],
    })
    expect(decodeClearLogRequest({ _tag: 'ClearLogRequest' })).toEqual({ _tag: 'ClearLogRequest' })
    let requestGets = 0
    expect(
      decodeClearLogRequest(
        new Proxy(
          { _tag: 'ClearLogRequest' },
          {
            get: () => {
              requestGets += 1
              throw new Error('must not execute')
            },
          },
        ),
      ),
    ).toEqual({ _tag: 'ClearLogRequest' })
    expect(requestGets).toBe(0)
    for (const reply of [
      { _tag: 'ClearLogSuccess', records: [second, first] },
      { _tag: 'ClearLogSuccess', records: [{ ...first, at: -1 }] },
      { _tag: 'ClearLogSuccess', records: [{ ...first, at: 1.5 }] },
      { _tag: 'ClearLogSuccess', records: [{ ...first, at: Number.MAX_SAFE_INTEGER + 1 }] },
      { _tag: 'ClearLogSuccess', records: [{ ...first, permalink: 'https://x.com/i/status/1' }] },
      { _tag: 'ClearLogSuccess', records: [first, { ...first }] },
      { _tag: 'ClearLogUnavailable', extra: true },
      {
        _tag: 'ClearLogSuccess',
        records: Array.from({ length: CLEAR_LOG_LIMIT + 1 }, (_, index) => ({
          ...first,
          tweetId: String(CLEAR_LOG_LIMIT + 1 - index),
          at: CLEAR_LOG_LIMIT + 1 - index,
          permalink: `https://x.com/i/status/${CLEAR_LOG_LIMIT + 1 - index}`,
        })),
      },
    ])
      expect(decodeClearLogResponse(reply)).toBeUndefined()
    let gets = 0
    const hostile = new Proxy(
      { _tag: 'ClearLogSuccess', records: [first] },
      {
        get: () => {
          gets += 1
          throw new Error('must not execute')
        },
      },
    )
    expect(decodeClearLogResponse(hostile)).toEqual({
      _tag: 'ClearLogSuccess',
      records: [first],
    })
    expect(gets).toBe(0)
    expect(
      decodeClearLogResponse({
        _tag: 'ClearLogSuccess',
        records: [first],
        extra: 'x'.repeat(MAX_CLEAR_RESPONSE_BYTES),
      }),
    ).toBeUndefined()
    expect(Result.isFailure(Schema.decodeUnknownResult(ClearLogRecord)({ ...first, at: -1 }))).toBe(
      true,
    )
  })

  it('caps and deduplicates visibility pulses', () => {
    expect(
      Schema.decodeUnknownSync(ClearVisibilityPulse)({
        _tag: 'ClearVisibilityPulse',
        tweetIds: ['1'],
      }),
    ).toEqual({ _tag: 'ClearVisibilityPulse', tweetIds: ['1'] })
    for (const tweetIds of [
      ['1', '1'],
      Array.from({ length: CLEAR_VISIBILITY_PULSE_LIMIT + 1 }, (_, index) => String(index + 1)),
    ])
      expect(
        Result.isFailure(
          Schema.decodeUnknownResult(ClearVisibilityPulse)({
            _tag: 'ClearVisibilityPulse',
            tweetIds,
          }),
        ),
      ).toBe(true)
  })
})
