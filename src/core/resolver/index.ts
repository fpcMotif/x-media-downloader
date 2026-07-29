import { Option } from 'effect'
import {
  isHttpsMediaUrl,
  MAX_MEDIA_AUTHOR_LENGTH,
  MAX_MEDIA_EXTENSION_LENGTH,
  MAX_MEDIA_POST_ID_LENGTH,
  MAX_MEDIA_URL_LENGTH,
  type MediaItem,
} from '../schema/media'
import { MAX_MEDIA_ID_LENGTH, MAX_X_MEDIA_PER_SWEEP_POST } from '../wire/limits'

export interface Variant {
  readonly content_type: string
  readonly url: string
  readonly bitrate?: number
}

export interface RawMedia {
  readonly type: 'photo' | 'video' | 'animated_gif'
  readonly media_url_https: string
  readonly id_str?: string
  readonly video_info?: { readonly variants: ReadonlyArray<Variant> }
}

export interface RawTweet {
  readonly tweetId: string
  readonly handle: string
  readonly media: ReadonlyArray<RawMedia>
}

// RawTweet keeps X's own field names (it's X-adapter-internal plumbing, never
// part of the generalized MediaItem contract) — only the MediaItem literals
// built below use the generalized `postId`/`author`/`platform`.

/* v8 ignore next -- String.split always yields a non-empty array; `?? url` is unreachable */
const stripQuery = (url: string): string => url.split('?')[0] ?? url

function basenameId(url: string): string {
  const path = stripQuery(url)
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot >= 0 ? base.slice(0, dot) : base
}

function extFromUrl(url: string, fallback: string): string {
  const path = stripQuery(url)
  const dot = path.lastIndexOf('.')
  return dot >= 0 ? path.slice(dot + 1) : fallback
}

/**
 * `resolveTweetMedia` feeds DetectionStore directly after X's raw-media
 * boundary. Bound fields derived from otherwise-valid URLs before that handoff.
 * URL syntax itself belongs to raw-media so direct resolver callers retain their
 * established relative-URL behavior.
 */
const isOutputMediaItem = (item: MediaItem): boolean =>
  item.id.length > 0 &&
  item.id.length <= MAX_MEDIA_ID_LENGTH &&
  item.postId.length > 0 &&
  item.postId.length <= MAX_MEDIA_POST_ID_LENGTH &&
  item.author.length <= MAX_MEDIA_AUTHOR_LENGTH &&
  item.url.length > 0 &&
  item.url.length <= MAX_MEDIA_URL_LENGTH &&
  (item.previewUrl === undefined ||
    (item.previewUrl.length > 0 && item.previewUrl.length <= MAX_MEDIA_URL_LENGTH)) &&
  item.ext.length > 0 &&
  item.ext.length <= MAX_MEDIA_EXTENSION_LENGTH

/**
 * Turn a tweet's media entries into original-quality MediaItems, de-duplicated
 * by media id. Photos are upgraded to `name=orig`; videos/GIFs use the
 * highest-bitrate MP4 variant. Entries with no usable variant are skipped.
 */
export function resolveTweetMedia(tweet: RawTweet): MediaItem[] {
  const out: MediaItem[] = []
  const seen = new Set<string>()
  const append = (candidate: MediaItem): void => {
    // Adapter output bypasses wire decoding on its way to DetectionStore. Keep
    // this one runtime gate for URL-derived id/ext and tweet metadata, so types
    // cannot mask hostile external values.
    if (!isOutputMediaItem(candidate) || seen.has(candidate.id)) return
    seen.add(candidate.id)
    out.push(candidate)
  }

  for (const m of tweet.media) {
    if (out.length >= MAX_X_MEDIA_PER_SWEEP_POST) break
    if (m.type === 'photo') {
      const upgraded = upgradePhotoUrl(m.media_url_https)
      // Preserve a valid source URL if adding `name=orig` would cross the
      // shared output bound.
      const url = isHttpsMediaUrl(upgraded) ? upgraded : m.media_url_https
      // Identity is the media key (the resolved-url basename) — the SAME value the
      // tee, the DOM resolver, and syndication each derive for this media, so one
      // media is one item no matter which path saw it (ADR-0016).
      const id = basenameId(url)
      append({
        id,
        platform: 'x',
        postId: tweet.tweetId,
        author: tweet.handle,
        type: 'photo',
        url,
        previewUrl: m.media_url_https,
        ext: extFromUrl(m.media_url_https, 'jpg'),
        index: out.length,
      })
      continue
    }
    const variant = m.video_info ? pickVideoVariant(m.video_info.variants) : Option.none()
    if (Option.isNone(variant)) continue
    const id = basenameId(variant.value.url)
    append({
      id,
      platform: 'x',
      postId: tweet.tweetId,
      author: tweet.handle,
      type: m.type === 'animated_gif' ? 'gif' : 'video',
      url: variant.value.url,
      previewUrl: m.media_url_https,
      ext: extFromUrl(variant.value.url, 'mp4'),
      index: out.length,
      ...(variant.value.bitrate !== undefined ? { bitrate: variant.value.bitrate } : {}),
    })
  }
  return out
}

/**
 * Select the highest-bitrate MP4 variant; ignore HLS/non-mp4. None if no MP4
 * variant exists. Mirrors gallery-dl's max-bitrate selection.
 */
export function pickVideoVariant(variants: ReadonlyArray<Variant>): Option.Option<Variant> {
  const mp4 = variants.filter((v) => v.content_type === 'video/mp4')
  if (mp4.length === 0) return Option.none()
  return Option.some(mp4.reduce((best, v) => ((v.bitrate ?? 0) > (best.bitrate ?? 0) ? v : best)))
}

/**
 * Upgrade a pbs.twimg.com photo URL to original quality by forcing `name=orig`.
 * Mirrors gallery-dl's size preference (orig is the largest rendition).
 */
export function upgradePhotoUrl(url: string): string {
  try {
    const u = new URL(url)
    u.searchParams.set('name', 'orig')
    // A `format=webp` rendition is a lossy transcode — X serves original bytes
    // only as jpg/png, so request the jpg original instead.
    if (u.searchParams.get('format') === 'webp') u.searchParams.set('format', 'jpg')
    return u.toString()
  } catch {
    return url
  }
}
