import { describe, it, expect } from 'vitest'
import type { MediaItem } from '../../schema'
import {
  mediaKeyFromUrl,
  groupByTweet,
  isGrabbablePhotoUrl,
  isGrabbableMediaPreviewUrl,
  extFromImgUrl,
  videoPosterUrl,
} from './dom'

/** Build a detached subtree and return its first `<video>`. */
const videoEl = (html: string): HTMLVideoElement => {
  const root = document.createElement('div')
  root.innerHTML = html.trim()
  return root.querySelector('video')!
}

const media = (id: string, tweetId: string, index: number, url: string): MediaItem => ({
  id,
  platform: 'x',
  postId: tweetId,
  author: 'alice',
  type: 'photo',
  url,
  ext: 'jpg',
  index,
})

describe('mediaKeyFromUrl', () => {
  it('returns the twimg basename key (extraction delegated to media-key)', () => {
    expect(mediaKeyFromUrl('https://pbs.twimg.com/media/AAA.jpg?name=orig')).toBe('AAA')
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

  it('returns false for an unparseable url', () => {
    expect(isGrabbableMediaPreviewUrl('not a url')).toBe(false)
  })
})

describe('videoPosterUrl', () => {
  it("returns the video's own .poster property when it is a grabbable twimg preview", () => {
    const video = document.createElement('video')
    Object.defineProperty(video, 'poster', {
      value: 'https://pbs.twimg.com/ext_tw_video_thumb/77/pu/img/V1.jpg',
      configurable: true,
    })
    expect(videoPosterUrl(video)).toBe('https://pbs.twimg.com/ext_tw_video_thumb/77/pu/img/V1.jpg')
  })

  it('falls back to the hidden _video_thumb <img> in the player container', () => {
    const video = videoEl(`
      <div data-testid="videoPlayer">
        <video src="blob:x"></video>
        <img src="https://pbs.twimg.com/tweet_video_thumb/VID.jpg" />
      </div>
    `)
    expect(videoPosterUrl(video)).toBe('https://pbs.twimg.com/tweet_video_thumb/VID.jpg')
  })

  it('matches a srcset-only thumb img and reads its .src when currentSrc is empty', () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <div data-testid="videoComponent">
        <video src="blob:x"></video>
        <img srcset="https://pbs.twimg.com/amplify_video_thumb/9/img/T2.jpg 1x"
             src="https://pbs.twimg.com/amplify_video_thumb/9/img/T2.jpg" />
      </div>
    `.trim()
    const video = root.querySelector('video')!
    const img = root.querySelector('img')!
    // currentSrc would short-circuit the `||`; force it empty so the `.src` arm runs.
    Object.defineProperty(img, 'currentSrc', { value: '', configurable: true })
    expect(videoPosterUrl(video)).toBe('https://pbs.twimg.com/amplify_video_thumb/9/img/T2.jpg')
  })

  it('reads a poster set via getAttribute when the property is empty', () => {
    const video = document.createElement('video')
    video.setAttribute('poster', 'https://pbs.twimg.com/ext_tw_video_thumb/5/pu/img/G1.jpg')
    expect(videoPosterUrl(video)).toBe('https://pbs.twimg.com/ext_tw_video_thumb/5/pu/img/G1.jpg')
  })

  it('falls back to the parent element when there is no player container', () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <div>
        <video src="blob:x"></video>
        <img src="https://pbs.twimg.com/tweet_video_thumb/Parent.jpg" />
      </div>
    `.trim()
    const video = root.querySelector('video')!
    expect(videoPosterUrl(video)).toBe('https://pbs.twimg.com/tweet_video_thumb/Parent.jpg')
  })

  it('returns null when neither the poster nor a sibling thumb is grabbable', () => {
    const video = videoEl(
      '<video poster="https://pbs.twimg.com/profile_images/avatar.jpg"></video>',
    )
    expect(videoPosterUrl(video)).toBeNull()
  })

  it('returns null when the thumb img src is not a grabbable preview url', () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <div data-testid="videoPlayer">
        <video src="blob:x"></video>
        <img src="https://example.com/_video_thumb/X.jpg" />
      </div>
    `.trim()
    const video = root.querySelector('video')!
    expect(videoPosterUrl(video)).toBeNull()
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
