import { describe, it, expect } from 'vitest'
import { Option } from 'effect'
import { isTweetId, syndicationToken, syndicationUrl, parseSyndicationTweet } from './syndication'

describe('isTweetId', () => {
  it('accepts a numeric snowflake', () => {
    expect(isTweetId('2068286123399676218')).toBe(true)
    expect(isTweetId('1')).toBe(true)
  })
  it('rejects anything non-numeric or over-long', () => {
    expect(isTweetId('')).toBe(false)
    expect(isTweetId('12a')).toBe(false)
    expect(isTweetId('../evil')).toBe(false)
    expect(isTweetId('123456789012345678901')).toBe(false) // 21 digits
  })
})

describe('syndicationToken', () => {
  it('derives the canonical embed token for a known id', () => {
    // Matches react-tweet / X widget output, verified against the live endpoint.
    expect(syndicationToken('2068286123399676218')).toBe('5hpndyxr8f')
  })
  it('is a non-empty base36-ish string', () => {
    expect(syndicationToken('1')).toMatch(/^[0-9a-z]+$/)
  })
})

describe('syndicationUrl', () => {
  it('builds the tweet-result URL with id + token + lang', () => {
    const url = Option.getOrNull(syndicationUrl('2068286123399676218'))
    expect(url).not.toBeNull()
    const u = new URL(url!)
    expect(u.host).toBe('cdn.syndication.twimg.com')
    expect(u.pathname).toBe('/tweet-result')
    expect(u.searchParams.get('id')).toBe('2068286123399676218')
    expect(u.searchParams.get('token')).toBe('5hpndyxr8f')
    expect(u.searchParams.get('lang')).toBe('en')
  })
  it('returns none for a non-tweet id', () => {
    expect(Option.getOrNull(syndicationUrl('not-an-id'))).toBe(null)
  })
})

/** A trimmed real `tweet-result` payload: one video with HLS + MP4 variants. */
const videoPayload = {
  __typename: 'Tweet',
  id_str: '2068286123399676218',
  user: { screen_name: 'ooaoau' },
  mediaDetails: [
    {
      type: 'video',
      media_url_https:
        'https://pbs.twimg.com/ext_tw_video_thumb/2068286110858661888/pu/img/wG3s1P2bBrE3U0cL.jpg',
      video_info: {
        variants: [
          { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/x.m3u8?tag=12' },
          {
            bitrate: 432000,
            content_type: 'video/mp4',
            url: 'https://video.twimg.com/ext_tw_video/2068286110858661888/pu/vid/avc1/320x320/lo.mp4?tag=12',
          },
          {
            bitrate: 1280000,
            content_type: 'video/mp4',
            url: 'https://video.twimg.com/ext_tw_video/2068286110858661888/pu/vid/avc1/720x720/hi.mp4?tag=12',
          },
        ],
      },
    },
  ],
}

describe('parseSyndicationTweet', () => {
  it('recovers a video as the highest-bitrate MP4, keyed to its poster preview', () => {
    const items = parseSyndicationTweet(videoPayload)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      tweetId: '2068286123399676218',
      handle: 'ooaoau',
      type: 'video',
      url: 'https://video.twimg.com/ext_tw_video/2068286110858661888/pu/vid/avc1/720x720/hi.mp4?tag=12',
      previewUrl:
        'https://pbs.twimg.com/ext_tw_video_thumb/2068286110858661888/pu/img/wG3s1P2bBrE3U0cL.jpg',
      ext: 'mp4',
      bitrate: 1280000,
    })
  })

  it('resolves photos in mediaDetails to original-quality items', () => {
    const items = parseSyndicationTweet({
      id_str: '500',
      user: { screen_name: 'bob' },
      mediaDetails: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/PIC.jpg' }],
    })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      tweetId: '500',
      handle: 'bob',
      type: 'photo',
      url: 'https://pbs.twimg.com/media/PIC.jpg?name=orig',
    })
  })

  it('falls back to an empty handle when the user node is missing', () => {
    const items = parseSyndicationTweet({
      id_str: '7',
      mediaDetails: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/Z.jpg' }],
    })
    expect(items[0]?.handle).toBe('')
  })

  it('returns [] for a non-object, id-less, or media-less payload', () => {
    expect(parseSyndicationTweet(null)).toEqual([])
    expect(parseSyndicationTweet('nope')).toEqual([])
    expect(
      parseSyndicationTweet({ mediaDetails: [{ type: 'photo', media_url_https: 'x' }] }),
    ).toEqual([])
    expect(parseSyndicationTweet({ id_str: '1', mediaDetails: [] })).toEqual([])
    expect(parseSyndicationTweet({ id_str: '1' })).toEqual([])
  })
})
