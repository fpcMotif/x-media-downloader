import { describe, it, expect } from 'vitest'
import { upgradePhotoUrl, pickVideoVariant, resolveTweetMedia } from './index'

describe('upgradePhotoUrl', () => {
  it('upgrades name=small to name=orig', () => {
    const url = 'https://pbs.twimg.com/media/ABC?format=jpg&name=small'
    expect(upgradePhotoUrl(url)).toBe('https://pbs.twimg.com/media/ABC?format=jpg&name=orig')
  })
})

describe('pickVideoVariant', () => {
  it('selects the highest-bitrate mp4 and ignores non-mp4 variants', () => {
    const variants = [
      { content_type: 'application/x-mpegURL', url: 'playlist.m3u8' },
      { content_type: 'video/mp4', bitrate: 256000, url: 'low.mp4' },
      { content_type: 'video/mp4', bitrate: 2176000, url: 'high.mp4' },
      { content_type: 'video/mp4', bitrate: 832000, url: 'mid.mp4' },
    ]
    expect(pickVideoVariant(variants)?.url).toBe('high.mp4')
  })

  it('returns null when there is no mp4 variant', () => {
    expect(pickVideoVariant([{ content_type: 'application/x-mpegURL', url: 'p.m3u8' }])).toBeNull()
  })
})

describe('resolveTweetMedia', () => {
  it('produces original-quality photos and the best mp4 for video, with index + handle', () => {
    const items = resolveTweetMedia({
      tweetId: '1790',
      handle: 'alice',
      media: [
        { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/AAA.jpg' },
        {
          type: 'video',
          media_url_https: 'https://pbs.twimg.com/tweet_video_thumb/BBB.jpg',
          video_info: {
            variants: [
              { content_type: 'application/x-mpegURL', url: 'p.m3u8' },
              { content_type: 'video/mp4', bitrate: 256000, url: 'https://video.twimg.com/low.mp4' },
              { content_type: 'video/mp4', bitrate: 2176000, url: 'https://video.twimg.com/high.mp4' },
            ],
          },
        },
      ],
    })
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ type: 'photo', handle: 'alice', tweetId: '1790', index: 0, ext: 'jpg' })
    expect(items[0]!.url).toContain('name=orig')
    expect(items[1]).toMatchObject({ type: 'video', index: 1, ext: 'mp4' })
    expect(items[1]!.url).toBe('https://video.twimg.com/high.mp4')
  })

  it('de-duplicates repeated media by id', () => {
    const photo = { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/SAME.jpg' } as const
    const items = resolveTweetMedia({ tweetId: '1', handle: 'bob', media: [photo, photo] })
    expect(items).toHaveLength(1)
  })
})
