import { describe, it, expect, afterEach } from 'vitest'
import type { PlatformAdapter } from './types'
import {
  isImageElement,
  isVideoElement,
  nonInteractiveMediaAt,
  mediaAtPoint,
  videoAnchorAt,
  resolveHoverMedia,
  previewSrcFromMedia,
  previewKeyFromMedia,
  mediaStillUnderPointer,
  type HoverMediaElement,
} from './hover-resolve'

// Stub for getBoundingClientRect (happy-dom computes no layout, so every real
// rect is all-zero); pattern precedent: instagram/adapter.test.ts.
const rect = (left: number, top: number, width: number, height: number) => (): DOMRect =>
  ({ top, left, right: left + width, bottom: top + height, width, height }) as DOMRect

const el = (html: string): Element => {
  const root = document.createElement('div')
  root.innerHTML = html
  return root.firstElementChild!
}

// happy-dom only reflects inline `pointer-events` through getComputedStyle when
// the element is attached to the document (which real hovered media always is).
const mount = <T extends Element>(node: T): T => {
  document.body.appendChild(node)
  return node
}

afterEach(() => {
  document.body.innerHTML = ''
})

const overlay = (): Element => document.createElement('xmd-overlay')

// previewKeyFromMedia only touches these two adapter members.
const fakeAdapter = (opts: {
  mediaKeyFromUrl?: (url: string) => string | null
  postKeyFromVideoElement?: (video: HTMLVideoElement, pathname: string) => string | null
}): PlatformAdapter =>
  ({
    mediaKeyFromUrl: opts.mediaKeyFromUrl ?? (() => null),
    ...(opts.postKeyFromVideoElement
      ? { postKeyFromVideoElement: opts.postKeyFromVideoElement }
      : {}),
  }) as unknown as PlatformAdapter

describe('isImageElement / isVideoElement', () => {
  it('narrows by tagName', () => {
    expect(isImageElement(el('<img>'))).toBe(true)
    expect(isImageElement(el('<video></video>'))).toBe(false)
    expect(isVideoElement(el('<video></video>'))).toBe(true)
    expect(isVideoElement(el('<img>'))).toBe(false)
  })
})

describe('nonInteractiveMediaAt', () => {
  it('reaches a pointer-events:none img whose own rect covers the point', () => {
    const container = mount(el('<div><img></div>'))
    const img = container.querySelector('img')!
    img.style.pointerEvents = 'none'
    img.getBoundingClientRect = rect(0, 0, 100, 100)
    expect(nonInteractiveMediaAt(container, 50, 50)).toBe(img)
  })

  it('skips a media element that is not pointer-events:none', () => {
    const container = mount(el('<div><img></div>'))
    const img = container.querySelector('img')!
    img.getBoundingClientRect = rect(0, 0, 100, 100)
    expect(nonInteractiveMediaAt(container, 50, 50)).toBeNull()
  })

  it('never trusts a pointer-events:none candidate whose rect does not cover the point', () => {
    const cases: Array<[number, number]> = [
      [-1, 50], // x < left
      [101, 50], // x > right
      [50, -1], // y < top
      [50, 101], // y > bottom
    ]
    for (const [x, y] of cases) {
      const container = mount(el('<div><img></div>'))
      const img = container.querySelector('img')!
      img.style.pointerEvents = 'none'
      img.getBoundingClientRect = rect(0, 0, 100, 100)
      expect(nonInteractiveMediaAt(container, x, y)).toBeNull()
      document.body.innerHTML = ''
    }
  })
})

