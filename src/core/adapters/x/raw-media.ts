import type { RawMedia, Variant } from '../../resolver'
import { isHttpsMediaUrl } from '../../schema/media'
import { MAX_X_MEDIA_PER_SWEEP_POST } from '../../wire/limits'

type Obj = Record<string, unknown>

/** X currently reports at most five named sizes; 16 leaves protocol headroom. */
export const MAX_X_MEDIA_SIZES = 16

/** X normally sends a handful of encodings; 32 bounds hostile nested arrays. */
export const MAX_X_VIDEO_VARIANTS = 32

const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null

const isNonBlankString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== ''

const isSize = (value: unknown): boolean =>
  isObj(value) &&
  Number.isSafeInteger(value['w']) &&
  (value['w'] as number) > 0 &&
  Number.isSafeInteger(value['h']) &&
  (value['h'] as number) > 0

/** X includes dimensions only as metadata today. Validate them when present so
 * malformed media cannot cross this boundary, but omit them from the resolver's
 * deliberately small raw contract. */
const hasValidSizes = (value: unknown): boolean => {
  if (value === undefined) return true
  if (!isObj(value) || Array.isArray(value)) return false
  let count = 0
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue
    if (++count > MAX_X_MEDIA_SIZES || !isSize(value[key])) return false
  }
  return count > 0
}

const normalizeVariant = (value: unknown): Variant | undefined => {
  if (!isObj(value) || !isNonBlankString(value['content_type']) || !isHttpsMediaUrl(value['url'])) {
    return undefined
  }
  const bitrate = value['bitrate']
  if (
    bitrate !== undefined &&
    (typeof bitrate !== 'number' || !Number.isSafeInteger(bitrate) || bitrate < 0)
  ) {
    return undefined
  }
  return {
    content_type: value['content_type'],
    url: value['url'],
    ...(bitrate === undefined ? {} : { bitrate }),
  }
}

const normalizeVideoInfo = (
  value: unknown,
): { readonly variants: ReadonlyArray<Variant> } | undefined => {
  if (!isObj(value) || !Array.isArray(value['variants'])) return undefined
  const rawVariants = value['variants']
  if (rawVariants.length > MAX_X_VIDEO_VARIANTS) return undefined
  // The resolver needs only the best MP4. Retain one bounded candidate, never
  // an unbounded collection of unused HLS/alternate URLs.
  let best: Variant | undefined
  for (const entry of rawVariants) {
    if (!isObj(entry) || entry['content_type'] !== 'video/mp4') continue
    const normalized = normalizeVariant(entry)
    if (
      normalized !== undefined &&
      (best === undefined || (normalized.bitrate ?? 0) > (best.bitrate ?? 0))
    ) {
      best = normalized
    }
  }
  return best === undefined ? undefined : { variants: [best] }
}

/**
 * The one trust boundary for X's external media payloads. Every accepted value
 * satisfies the resolver's assumptions; one bad node is discarded without
 * poisoning valid siblings in the same response.
 */
export function normalizeRawMedia(value: unknown): RawMedia | undefined {
  if (
    !isObj(value) ||
    !isHttpsMediaUrl(value['media_url_https']) ||
    !hasValidSizes(value['sizes'])
  ) {
    return undefined
  }
  const type = value['type']
  if (type !== 'photo' && type !== 'video' && type !== 'animated_gif') return undefined

  if (type === 'photo') {
    if (
      value['video_info'] !== undefined &&
      normalizeVideoInfo(value['video_info']) === undefined
    ) {
      return undefined
    }
    return {
      type,
      media_url_https: value['media_url_https'],
    }
  }

  const videoInfo = normalizeVideoInfo(value['video_info'])
  return videoInfo === undefined
    ? undefined
    : {
        type,
        media_url_https: value['media_url_https'],
        video_info: videoInfo,
      }
}

/**
 * Normalize one external X media array. X posts have at most four media items;
 * a larger external array is not a post payload and is discarded whole. `id_str`
 * is intentionally omitted: X media identity is the resolved URL basename.
 */
export function normalizeRawMediaList(value: unknown): RawMedia[] {
  return Array.isArray(value) && value.length <= MAX_X_MEDIA_PER_SWEEP_POST
    ? value.flatMap((entry) => {
        const normalized = normalizeRawMedia(entry)
        return normalized === undefined ? [] : [normalized]
      })
    : []
}
