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
  'Likes',
  'Bookmarks',
] as const

/** True for an X GraphQL request whose response may contain tweet media. */
export function isGraphqlMediaUrl(url: string): boolean {
  if (!url.includes('/i/api/graphql/')) return false
  return MEDIA_OPS.some((op) => url.includes(`/${op}`))
}