describe('mediaAtPoint', () => {
  it('returns the topmost hoverable img in the stack', () => {
    const top = el('<img>') as HTMLImageElement
    const below = el('<img>') as HTMLImageElement
    expect(mediaAtPoint([top, below], 5, 5)).toBe(top)
  })

  it('finds a video directly in the stack', () => {
    const video = el('<video></video>') as HTMLVideoElement
    expect(mediaAtPoint([video], 5, 5)).toBe(video)
  })

  it('reaches a pointer-events:none img through its wrapper div', () => {
    const wrapper = mount(el('<div><img></div>'))
    const img = wrapper.querySelector('img')!
    img.style.pointerEvents = 'none'
    img.getBoundingClientRect = rect(0, 0, 100, 100)
    expect(mediaAtPoint([wrapper], 50, 50)).toBe(img)
  })

  it('returns null when no media is anywhere in the stack', () => {
    expect(mediaAtPoint([el('<div></div>'), el('<span></span>')], 5, 5)).toBeNull()
  })

  it('skips an ancestor of the media that appears above it in the stack', () => {
    const wrap = el('<div><img></div>')
    const img = wrap.querySelector('img')! as HTMLImageElement
    expect(mediaAtPoint([wrap, img], 5, 5)).toBe(img)
  })

  it('vetoes when this extension XMD-OVERLAY host sits above the media', () => {
    const img = el('<img>') as HTMLImageElement
    expect(mediaAtPoint([overlay(), img], 5, 5)).toBeNull()
  })

  it('vetoes when a modal layer above the media does not contain it', () => {
    const modal = el('<div aria-modal="true"></div>')
    const img = el('<img>') as HTMLImageElement
    expect(mediaAtPoint([modal, img], 5, 5)).toBeNull()
  })

  it('passes when the occluding layer is inside the same modal as the media', () => {
    const modal = el('<div role="dialog"><div class="scrim"></div><img></div>')
    const scrim = modal.querySelector('.scrim')!
    const img = modal.querySelector('img')! as HTMLImageElement
    expect(mediaAtPoint([scrim, img], 5, 5)).toBe(img)
  })

  it('does NOT let a translucent decorative scrim veto a visible Reel (regression: instagram.com/reel/DaHL9NxPBWz)', () => {
    // A see-through rgba(0,0,0,0.5) caption-legibility scrim over the player is
    // NOT a modal — it must never block hover-grab on the video beneath it.
    const wrap = el('<div><div class="scrim"></div><video></video></div>')
    const scrim = wrap.querySelector<HTMLElement>('.scrim')!
    const video = wrap.querySelector('video')! as HTMLVideoElement
    scrim.style.background = 'rgba(0,0,0,0.5)'
    expect(mediaAtPoint([scrim, video], 5, 5)).toBe(video)
  })
})

describe('videoAnchorAt', () => {
  it('reaches the hidden video through target.closest of the player container', () => {
    const player = el('<div data-testid="videoPlayer"><div class="hit"></div><video></video></div>')
    const hit = player.querySelector('.hit')!
    const video = player.querySelector('video')! as HTMLVideoElement
    expect(videoAnchorAt(hit, [])).toBe(video)
  })

  it('reaches the hidden video by walking the stack when target has no player ancestor', () => {
    const player = el('<div data-testid="videoComponent"><video></video></div>')
    const video = player.querySelector('video')! as HTMLVideoElement
    expect(videoAnchorAt(null, [player])).toBe(video)
  })

  it('early-returns null when XMD-OVERLAY is reached before any player in the walk', () => {
    const player = el('<div data-testid="videoPlayer"><video></video></div>')
    expect(videoAnchorAt(null, [overlay(), player])).toBeNull()
  })

  it('returns null when neither target nor stack yields a player video', () => {
    expect(videoAnchorAt(el('<div></div>'), [el('<div></div>')])).toBeNull()
  })
})

describe('resolveHoverMedia', () => {
  it('returns the direct target hit first, ignoring the stack', () => {
    const img = el('<img>') as HTMLImageElement
    expect(resolveHoverMedia(img, [], 5, 5)).toBe(img)
  })

  it('falls back to the topmost stack media when the target is not media', () => {
    const target = el('<div></div>')
    const img = el('<img>') as HTMLImageElement
    expect(resolveHoverMedia(target, [img], 5, 5)).toBe(img)
  })

  it('falls back to the X video anchor when neither target nor stack has visible media', () => {
    const player = el('<div data-testid="videoPlayer"><video></video></div>')
    const video = player.querySelector('video')! as HTMLVideoElement
    expect(resolveHoverMedia(player, [player], 5, 5)).toBe(video)
  })

  it('returns null for a null target with an empty stack', () => {
    expect(resolveHoverMedia(null, [], 5, 5)).toBeNull()
  })
})

describe('previewSrcFromMedia', () => {
  it('uses the grabbable twimg poster for an X video', () => {
    const video = el('<video></video>') as HTMLVideoElement
    video.poster = 'https://pbs.twimg.com/media/ABC.jpg'
    expect(previewSrcFromMedia(video)).toBe('https://pbs.twimg.com/media/ABC.jpg')
  })

  it('falls back to the raw poster/currentSrc/src when no grabbable poster exists', () => {
    const video = el('<video src="blob:reel-123"></video>') as HTMLVideoElement
    expect(previewSrcFromMedia(video)).toBe('blob:reel-123')
  })

  it('uses currentSrc || src for a photo', () => {
    const img = el('<img src="https://cdn.example/p.jpg">') as HTMLImageElement
    expect(previewSrcFromMedia(img)).toBe('https://cdn.example/p.jpg')
  })

  it('falls through to src for a photo with no currentSrc', () => {
    expect(previewSrcFromMedia(el('<img>') as HTMLImageElement)).toBe('')
  })

  it('falls through to src for a video with no poster, currentSrc, or grabbable thumb', () => {
    expect(previewSrcFromMedia(el('<video></video>') as HTMLVideoElement)).toBe('')
  })
})

