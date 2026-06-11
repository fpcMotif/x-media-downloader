import type { MediaItem } from '../schema'

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

function basenameId(url: string): string {
  const path = url.split('?')[0] ?? url
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot >= 0 ? base.slice(0, dot) : base
}

function extFromUrl(url: string, fallback: string): string {
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
    const id = m.id_str ?? basenameId(m.media_url_https)
    if (seen.has(id)) return
    if (m.type === 'photo') {
      seen.add(id)
      out.push({
        id,
        tweetId: tweet.tweetId,
        handle: tweet.handle,
        type: 'photo',
        url: upgradePhotoUrl(m.media_url_https),
        previewUrl: m.media_url_https,
        ext: extFromUrl(m.media_url_https, 'jpg'),
        index: out.length,
      })
      return
    }
    const variant = m.video_info ? pickVideoVariant(m.video_info.variants) : null
    if (!variant) return
    seen.add(id)
    out.push({
      id,
      tweetId: tweet.tweetId,
      handle: tweet.handle,
      type: m.type === 'animated_gif' ? 'gif' : 'video',
      url: variant.url,
      previewUrl: m.media_url_https,
      ext: extFromUrl(variant.url, 'mp4'),
      index: out.length,
      ...(variant.bitrate !== undefined ? { bitrate: variant.bitrate } : {}),
    })
  })
  return out
}

/**
 * Select the highest-bitrate MP4 variant; ignore HLS/non-mp4. Returns null if
 * no MP4 variant exists. Mirrors gallery-dl's max-bitrate selection.
 */
export function pickVideoVariant(variants: ReadonlyArray<Variant>): Variant | null {
  const mp4 = variants.filter((v) => v.content_type === 'video/mp4')
  if (mp4.length === 0) return null
  return mp4.reduce((best, v) => ((v.bitrate ?? 0) > (best.bitrate ?? 0) ? v : best))
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
