import { Schema } from 'effect'

/** X ids stay strings: JS numbers lose precision for 20-digit snowflakes. */
const TWEET_SNOWFLAKE_PATTERN = /^\d{1,20}$/u

/** Exact X Post identity predicate shared by wire decode and local admission. */
export const isTweetSnowflake = (value: unknown): value is string =>
  typeof value === 'string' && TWEET_SNOWFLAKE_PATTERN.test(value)

export const TweetSnowflake = Schema.String.check(Schema.isPattern(TWEET_SNOWFLAKE_PATTERN))
export type TweetSnowflake = typeof TweetSnowflake.Type
