import { Result, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { TweetSnowflake, isTweetSnowflake } from './tweet'

describe('TweetSnowflake', () => {
  it.each([
    ['2069527192787472572', true],
    ['1', true],
    ['jO4OvymczbTx7WL4', false],
    ['HLkY8gTWsAASx-7', false],
    ['', false],
    ['123abc', false],
    ['12 34', false],
    ['123456789012345678901', false],
    [123, false],
    [undefined, false],
  ] as const)('keeps schema and predicate aligned for %s', (value, expected) => {
    expect(isTweetSnowflake(value)).toBe(expected)
    expect(Result.isSuccess(Schema.decodeUnknownResult(TweetSnowflake)(value))).toBe(expected)
  })
})
