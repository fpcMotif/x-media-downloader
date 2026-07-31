import { Option } from 'effect'
import { mediaBasenameKey } from '../schema/media-key'
import type { MediaItem } from '@/packages/schema/media'

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

function extFromUrl(url: string, fallback: string): string {
  /* v8 ignore next -- String.split always yields a non-empty array; `?? url` is unreachable */
  const path = url.split('?')[0] ?? url
  const dot = path.lastIndexOf('.')
  return dot >= 0 ? path.slice(dot + 1) : fallback
}

/**
 * Turn a tweet's media entries into original-quality MediaItems, de-duplicated
 * by media id. Photos are upgraded to `name=orig`; videos/GIFs use the
 * highest-bitrate MP4 variant. Entries with no usable variant are skipped.
 */
export function resolveTweetMedia(tweet: RawTweet): MediaItem[] {
  const out: MediaItem[] = []
  const seen = new Set<string>()
  tweet.media.forEach((m) => {
    if (m.type === 'photo') {
      const url = upgradePhotoUrl(m.media_url_https)
      // Identity is the media key (the resolved-url basename) — the SAME value the
      // tee, the DOM resolver, and syndication each derive for this media, so one
      // media is one item no matter which path saw it (ADR-0016, core/media-key.ts).
      const id = mediaBasenameKey(url)
      if (id === null) return
      if (seen.has(id)) return
      seen.add(id)
      out.push({
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
      return
    }
    const variant = m.video_info ? pickVideoVariant(m.video_info.variants) : Option.none()
    if (Option.isNone(variant)) return
    const id = mediaBasenameKey(variant.value.url)
    if (id === null) return
    if (seen.has(id)) return
    seen.add(id)
    out.push({
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
  })
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
