import type { MediaItem } from '@/packages/schema'
import { parseSyndicationTweet } from './syndication'

/**
 * Decide what one syndication Recovery reply means for the retry claim.
 *
 * Recovery claims a tweet id with `markAttempted` BEFORE the request goes out,
 * so exactly one attempt is ever in flight. The claim is only released by
 * `unmarkAttempted`. That makes "why did this reply produce nothing" a decision
 * the caller has to make, not a detail it can shrug off: an empty reply and a
 * corrupt one look identical at the call site, but one is permanent and the
 * other is worth another pass.
 *
 * Three outcomes, split by what the caller must do with the claim:
 * - `recovered` — fold the items in, keep the claim.
 * - `retryable` — release the claim; the answer told us nothing about the tweet.
 * - `exhausted` — keep the claim; the endpoint answered, and the answer is that
 *   there is no media. Re-asking would loop forever.
 *
 * Deliberately NOT called "terminal": CONTEXT.md binds Terminal to a Download
 * Handle's final state, owned by `packages/download/terminal-outcome.ts`. This
 * is about a Recovery attempt, a different lifecycle.
 */
export type RecoveryClassification =
  | { readonly kind: 'recovered'; readonly items: MediaItem[] }
  | { readonly kind: 'retryable'; readonly reason: RetryableReason }
  | { readonly kind: 'exhausted'; readonly reason: 'no-media' }

export type RetryableReason = 'no-body' | 'unparseable' | 'wrong-tweet' | 'bad-shape'

/** A tweet payload is a plain object — an array is drift, not a tweet. */
const isTweetObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function classifyRecoveryReply(
  requestedId: string,
  body: string | undefined,
): RecoveryClassification {
  if (body === undefined) return { kind: 'retryable', reason: 'no-body' }

  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return { kind: 'retryable', reason: 'unparseable' }
  }
  if (!isTweetObject(json)) return { kind: 'retryable', reason: 'unparseable' }

  // `parseSyndicationTweet` trusts whatever `id_str` the payload carries and
  // never checks it against what we asked for, so a reply for a DIFFERENT tweet
  // resolves cleanly into that other tweet's media. Recovery is the one path
  // that re-requests by id, so it is the one place this can be caught — and a
  // mismatch says nothing about the tweet we wanted, so it retries.
  if (json['id_str'] !== requestedId) return { kind: 'retryable', reason: 'wrong-tweet' }

  // Present-but-not-an-array is response-shape drift, not an answer.
  // Absent/empty IS an answer: this tweet has no media.
  const media = json['mediaDetails']
  if (media !== undefined && !Array.isArray(media))
    return { kind: 'retryable', reason: 'bad-shape' }

  // `parseSyndicationTweet` is NOT total: a `mediaDetails` entry missing
  // `media_url_https` reaches `mediaBasenameKey` as undefined and throws. The
  // old call site hid that inside the same `catch` it used for bad JSON, which
  // is how a throw here silently burned the tweet's one attempt.
  let items: MediaItem[]
  try {
    items = parseSyndicationTweet(json)
  } catch {
    return { kind: 'retryable', reason: 'bad-shape' }
  }

  return items.length === 0
    ? { kind: 'exhausted', reason: 'no-media' }
    : { kind: 'recovered', items }
}
