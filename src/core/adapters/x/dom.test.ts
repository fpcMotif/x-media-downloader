import { describe, it, expect } from 'vitest'
import type { MediaItem } from '../../schema'
import {
  mediaKeyFromUrl,
  groupByTweet,
  isGrabbablePhotoUrl,
  isGrabbableMediaPreviewUrl,
  extFromImgUrl,
} from './dom'

const media = (id: string, tweetId: string, index: number, url: string): MediaItem => ({
  id,
  tweetId,
  handle: 'alice',
  type: 'photo',
  url,
  ext: 'jpg',
  index,
})

describe('mediaKeyFromUrl', () => {
  it('extracts the basename key from a pbs photo url (ignoring query + size)', () => {
    expect(mediaKeyFromUrl('https://pbs.twimg.com/media/AAA?format=jpg&name=small')).toBe('AAA')
    expect(mediaKeyFromUrl('https://pbs.twimg.com/media/AAA.jpg?name=orig')).toBe('AAA')
  })

  it('matches a DOM src against a resolved MediaItem url by key', () => {
    const domSrc = 'https://pbs.twimg.com/media/Z9?format=jpg&name=900x900'
    const resolved = 'https://pbs.twimg.com/media/Z9.jpg?name=orig'
    expect(mediaKeyFromUrl(domSrc)).toBe(mediaKeyFromUrl(resolved))
  })

  it('returns null for non-twimg or unparseable urls', () => {
    expect(mediaKeyFromUrl('https://example.com/media/AAA.jpg')).toBe(null)
    expect(mediaKeyFromUrl('not a url')).toBe(null)
    expect(mediaKeyFromUrl('https://pbs.twimg.com/')).toBe(null)
    expect(mediaKeyFromUrl('https://evil-twimg.com/media/AAA.jpg')).toBe(null)
  })
})

describe('isGrabbablePhotoUrl', () => {
  it('accepts a pbs.twimg.com /media photo url', () => {
    expect(isGrabbablePhotoUrl('https://pbs.twimg.com/media/AAA?format=jpg&name=small')).toBe(true)
    expect(isGrabbablePhotoUrl('https://pbs.twimg.com/media/AAA.jpg?name=orig')).toBe(true)
    expect(isGrabbablePhotoUrl('https://pbs.twimg.com/media/AAA?format=png&name=900x900')).toBe(
      true,
    )
    expect(isGrabbablePhotoUrl('https://pbs.twimg.com/media/AAA.webp?name=small')).toBe(true)
  })

  it('rejects avatars, card thumbs, emoji, and video poster frames', () => {
    expect(isGrabbablePhotoUrl('https://pbs.twimg.com/profile_images/zzz.jpg')).toBe(false)
    expect(isGrabbablePhotoUrl('https://pbs.twimg.com/card_img/123/abc?format=png')).toBe(false)
    expect(isGrabbablePhotoUrl('https://abs-0.twimg.com/emoji/v2/svg/1f600.svg')).toBe(false)
    expect(isGrabbablePhotoUrl('https://pbs.twimg.com/tweet_video_thumb/ABC.jpg')).toBe(false)
    expect(isGrabbablePhotoUrl('https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/x.jpg')).toBe(
      false,
    )
  })

  it('rejects non-twimg hosts and unparseable urls', () => {
    expect(isGrabbablePhotoUrl('https://example.com/media/AAA.jpg')).toBe(false)
    expect(isGrabbablePhotoUrl('not a url')).toBe(false)
  })

  it('rejects spoofed suffix hosts and the video CDN', () => {
    expect(isGrabbablePhotoUrl('https://evil-twimg.com/media/x.jpg?format=jpg')).toBe(false)
    expect(isGrabbablePhotoUrl('https://video.twimg.com/media/x.mp4')).toBe(false)
  })
})

describe('isGrabbableMediaPreviewUrl', () => {
  it('accepts photos plus video/GIF poster frames', () => {
    expect(isGrabbableMediaPreviewUrl('https://pbs.twimg.com/media/AAA?format=jpg')).toBe(true)
    expect(isGrabbableMediaPreviewUrl('https://pbs.twimg.com/tweet_video_thumb/VID.jpg')).toBe(true)
    expect(
      isGrabbableMediaPreviewUrl('https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/VID.jpg'),
    ).toBe(true)
    expect(
      isGrabbableMediaPreviewUrl('https://pbs.twimg.com/amplify_video_thumb/1/img/VID.jpg'),
    ).toBe(true)
  })

  it('still rejects avatars, cards, non-pbs hosts, and the mp4 CDN', () => {
    expect(isGrabbableMediaPreviewUrl('https://pbs.twimg.com/profile_images/zzz.jpg')).toBe(false)
    expect(isGrabbableMediaPreviewUrl('https://pbs.twimg.com/card_img/123/abc?format=png')).toBe(
      false,
    )
    expect(isGrabbableMediaPreviewUrl('https://video.twimg.com/media/x.mp4')).toBe(false)
    expect(isGrabbableMediaPreviewUrl('https://example.com/tweet_video_thumb/VID.jpg')).toBe(false)
  })
})

describe('extFromImgUrl', () => {
  it('reads the ?format= query param X serves renditions with', () => {
    expect(extFromImgUrl('https://pbs.twimg.com/media/AAA?format=png&name=small')).toBe('png')
    expect(extFromImgUrl('https://pbs.twimg.com/media/AAA?format=webp&name=orig')).toBe('webp')
    expect(extFromImgUrl('https://pbs.twimg.com/media/AAA?format=PNG&name=orig')).toBe('png')
  })

  it('falls back to a dotted path segment, then jpg', () => {
    expect(extFromImgUrl('https://pbs.twimg.com/media/AAA.png?name=orig')).toBe('png')
    expect(extFromImgUrl('https://pbs.twimg.com/media/AAA?name=orig')).toBe('jpg')
    expect(extFromImgUrl('not a url')).toBe('jpg')
  })
})

describe('groupByTweet', () => {
  it('groups items by tweet preserving order and de-duping by id', () => {
    const items = [
      media('a', 't1', 0, 'https://pbs.twimg.com/media/a.jpg'),
      media('b', 't1', 1, 'https://pbs.twimg.com/media/b.jpg'),
      media('a', 't1', 0, 'https://pbs.twimg.com/media/a.jpg'), // dup
      media('c', 't2', 0, 'https://pbs.twimg.com/media/c.jpg'),
    ]
    const registry = groupByTweet(items)
    expect(registry.map((g) => g.tweetId)).toEqual(['t1', 't2'])
    expect(registry[0]!.items.map((i) => i.id)).toEqual(['a', 'b'])
    expect(registry[1]!.items.map((i) => i.id)).toEqual(['c'])
  })

  it('returns an empty registry for no items', () => {
    expect(groupByTweet([])).toEqual([])
  })
})
