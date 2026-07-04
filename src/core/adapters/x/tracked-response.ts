/**
 * Media-bearing X GraphQL operations the passive tee should capture. Scoped to
 * tweet/thread + the timelines that carry tweet media (ADR-0001).
 */
const MEDIA_OPS = [
  'TweetDetail',
  'TweetResultByRestId',
  'TweetResultsByRestIds',
  'UserTweets',
  'UserMedia',
  'HomeTimeline',
  'HomeLatestTimeline',
  'SearchTimeline',
  'ListLatestTweetsTimeline',
  'ListTweetsTimeline',
  'Likes',
  'Bookmarks',
] as const

/**
 * True for an X GraphQL request whose response may contain tweet media. The
 * `PlatformAdapter.isTrackedResponseUrl` implementation for X — the second
 * (`requestHeaders`) parameter is accepted for interface conformance but
 * unused: X's filter is URL-string-only, unlike Instagram/Threads (which lean
 * on request headers like `x-fb-friendly-name`; see the multi-platform design
 * spec, docs/superpowers/specs/2026-07-04-multi-platform-adapter-design.md).
 */
export function isGraphqlMediaUrl(
  url: string,
  requestHeaders?: Readonly<Record<string, string>>,
): boolean {
  void requestHeaders
  if (!url.includes('/i/api/graphql/')) return false
  return MEDIA_OPS.some((op) => url.includes(`/${op}`))
}
