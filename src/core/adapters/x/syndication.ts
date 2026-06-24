import { resolveTweetMedia, type RawMedia } from '../../resolver'
import type { MediaItem } from '../../schema'

/**
 * X's public embed endpoint (`cdn.syndication.twimg.com/tweet-result`) recovers a
 * tweet's media — crucially the MP4 variants — with no auth. It is the fallback
 * when the passive GraphQL tee never saw a tweet (an SPA cache hit, a lazy-loaded
 * reply): the DOM exposes a `<video>` player but never the MP4 url, so the video
 * would otherwise go uncounted and un-downloadable. Unlike the tee (which is
 * strictly passive, ADR-0001), this issues a request — narrow, read-only, and
 * X-owned, fired only for a video we provably failed to capture.
 */

/** A tweet id is X's numeric snowflake — guard before building a URL so the
 *  background fetch can never be steered to an attacker-shaped path. */
export function isTweetId(id: string): boolean {
  return /^[0-9]{1,20}$/.test(id)
}

/**
 * The embed token X's own widgets derive from the tweet id (react-tweet's
 * formula). The endpoint is lenient about it today, but every embed client sends
 * the canonical token, so doing the same keeps the fallback robust if X tightens.
 * The `Number(id)` precision loss on a 19-digit id is intentional parity with the
 * upstream widget — the token only has to be well-formed, not exact.
 */
export function syndicationToken(tweetId: string): string {
  return ((Number(tweetId) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '')
}

/** The syndication `tweet-result` URL for `tweetId`, or null if it isn't a tweet id. */
export function syndicationUrl(tweetId: string): string | null {
  if (!isTweetId(tweetId)) return null
  const u = new URL('https://cdn.syndication.twimg.com/tweet-result')
  u.searchParams.set('id', tweetId)
  u.searchParams.set('token', syndicationToken(tweetId))
  // `lang` mirrors X's own widget call and keeps the response shape stable.
  u.searchParams.set('lang', 'en')
  return u.toString()
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null

/**
 * Map a syndication `tweet-result` payload to MediaItems. Where the GraphQL tee
 * reads `legacy.extended_entities.media`, syndication exposes media as a flat
 * top-level `mediaDetails[]` whose entries already carry `type` / `media_url_https`
 * / `video_info` — the exact {@link RawMedia} shape {@link resolveTweetMedia}
 * consumes — so this only locates the array plus the author handle and reuses the
 * resolver (highest-bitrate MP4, `name=orig` photos). Returns `[]` for any
 * non-tweet, id-less, or media-less payload.
 */
export function parseSyndicationTweet(json: unknown): MediaItem[] {
  if (!isObj(json)) return []
  const media = json['mediaDetails']
  if (!Array.isArray(media) || media.length === 0) return []
  const tweetId = String(json['id_str'] ?? '')
  if (tweetId === '') return []
  const user = isObj(json['user']) ? json['user'] : undefined
  const handle = typeof user?.['screen_name'] === 'string' ? user['screen_name'] : ''
  return resolveTweetMedia({ tweetId, handle, media: media as ReadonlyArray<RawMedia> })
}
