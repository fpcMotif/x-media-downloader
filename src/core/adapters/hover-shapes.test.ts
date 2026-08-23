// Example-based catalogue: one `it` per live-observed DOM shape, each
// asserting ARM (`resolveHoverMedia`) and FIRE (`mediaStillUnderPointer`)
// agree — the composition `hover-resolve.property.test.ts` generates
// hundreds of synthetic variants of, pinned here to the exact real-world
// shapes that motivated this module's design. Rows where ARM must refuse
// assert null instead.
import { afterEach, describe, expect, it } from 'vitest'
import { resolveHoverMedia, mediaStillUnderPointer, mediaAtPoint } from './hover-resolve'
import { VIDEO_PLAYER_SEL } from './x/dom'

// Stub for getBoundingClientRect (happy-dom computes no layout, so every real
// rect is all-zero); pattern precedent: hover-resolve.test.ts / instagram/adapter.test.ts.
const rect = (left: number, top: number, width: number, height: number) => (): DOMRect =>
  ({ top, left, right: left + width, bottom: top + height, width, height }) as DOMRect

// happy-dom only reflects inline `pointer-events` through getComputedStyle when
// the element is attached to the document (which real hovered media always is).
const mount = <T extends Element>(node: T): T => {
  document.body.appendChild(node)
  return node
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('hover-resolve — live-observed DOM shapes (ARM/FIRE agreement)', () => {
  it('1. Threads carousel slide — pointer-events:none img, absolute, inside 5 nested divs (2026-08-23, threads.com/@uiuxandrii/post/DcVelsgCBu2); stack = the 5 divs, no img', () => {
    const img = document.createElement('img') as HTMLImageElement
    img.src = 'https://scontent.cdninstagram.com/v/carousel-slide.jpg'
    img.style.pointerEvents = 'none'
    img.style.position = 'absolute'
    img.getBoundingClientRect = rect(0, 0, 100, 100)

    // Build 5 nested divs, innermost first, each wrapping the previous node.
    const divs: HTMLDivElement[] = []
    let current: Element = img
    for (let i = 0; i < 5; i++) {
      const div = document.createElement('div')
      div.appendChild(current)
      div.getBoundingClientRect = rect(0, 0, 100, 100)
      divs.push(div)
      current = div
    }
    mount(current) // outermost div

    const stack = divs // topmost (innermost) first, per real elementsFromPoint order
    expect(stack).not.toContain(img)

    expect(resolveHoverMedia(stack[0]!, stack, 50, 50)).toBe(img)
    expect(mediaStillUnderPointer(img, stack, 50, 50)).toBe(true)
  })

  it('2. Threads single photo — pointer-events:none img, static, inside <picture> (2026-08-23, threads.com/.../DcVw7MhlOqF); stack = picture + wrappers', () => {
    const img = document.createElement('img') as HTMLImageElement
    img.src = 'https://scontent.cdninstagram.com/v/single-photo.jpg'
    img.style.pointerEvents = 'none'
    img.getBoundingClientRect = rect(0, 0, 100, 100)

    const picture = document.createElement('picture')
    picture.appendChild(img)
    picture.getBoundingClientRect = rect(0, 0, 100, 100)

    const wrapper = document.createElement('div')
    wrapper.appendChild(picture)
    wrapper.getBoundingClientRect = rect(0, 0, 100, 100)
    mount(wrapper)

    const stack = [picture, wrapper]
    expect(resolveHoverMedia(picture, stack, 50, 50)).toBe(img)
    expect(mediaStillUnderPointer(img, stack, 50, 50)).toBe(true)
  })

  it('3. Threads video card — interactive video, absolute, directly in the stack (2026-08-23, threads.com/.../DcV5mBgE_f-)', () => {
    const video = document.createElement('video') as HTMLVideoElement
    video.style.position = 'absolute'
    video.getBoundingClientRect = rect(0, 0, 100, 100)
    mount(video)

    const stack = [video]
    expect(resolveHoverMedia(video, stack, 50, 50)).toBe(video)
    expect(mediaStillUnderPointer(video, stack, 50, 50)).toBe(true)
  })

  it('4. Instagram feed photo — interactive img directly in the stack (2026-07-05 note in hover-resolve.ts)', () => {
    const img = document.createElement('img') as HTMLImageElement
    img.src = 'https://scontent.cdninstagram.com/v/feed-photo.jpg'
    img.getBoundingClientRect = rect(0, 0, 100, 100)
    mount(img)

    const stack = [img]
    expect(resolveHoverMedia(img, stack, 50, 50)).toBe(img)
    expect(mediaStillUnderPointer(img, stack, 50, 50)).toBe(true)
  })

  it('5. X photo — a transparent hit-target div above the img contains it, so it still arms and holds', () => {
    const img = document.createElement('img') as HTMLImageElement
    img.src = 'https://pbs.twimg.com/media/ABC.jpg'
    img.getBoundingClientRect = rect(0, 0, 100, 100)

    const hitTarget = document.createElement('div')
    hitTarget.appendChild(img)
    hitTarget.getBoundingClientRect = rect(0, 0, 100, 100)
    mount(hitTarget)

    // hitTarget sits topmost in the stack, above the img it contains.
    const stack = [hitTarget, img]
    expect(resolveHoverMedia(hitTarget, stack, 50, 50)).toBe(img)
    expect(mediaStillUnderPointer(img, stack, 50, 50)).toBe(true)
  })

  it("6. X video — hidden video reached through its videoPlayer container; the stack holds the container's child, not the video", () => {
    const player = document.createElement('div')
    player.setAttribute('data-testid', 'videoPlayer')
    expect(player.matches(VIDEO_PLAYER_SEL)).toBe(true)

    const hit = document.createElement('div')
    hit.className = 'hit-target'
    const video = document.createElement('video') as HTMLVideoElement
    video.style.visibility = 'hidden'
    player.appendChild(hit)
    player.appendChild(video)
    mount(player)

    const stack = [hit] // the hidden video is never in elementsFromPoint
    expect(stack).not.toContain(video)

    expect(resolveHoverMedia(hit, stack, 5, 5)).toBe(video) // arms via videoAnchorAt
    expect(mediaStillUnderPointer(video, stack, 5, 5)).toBe(true)
  })

  it('7. Instagram reel — a translucent rgba(0,0,0,.5) scrim above the video does not veto (module doc: alpha is not a veto)', () => {
    const wrap = document.createElement('div')
    const scrim = document.createElement('div')
    scrim.style.background = 'rgba(0,0,0,0.5)'
    scrim.getBoundingClientRect = rect(0, 0, 100, 100)
    const video = document.createElement('video') as HTMLVideoElement
    video.getBoundingClientRect = rect(0, 0, 100, 100)
    wrap.appendChild(scrim)
    wrap.appendChild(video)
    mount(wrap)

    const stack = [scrim, video]
    expect(resolveHoverMedia(scrim, stack, 50, 50)).toBe(video)
    expect(mediaStillUnderPointer(video, stack, 50, 50)).toBe(true)
  })

  it('8a. Lightbox — media inside an [aria-modal="true"] dialog, with the dialog above it in the stack, still arms and holds', () => {
    const dialog = document.createElement('div')
    dialog.setAttribute('aria-modal', 'true')
    const scrim = document.createElement('div')
    scrim.getBoundingClientRect = rect(0, 0, 200, 200)
    const img = document.createElement('img') as HTMLImageElement
    img.src = 'https://scontent.cdninstagram.com/v/lightbox.jpg'
    img.getBoundingClientRect = rect(0, 0, 200, 200)
    dialog.appendChild(scrim)
    dialog.appendChild(img)
    mount(dialog)

    // scrim is the topmost stack element at this point; the dialog is an
    // ancestor of both scrim and img, discovered via `.closest()`.
    const stack = [scrim, img]
    expect(resolveHoverMedia(scrim, stack, 50, 50)).toBe(img)
    expect(mediaStillUnderPointer(img, stack, 50, 50)).toBe(true)
  })

  it('8b. Lightbox — media OUTSIDE a dialog that sits above it in the stack refuses (null)', () => {
    const dialog = document.createElement('div')
    dialog.setAttribute('aria-modal', 'true')
    dialog.getBoundingClientRect = rect(0, 0, 200, 200)
    mount(dialog)

    const img = document.createElement('img') as HTMLImageElement
    img.src = 'https://scontent.cdninstagram.com/v/behind-lightbox.jpg'
    img.getBoundingClientRect = rect(0, 0, 200, 200)
    mount(img)

    const stack = [dialog, img]
    expect(mediaAtPoint(stack, 50, 50)).toBeNull()
    expect(resolveHoverMedia(dialog, stack, 50, 50)).toBeNull()
  })
})
