import { forEachTweetNode } from '@/core/adapters/x/walk'
import { type Source, type TweetRecord, tweetRecordFromNode } from './record'

/**
 * Consume the single shared traversal (§6.0) once and assemble a {@link TweetRecord}
 * for every tweet node the §7 breadth rule keeps: a tweet with media, every tweet
 * in an opened thread (`source === 'tweetDetail'`), or all scrolled tweets when the
 * `includeTextOnly` breadth flag is set. Media identity rides in from the walk's
 * resolution (ADR-0016) — no second walk, no re-resolved media.
 */
export function harvestTweets(
  json: unknown,
  opts: { source: Source; includeTextOnly: boolean; capturedAt: number },
): TweetRecord[] {
  const { source, includeTextOnly, capturedAt } = opts
  const out: TweetRecord[] = []
  forEachTweetNode(json, ({ node, author, mediaRaw }) => {
    if (mediaRaw.length === 0 && source !== 'tweetDetail' && !includeTextOnly) return
    const record = tweetRecordFromNode({ node, author, mediaRaw, source, capturedAt })
    /* v8 ignore next -- forEachTweetNode only visits nodes with a tweet legacy, so tweetRecordFromNode never returns null here */
    if (record) out.push(record)
  })
  return out
}