describe('previewKeyFromMedia', () => {
  const anyImg = (): HTMLImageElement =>
    el('<img src="https://cdn.example/p.jpg">') as HTMLImageElement

  it('returns null for null media', () => {
    expect(previewKeyFromMedia(fakeAdapter({}), null, '/anything')).toBeNull()
  })

  it('returns the url-derived key when the adapter resolves one', () => {
    const adapter = fakeAdapter({ mediaKeyFromUrl: () => 'photo:abc' })
    expect(previewKeyFromMedia(adapter, anyImg(), '/x')).toBe('photo:abc')
  })

  it('returns null for a photo with no url-derivable key', () => {
    expect(previewKeyFromMedia(fakeAdapter({}), anyImg(), '/x')).toBeNull()
  })

  it('falls back to the DOM post-key for a keyless video, threading pathname', () => {
    let seenPathname = ''
    const adapter = fakeAdapter({
      postKeyFromVideoElement: (_v, pathname) => {
        seenPathname = pathname
        return 'post:code:XYZ'
      },
    })
    const video = el('<video src="blob:v"></video>') as HTMLVideoElement
    expect(previewKeyFromMedia(adapter, video, '/reels/XYZ/')).toBe('post:code:XYZ')
    expect(seenPathname).toBe('/reels/XYZ/')
  })

  it('returns null for a keyless video when the adapter has no postKeyFromVideoElement', () => {
    const video = el('<video src="blob:v"></video>') as HTMLVideoElement
    expect(previewKeyFromMedia(fakeAdapter({}), video, '/x')).toBeNull()
  })
})

describe('mediaStillUnderPointer', () => {
  it('is true when the media is directly in the stack', () => {
    const img = el('<img>') as HTMLImageElement
    expect(mediaStillUnderPointer(img, [img], 0, 0)).toBe(true)
  })

  it('is false for a non-video not present in the stack', () => {
    const img = el('<img>') as HTMLImageElement
    expect(mediaStillUnderPointer(img, [el('<div></div>')], 0, 0)).toBe(false)
  })

  it('is false for a video with no player container that is absent from the stack', () => {
    const video = el('<video></video>') as HTMLVideoElement
    expect(mediaStillUnderPointer(video, [el('<div></div>')], 0, 0)).toBe(false)
  })

  it('is true for a hidden video whose player container holds a stack element', () => {
    const player = el('<div data-testid="videoPlayer"><div class="hit"></div><video></video></div>')
    const hit = player.querySelector('.hit')!
    const video = player.querySelector('video')! as HTMLVideoElement
    expect(mediaStillUnderPointer(video, [hit], 0, 0)).toBe(true)
  })

  it('is false when the player container holds nothing in the stack', () => {
    const player = el('<div data-testid="videoPlayer"><video></video></div>')
    const video = player.querySelector('video')! as HTMLVideoElement
    expect(mediaStillUnderPointer(video, [el('<div></div>')], 0, 0)).toBe(false)
  })

  // Regression (LIVE-VERIFIED 2026-08-23, threads.com/@uiuxandrii/post/DcVelsgCBu2):
  // Threads' carousel <img> is position:absolute; pointer-events:none, so it is
  // NEVER in elementsFromPoint — the arm path reaches it via nonInteractiveMediaAt,
  // but the fire-time holdsKey check then saw `stack.includes(img) === false` and
  // dropped every dwell as 'grab-target-stale' (ring charged, nothing downloaded),
  // while the badge click (which never asks "still under pointer") kept working.
  it('is true for a pointer-events:none img whose wrapper is in the stack and whose rect covers the point', () => {
    const wrapper = mount(el('<div><img></div>'))
    const img = wrapper.querySelector('img')!
    img.style.pointerEvents = 'none'
    img.getBoundingClientRect = rect(0, 0, 100, 100)
    expect(mediaStillUnderPointer(img, [wrapper], 50, 50)).toBe(true)
  })

  it('is false for a pointer-events:none img whose rect no longer covers the point', () => {
    const wrapper = mount(el('<div><img></div>'))
    const img = wrapper.querySelector('img')!
    img.style.pointerEvents = 'none'
    img.getBoundingClientRect = rect(0, 0, 100, 100)
    expect(mediaStillUnderPointer(img, [wrapper], 150, 50)).toBe(false)
  })

  it('is false for a pointer-events:none img when no stack element contains it', () => {
    const wrapper = mount(el('<div><img></div>'))
    const img = wrapper.querySelector('img')!
    img.style.pointerEvents = 'none'
    img.getBoundingClientRect = rect(0, 0, 100, 100)
    expect(mediaStillUnderPointer(img, [mount(el('<div></div>'))], 50, 50)).toBe(false)
  })
})

// Structural: the moved type is exactly HTMLImageElement | HTMLVideoElement.
describe('HoverMediaElement', () => {
  it('accepts both an img and a video', () => {
    const media: HoverMediaElement[] = [
      el('<img>') as HTMLImageElement,
      el('<video></video>') as HTMLVideoElement,
    ]
    expect(media).toHaveLength(2)
  })
})
