import { describe, it, expect } from 'vitest'
import { upgradePhotoUrl, pickVideoVariant, resolveTweetMedia } from './index'

describe('upgradePhotoUrl', () => {
  it('upgrades name=small to name=orig', () => {
    const url = 'https://pbs.twimg.com/media/ABC?format=jpg&name=small'
    expect(upgradePhotoUrl(url)).toBe('https://pbs.twimg.com/media/ABC?format=jpg&name=orig')
  })

  it('returns an unparseable URL unchanged', () => {
    expect(upgradePhotoUrl('not a url')).toBe('not a url')
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

  it('treats missing video bitrates as zero when choosing an mp4 variant', () => {
    expect(
      pickVideoVariant([
        { content_type: 'video/mp4', url: 'unknown.mp4' },
        { content_type: 'video/mp4', bitrate: 1, url: 'tiny.mp4' },
      ])?.url,
    ).toBe('tiny.mp4')
    expect(
      pickVideoVariant([
        { content_type: 'video/mp4', bitrate: 1, url: 'known.mp4' },
        { content_type: 'video/mp4', url: 'unknown.mp4' },
      ])?.url,
    ).toBe('known.mp4')
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
              {
                content_type: 'video/mp4',
                bitrate: 256000,
                url: 'https://video.twimg.com/low.mp4',
              },
              {
                content_type: 'video/mp4',
                bitrate: 2176000,
                url: 'https://video.twimg.com/high.mp4',
              },
            ],
          },
        },
      ],
    })
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      type: 'photo',
      handle: 'alice',
      tweetId: '1790',
      index: 0,
      ext: 'jpg',
    })
    expect(items[0]!.url).toContain('name=orig')
    expect(items[1]).toMatchObject({ type: 'video', index: 1, ext: 'mp4' })
    expect(items[1]!.url).toBe('https://video.twimg.com/high.mp4')
  })

  it('de-duplicates repeated media by id', () => {
    const photo = {
      type: 'photo',
      media_url_https: 'https://pbs.twimg.com/media/SAME.jpg',
    } as const
    const items = resolveTweetMedia({ tweetId: '1', handle: 'bob', media: [photo, photo] })
    expect(items).toHaveLength(1)
  })

  it('falls back to basename identity and fallback extensions when URLs lack dotted names', () => {
    const items = resolveTweetMedia({
      tweetId: '1',
      handle: 'bob',
      media: [
        { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/NO_DOT' },
        {
          type: 'video',
          media_url_https: 'https://pbs.twimg.com/tweet_video_thumb/VIDEO',
          video_info: {
            variants: [{ content_type: 'video/mp4', url: 'https://video.twimg.com/extless' }],
          },
        },
      ],
    })
    expect(items).toEqual([
      expect.objectContaining({ id: 'NO_DOT', ext: 'jpg', type: 'photo' }),
      expect.objectContaining({ id: 'VIDEO', ext: 'mp4', type: 'video' }),
    ])
    expect(items[1]).not.toHaveProperty('bitrate')
  })
})

const mp4 = (bitrate: number, url: string) => ({ content_type: 'video/mp4', bitrate, url })
const hls = (url: string) => ({ content_type: 'application/x-mpegURL', url })
const tweet = (media: ReadonlyArray<Parameters<typeof resolveTweetMedia>[0]['media'][number]>) =>
  resolveTweetMedia({ tweetId: '1', handle: 'alice', media })

describe('media combinations (1–4, mixed)', () => {
  it('1 video → single max-bitrate mp4', () => {
    const items = tweet([
      {
        type: 'video',
        media_url_https: 'https://pbs.twimg.com/x/thumb.jpg',
        video_info: { variants: [hls('p.m3u8'), mp4(256000, 'lo.mp4'), mp4(2176000, 'hi.mp4')] },
      },
    ])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ type: 'video', ext: 'mp4', index: 0, url: 'hi.mp4' })
  })

  it('1 GIF → mp4 variant (bitrate 0 still chosen), type gif', () => {
    const items = tweet([
      {
        type: 'animated_gif',
        media_url_https: 'https://pbs.twimg.com/tweet_video_thumb/g.jpg',
        video_info: { variants: [mp4(0, 'https://video.twimg.com/g.mp4')] },
      },
    ])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      type: 'gif',
      ext: 'mp4',
      url: 'https://video.twimg.com/g.mp4',
    })
  })

  it('4 photos preserve per-url extension and contiguous indices', () => {
    const items = tweet([
      { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/A.jpg' },
      { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/B.png' },
      { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/C.jpg' },
      { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/D.jpg' },
    ])
    expect(items.map((i) => i.index)).toEqual([0, 1, 2, 3])
    expect(items[1]!.ext).toBe('png')
    expect(items.every((i) => i.url.includes('name=orig'))).toBe(true)
  })

  it('2–4 videos each select their OWN max-bitrate variant', () => {
    const items = tweet([
      {
        type: 'video',
        media_url_https: 't1.jpg',
        video_info: { variants: [mp4(500000, 'v1-lo.mp4'), mp4(2176000, 'v1-hi.mp4')] },
      },
      {
        type: 'video',
        media_url_https: 't2.jpg',
        video_info: { variants: [mp4(950000, 'v2-hi.mp4'), mp4(300000, 'v2-lo.mp4')] },
      },
    ])
    expect(items.map((i) => i.url)).toEqual(['v1-hi.mp4', 'v2-hi.mp4'])
    expect(items.map((i) => i.index)).toEqual([0, 1])
  })

  it('mixed photo+video+photo+gif → flat global indices 0..3 in order', () => {
    const items = tweet([
      { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/P1.jpg' },
      {
        type: 'video',
        media_url_https: 'tv.jpg',
        video_info: { variants: [mp4(2176000, 'vid.mp4')] },
      },
      { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/P2.png' },
      {
        type: 'animated_gif',
        media_url_https: 'tg.jpg',
        video_info: { variants: [mp4(0, 'gif.mp4')] },
      },
    ])
    expect(items.map((i) => i.type)).toEqual(['photo', 'video', 'photo', 'gif'])
    expect(items.map((i) => i.index)).toEqual([0, 1, 2, 3])
  })

  it('drops an HLS-only video and keeps contiguous output indices', () => {
    const items = tweet([
      { type: 'video', media_url_https: 't.jpg', video_info: { variants: [hls('only.m3u8')] } },
      { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/P.jpg' },
    ])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ type: 'photo', index: 0 })
  })

  it('skips a video entry with no video_info', () => {
    const items = tweet([
      { type: 'video', media_url_https: 't.jpg' },
      { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/P.jpg' },
    ])
    expect(items).toHaveLength(1)
    expect(items[0]!.type).toBe('photo')
  })
})
