/**
 * X GraphQL bookmark/like MUTATION operations the Release-diagnostics tee may
 * observe — the H1/H5 evidence for spec #59 (a server-side reject on `DeleteBookmark`,
 * or any `CreateBookmark` fired while a Release is in flight). A SEPARATE predicate
 * from `tracked-response.ts`'s `isGraphqlMediaUrl`: mutation payloads must never
 * enter the media-detection pipeline (they carry no media, and mixing the two
 * channels is exactly the bug this file exists to avoid).
 */
import { isClearableTweetId } from '@/packages/clear/clearer'
import type { JsonValue } from '@/packages/schema'
import { isJsonObject, isJsonString } from '../json-predicates'
const MUTATION_OPS = [
  'CreateBookmark',
  'DeleteBookmark',
  'FavoriteTweet',
  'UnfavoriteTweet',
] as const
export type ReleaseMutationOp = (typeof MUTATION_OPS)[number]

/**
 * Which of the four Release mutation ops this X GraphQL URL names, or `null` if
 * none. Unlike `isGraphqlMediaUrl` (a bare `url.includes('/${op}')` substring
 * test, tolerant of near-misses because false positives there only widen media
 * detection), this matches the URL PATHNAME's LAST segment exactly — a mutation
 * event feeds a durable, exported diagnostics log, so a near-miss op name
 * (`DeleteBookmarkBatch`, a hypothetical future op) must read as "not tracked",
 * never get silently folded into `DeleteBookmark`'s evidence. `no request parsing
 * needed for matching` (spec #59): only the URL string is read here.
 */
export function matchReleaseMutationOp(url: string): ReleaseMutationOp | null {
  if (!url.includes('/i/api/graphql/')) return null
  let pathname: string
  try {
    pathname = new URL(url, 'https://x.com').pathname
  } catch {
    return null
  }
  const last = pathname.slice(pathname.lastIndexOf('/') + 1)
  return MUTATION_OPS.find((op) => op === last) ?? null
}

/**
 * Does this GraphQL mutation RESPONSE body signal an error? X returns HTTP 200
 * with a top-level `errors` array on some failures (in addition to genuine non-200
 * statuses, which the caller reports separately via the response status) — so a
 * clean HTTP status alone cannot tell the diagnostics log "the mutation actually
 * failed." Fail-safe: unparseable / non-object / missing-array bodies read as NO
 * error signal (`false`) rather than throwing — a malformed body is not itself
 * evidence of a server-side reject, and this must never crash the passive tee.
 */
export function bodyHasErrorSignal(body: string): boolean {
  try {
    const parsed: JsonValue = JSON.parse(body)
    if (!isJsonObject(parsed)) return false
    const errors = parsed['errors']
    return Array.isArray(errors) && errors.length > 0
  } catch {
    return false
  }
}

/**
 * The tweet id these mutations act on, read from the JSON REQUEST body's
 * `variables.tweet_id` — X's GraphQL client sends it there for all four tracked
 * ops; it is NOT reliably present in the response body (a successful
 * `DeleteBookmark` response carries no tweet id at all). Fail-safe: `undefined`
 * on any parse failure, unexpected shape, OR a `tweet_id` that isn't a genuine
 * numeric snowflake (`isClearableTweetId`, the same digit-only guard
 * `clearer.ts` gates DOM-locating on) — never a thrown error, and never a bare
 * `typeof === 'string'` pass-through. This value flows, unclicked and
 * unmoderated, all the way into the durable, user-exportable diagnostics log
 * (`background.ts`'s `traceBackground('clear-mutation', ...)`), and the
 * request body it's read from crosses an untrusted trust boundary (the
 * MAIN-world tee relays whatever the page's own network call carried — see
 * `inject.content.ts`'s docstring) — an unbounded string here would let a
 * forged or compromised page inject arbitrary text into a log the options
 * panel promises holds only "ids, timings — no post content."
 */
export function tweetIdFromMutationRequestBody(body: string): string | undefined {
  try {
    const parsed: JsonValue = JSON.parse(body)
    if (!isJsonObject(parsed)) return undefined
    const variables = parsed['variables']
    if (!isJsonObject(variables)) return undefined
    const tweetId = variables['tweet_id']
    return isJsonString(tweetId) && isClearableTweetId(tweetId) ? tweetId : undefined
  } catch {
    return undefined
  }
}
