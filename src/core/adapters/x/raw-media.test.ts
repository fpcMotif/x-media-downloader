import { describe, expect, it } from 'vitest'
import { MAX_MEDIA_URL_LENGTH } from '../../schema/media'
import { MAX_TEE_BODY_BYTES } from '../../tee-contract'
import {
  MAX_X_MEDIA_SIZES,
  MAX_X_VIDEO_VARIANTS,
  normalizeRawMedia,
  normalizeRawMediaList,
} from './raw-media'

const mediaPrefix = 'https://pbs.twimg.com/media/'
const boundedUrl = `${mediaPrefix}${'x'.repeat(MAX_MEDIA_URL_LENGTH - mediaPrefix.length)}`
const hostileUrl = `${mediaPrefix}${'x'.repeat(MAX_TEE_BODY_BYTES - mediaPrefix.length)}`

describe('normalizeRawMedia', () => {
  it('keeps a parseable HTTPS URL at the shared media bound', () => {
    expect(normalizeRawMedia({ type: 'photo', media_url_https: boundedUrl })).toEqual({
      type: 'photo',
      media_url_https: boundedUrl,
    })
  })

  it('drops near-8MiB, malformed, and non-HTTPS URLs before resolution', () => {
    expect(
      normalizeRawMediaList([
        { type: 'photo', media_url_https: hostileUrl },
        { type: 'photo', media_url_https: 'not a URL' },
        {
          type: 'video',
          media_url_https: 'https://pbs.twimg.com/media/poster.jpg',
          video_info: {
            variants: [{ content_type: 'video/mp4', url: hostileUrl }],
          },
        },
        { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/kept.jpg' },
      ]),
    ).toEqual([{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/kept.jpg' }])
    expect(
      normalizeRawMedia({ type: 'photo', media_url_https: 'http://pbs.twimg.com/media/plain.jpg' }),
    ).toBeUndefined()
  })

  it('drops a non-post media array and omits unused id_str', () => {
    expect(
      normalizeRawMediaList(
        Array.from({ length: 5 }, (_, index) => ({
          type: 'photo',
          media_url_https: `https://pbs.twimg.com/media/${index}.jpg`,
        })),
      ),
    ).toEqual([])
    expect(
      normalizeRawMedia({
        type: 'photo',
        id_str: 'x'.repeat(MAX_TEE_BODY_BYTES),
        media_url_https: 'https://pbs.twimg.com/media/kept.jpg',
      }),
    ).toEqual({ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/kept.jpg' })
  })

  it('rejects excess nested sizes and video variants', () => {
    const sizes = Object.fromEntries(
      Array.from({ length: MAX_X_MEDIA_SIZES + 1 }, (_, index) => [
        `size-${index}`,
        { w: 1, h: 1 },
      ]),
    )
    const variants = Array.from({ length: MAX_X_VIDEO_VARIANTS + 1 }, (_, index) => ({
      content_type: 'video/mp4',
      url: `https://video.twimg.com/${index}.mp4`,
      bitrate: index,
    }))

    expect(
      normalizeRawMedia({
        type: 'photo',
        media_url_https: 'https://pbs.twimg.com/media/oversized-sizes.jpg',
        sizes,
      }),
    ).toBeUndefined()
    expect(
      normalizeRawMedia({
        type: 'video',
        media_url_https: 'https://pbs.twimg.com/media/oversized-variants.jpg',
        video_info: { variants },
      }),
    ).toBeUndefined()
  })

  it('retains only the highest-bitrate valid MP4 while scanning a bounded variant list', () => {
    expect(
      normalizeRawMedia({
        type: 'video',
        media_url_https: 'https://pbs.twimg.com/media/poster.jpg',
        video_info: {
          variants: [
            { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/skip.m3u8' },
            { content_type: 'video/mp4', url: 'https://video.twimg.com/low.mp4', bitrate: 1 },
            { content_type: 'video/mp4', url: 'https://video.twimg.com/high.mp4', bitrate: 2 },
          ],
        },
      }),
    ).toEqual({
      type: 'video',
      media_url_https: 'https://pbs.twimg.com/media/poster.jpg',
      video_info: {
        variants: [
          { content_type: 'video/mp4', url: 'https://video.twimg.com/high.mp4', bitrate: 2 },
        ],
      },
    })
  })
})
