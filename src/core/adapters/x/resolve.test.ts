import { describe, it, expect } from 'vitest'
import { canResolveHoverItem, resolveHoverItem } from './index'
import type { MediaItem } from '@/packages/schema'

/** Build a detached subtree and return its first element, typed by the caller
 *  (e.g. `el<HTMLImageElement>('<img />')`) — every call site's markup root tag
 *  matches the type parameter it asks for. */
const el = <T extends Element = Element>(html: string): T => {
  const root = document.createElement('div')
  root.innerHTML = html.trim()
  // SAFETY: see the doc comment above — the caller's own type argument names
  // the tag its markup's root element actually is.
  return root.firstElementChild as T
}

const videoItem: MediaItem = {
  id: '77-0',
  platform: 'x',
  postId: '77',
  author: 'alice',
  type: 'video',
  url: 'https://video.twimg.com/ext_tw_video/77/pu/vid/1280x720/high.mp4',
  ext: 'mp4',
  index: 0,
  previewUrl: 'https://pbs.twimg.com/ext_tw_video_thumb/77/pu/img/V1.jpg',
}

describe('resolveHoverItem', () => {
  it('returns the tee-detected item by key — the only path for a hovered video', () => {
    const video = el(
      '<video poster="https://pbs.twimg.com/ext_tw_video_thumb/77/pu/img/V1.jpg"></video>',
    )
    const detected = new Map<string, MediaItem>([['V1', videoItem]])
    expect(resolveHoverItem(video, 'V1', detected)).toBe(videoItem)
  })

  it('prefers the tee-detected item over DOM resolution even for a photo element', () => {
    const img = el('<img src="https://pbs.twimg.com/media/P0?format=jpg&name=small" />')
    const detected = new Map<string, MediaItem>([
      ['P0', { ...videoItem, id: 'tee', type: 'photo' }],
    ])
    expect(resolveHoverItem(img, 'P0', detected)!.id).toBe('tee')
  })

  it('falls back to DOM photo resolution when the key is unknown to the tee', () => {
    const img = el<HTMLImageElement>(
      '<img src="https://pbs.twimg.com/media/P0?format=jpg&name=small" />',
    )
    const item = resolveHoverItem(img, 'P0', new Map(), '/alice/status/1790')
    expect(item).toMatchObject({ type: 'photo', postId: '1790', author: 'alice' })
    expect(item!.url).toContain('name=orig')
  })

  it('returns null for a hovered video the tee never captured (no DOM path)', () => {
    const video = el(
      '<video poster="https://pbs.twimg.com/ext_tw_video_thumb/77/pu/img/V1.jpg"></video>',
    )
    expect(resolveHoverItem(video, 'V1', new Map())).toBeNull()
  })

  it('returns null for an image element whose url is not a grabbable photo', () => {
    const img = el('<img src="https://pbs.twimg.com/profile_images/zzz.jpg" />')
    expect(resolveHoverItem(img, 'zzz', new Map())).toBeNull()
  })
})

describe('canResolveHoverItem', () => {
  it('is true when the tee already knows the key, regardless of element type', () => {
    const video = el('<video></video>')
    expect(canResolveHoverItem(video, 'V1', new Map([['V1', videoItem]]))).toBe(true)
  })

  it('is true for a photo element even when the key is unknown (DOM-resolvable)', () => {
    const img = el('<img src="https://pbs.twimg.com/media/P0?format=jpg&name=small" />')
    expect(canResolveHoverItem(img, 'P0', new Map())).toBe(true)
  })

  it('is false for a video element the tee has not seen', () => {
    const video = el('<video></video>')
    expect(canResolveHoverItem(video, 'V1', new Map())).toBe(false)
  })

  it('is false for an image whose url is a video-thumb poster, not a grabbable photo', () => {
    // A `_video_thumb` <img> has a grabbable *preview* key but resolves only via
    // the tee — gating on IMG alone would flash a badge that vanishes on click.
    const img = el('<img src="https://pbs.twimg.com/ext_tw_video_thumb/77/pu/img/V1.jpg" />')
    expect(canResolveHoverItem(img, 'V1', new Map())).toBe(false)
  })

  it('still allows a tee-known key even when the image url is not a grabbable photo', () => {
    const img = el('<img src="https://pbs.twimg.com/ext_tw_video_thumb/77/pu/img/V1.jpg" />')
    expect(canResolveHoverItem(img, 'V1', new Map([['V1', videoItem]]))).toBe(true)
  })

  it('prefers currentSrc over src for a responsive image (the loaded source)', () => {
    // src points at a non-grabbable profile image, but the actually-rendered
    // `currentSrc` is a grabbable media photo — `currentSrc || src` must read it.
    const img = el<HTMLImageElement>('<img src="https://pbs.twimg.com/profile_images/zzz.jpg" />')
    Object.defineProperty(img, 'currentSrc', {
      value: 'https://pbs.twimg.com/media/P0?format=jpg&name=small',
      configurable: true,
    })
    expect(canResolveHoverItem(img, 'P0', new Map())).toBe(true)
  })

  it('falls back to src when currentSrc is empty (not-yet-loaded image)', () => {
    // `currentSrc` is '' before the image loads → the `|| element.src` arm decides.
    const img = el<HTMLImageElement>(
      '<img src="https://pbs.twimg.com/media/P0?format=jpg&name=small" />',
    )
    Object.defineProperty(img, 'currentSrc', { value: '', configurable: true })
    expect(canResolveHoverItem(img, 'P0', new Map())).toBe(true)
  })
})
