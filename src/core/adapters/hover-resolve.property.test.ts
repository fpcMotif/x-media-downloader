// Property-based tests for hover-resolve.ts's ARM (`resolveHoverMedia`) / FIRE
// (`mediaStillUnderPointer`) composition, over a generated SCENE whose
// `elementsFromPoint` stack is SYNTHESIZED from the scene by the documented
// browser hit-test spec: an element is in the stack iff its own rect contains
// the point AND its computed `pointer-events` is not `none`, ordered topmost
// first. THAT RULE IS THE MODEL — it is the exact assumption the 2026-08-23 bug
// (x-media-downloader #92) got wrong: `mediaStillUnderPointer` used to trust `stack.includes(media)`
// alone, which is false for a `pointer-events:none` element by this very same
// spec rule (the real browser never puts such an element in the stack
// either). Encoding the rule explicitly here, instead of re-deriving it ad
// hoc per test, is what makes these properties exercise the same invariant
// the live bug violated, across hundreds of generated shapes instead of the
// handful of DOM fixtures a human thinks to write by hand.
//
// The model is a claim about the browser, not a fact about it — so it is not
// self-certifying. The live CDP loop (`scripts/cdp-xmd-console.mjs`, driven
// against the annotated-screenshot scene captured for x-media-downloader #92)
// remains the check on the model itself: it observes the REAL
// `elementsFromPoint` stack on a real page and confirms it matches what this
// file assumes. These properties are what runs in CI between those live
// checks, not a replacement for them.
import { afterEach, describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import type { PlatformAdapter } from './types'
import {
  mediaAtPoint,
  mediaStillUnderPointer,
  previewKeyFromMedia,
  resolveHoverMedia,
  type HoverMediaElement,
} from './hover-resolve'

afterEach(() => {
  document.body.innerHTML = ''
})

// ---- geometry stubs (same idiom as hover-resolve.test.ts) ------------------
interface Rect {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

const rect = (r: Rect) => (): DOMRect =>
  ({
    top: r.top,
    left: r.left,
    right: r.left + r.width,
    bottom: r.top + r.height,
    width: r.width,
    height: r.height,
  }) as DOMRect

const stubRect = (element: Element, r: Rect): void => {
  ;(element as HTMLElement).getBoundingClientRect = rect(r)
}

const expand = (r: Rect, by: number): Rect => ({
  left: r.left - by,
  top: r.top - by,
  width: r.width + 2 * by,
  height: r.height + 2 * by,
})

const containsPoint = (r: Rect, x: number, y: number): boolean =>
  x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height

// ---- fake adapter: previewKeyFromMedia only touches these two members -----
const fakeAdapter: PlatformAdapter = {
  mediaKeyFromUrl: (url: string) => {
    if (!url.includes('cdninstagram.com')) return null
    const basename = url.slice(url.lastIndexOf('/') + 1)
    return basename ? `photo:${basename}` : null
  },
  postKeyFromVideoElement: (_video: HTMLVideoElement, pathname: string) => `post:${pathname}`,
} as unknown as PlatformAdapter

// ---- scene model -------------------------------------------------------
type MediaKind = 'img' | 'video'
type PointerEventsSpec = 'none' | 'auto'
type PositionSpec = 'static' | 'absolute'
type OccluderKind =
  | 'none'
  | 'overlay'
  | 'dialog-containing'
  | 'dialog-not-containing'
  | 'transparent'

interface SceneSpec {
  readonly mediaRect: Rect
  readonly mediaKind: MediaKind
  readonly pointerEvents: PointerEventsSpec
  readonly position: PositionSpec
  readonly videoHasUsableSrc: boolean
  readonly wrapperDepth: number
  readonly occluderKind: OccluderKind
  readonly occluderRect: Rect
  readonly pointInside: boolean
}

const rectArb: fc.Arbitrary<Rect> = fc.record({
  left: fc.integer({ min: 0, max: 400 }),
  top: fc.integer({ min: 0, max: 400 }),
  width: fc.integer({ min: 4, max: 200 }),
  height: fc.integer({ min: 4, max: 200 }),
})

const sceneArb: fc.Arbitrary<SceneSpec> = fc.record({
  mediaRect: rectArb,
  mediaKind: fc.constantFrom<MediaKind>('img', 'video'),
  pointerEvents: fc.constantFrom<PointerEventsSpec>('none', 'auto'),
  position: fc.constantFrom<PositionSpec>('static', 'absolute'),
  videoHasUsableSrc: fc.boolean(),
  wrapperDepth: fc.integer({ min: 0, max: 4 }),
  occluderKind: fc.constantFrom<OccluderKind>(
    'none',
    'overlay',
    'dialog-containing',
    'dialog-not-containing',
    'transparent',
  ),
  occluderRect: rectArb,
  // Most weight on the cursor being inside the media rect — that's the
  // interesting case (arm/hold); some weight on outside, to exercise misses.
  pointInside: fc.oneof(
    { weight: 4, arbitrary: fc.constant(true) },
    { weight: 1, arbitrary: fc.constant(false) },
  ),
})

/** Deterministic, pure function of the spec's identity fields — re-running it
 *  with the same (mediaKind, videoHasUsableSrc, mediaRect) always yields the
 *  same src, which is exactly what P5 (key stability) needs. */
const mediaSrc = (
  spec: Pick<SceneSpec, 'mediaKind' | 'videoHasUsableSrc' | 'mediaRect'>,
): string => {
  const tag = `${spec.mediaRect.left}x${spec.mediaRect.top}-${spec.mediaRect.width}x${spec.mediaRect.height}`
  if (spec.mediaKind === 'img') return `https://scontent.cdninstagram.com/v/${tag}.jpg`
  return spec.videoHasUsableSrc ? `https://scontent.cdninstagram.com/v/${tag}.mp4` : 'blob:unusable'
}

const createMediaElement = (
  spec: Pick<
    SceneSpec,
    'mediaKind' | 'pointerEvents' | 'position' | 'videoHasUsableSrc' | 'mediaRect'
  >,
): HoverMediaElement => {
  const media = document.createElement(spec.mediaKind) as HoverMediaElement
  media.style.pointerEvents = spec.pointerEvents
  media.style.position = spec.position
  media.setAttribute('src', mediaSrc(spec))
  stubRect(media, spec.mediaRect)
  return media
}

const pointFor = (spec: SceneSpec): { x: number; y: number } =>
  spec.pointInside
    ? {
        x: spec.mediaRect.left + spec.mediaRect.width / 2,
        y: spec.mediaRect.top + spec.mediaRect.height / 2,
      }
    : {
        x: spec.mediaRect.left + spec.mediaRect.width + 1000,
        y: spec.mediaRect.top + spec.mediaRect.height + 1000,
      }

interface BuiltScene {
  readonly media: HoverMediaElement
  readonly stack: Element[]
  readonly target: Element | null
  readonly point: { x: number; y: number }
}

/** Mounts the scene under document.body and synthesizes the `elementsFromPoint`
 *  stack per the header's model — this is the one function every property
 *  below shares, so the model is defined exactly once. */
function buildScene(spec: SceneSpec): BuiltScene {
  const point = pointFor(spec)
  const media = createMediaElement(spec)

  const wrappers: HTMLDivElement[] = []
  let innermost: Element = media
  for (let i = 0; i < spec.wrapperDepth; i++) {
    const wrapper = document.createElement('div')
    wrapper.appendChild(innermost)
    stubRect(wrapper, expand(spec.mediaRect, (i + 1) * 5))
    wrappers.push(wrapper)
    innermost = wrapper
  }

  let mountRoot: Element = innermost
  let dialogEl: Element | null = null
  if (spec.occluderKind === 'dialog-containing') {
    dialogEl = document.createElement('div')
    dialogEl.setAttribute('role', 'dialog')
    dialogEl.appendChild(innermost)
    stubRect(dialogEl, spec.occluderRect)
    mountRoot = dialogEl
  }
  document.body.appendChild(mountRoot)

  let occluderEl: Element | null = dialogEl
  if (spec.occluderKind === 'overlay') {
    occluderEl = document.createElement('xmd-overlay')
    stubRect(occluderEl, spec.occluderRect)
    document.body.appendChild(occluderEl)
  } else if (spec.occluderKind === 'dialog-not-containing') {
    occluderEl = document.createElement('div')
    occluderEl.setAttribute('role', 'dialog')
    stubRect(occluderEl, spec.occluderRect)
    document.body.appendChild(occluderEl)
  } else if (spec.occluderKind === 'transparent') {
    occluderEl = document.createElement('div')
    stubRect(occluderEl, spec.occluderRect)
    document.body.appendChild(occluderEl)
  }

  // ---- synthesize the stack: topmost first, per the header's model. ----
  const stack: Element[] = []
  if (occluderEl && containsPoint(spec.occluderRect, point.x, point.y)) stack.push(occluderEl)
  if (spec.pointerEvents !== 'none' && containsPoint(spec.mediaRect, point.x, point.y))
    stack.push(media)
  for (const [i, wrapper] of wrappers.entries()) {
    if (containsPoint(expand(spec.mediaRect, (i + 1) * 5), point.x, point.y)) stack.push(wrapper)
  }

  return { media, stack, target: stack[0] ?? null, point }
}

// ---- P4's dedicated arbitrary: occluder guaranteed to cover the topmost
// media candidate, restricted to the three occluder kinds occlusion cares
// about, and (for the cloaked-media half) deep enough that ARM has a real
// candidate to walk through — so a `null` result is attributable to the veto
// logic, not to a degenerate "nothing to find" scene. -----------------------
const occlusionArb: fc.Arbitrary<SceneSpec> = fc
  .record({
    mediaRect: rectArb,
    mediaKind: fc.constantFrom<MediaKind>('img', 'video'),
    pointerEvents: fc.constantFrom<PointerEventsSpec>('none', 'auto'),
    position: fc.constantFrom<PositionSpec>('static', 'absolute'),
    videoHasUsableSrc: fc.boolean(),
    wrapperDepth: fc.integer({ min: 0, max: 4 }),
    occluderKind: fc.constantFrom<OccluderKind>(
      'overlay',
      'dialog-containing',
      'dialog-not-containing',
    ),
  })
  .filter((base) => base.pointerEvents === 'auto' || base.wrapperDepth >= 1)
  .map((base) =>
    Object.assign({}, base, { occluderRect: base.mediaRect, pointInside: true as const }),
  )

describe('hover-resolve — ARM/FIRE composition (property-based)', () => {
  it('P1 arm ⇒ hold: whatever ARM resolves to, FIRE confirms it, and the key is stable', () => {
    fc.assert(
      fc.property(sceneArb, (spec) => {
        document.body.innerHTML = ''
        const { media, stack, target, point } = buildScene(spec)
        const resolved = resolveHoverMedia(target, stack, point.x, point.y)
        if (resolved !== media) return true // premise false: vacuously true

        const holds = mediaStillUnderPointer(media, stack, point.x, point.y)
        const keyA = previewKeyFromMedia(fakeAdapter, media, '/')
        const keyB = previewKeyFromMedia(fakeAdapter, media, '/')
        return holds === true && keyA === keyB
      }),
      { numRuns: 300 },
    )
  })

  it('P2 hold ⇒ geometry: a confirmed cloaked media covers the point and some stack element contains it', () => {
    fc.assert(
      fc.property(sceneArb, (spec) => {
        document.body.innerHTML = ''
        const { media, stack, point } = buildScene(spec)
        const holds = mediaStillUnderPointer(media, stack, point.x, point.y)
        if (!holds || spec.pointerEvents !== 'none') return true // premise false

        const coversPoint = containsPoint(spec.mediaRect, point.x, point.y)
        const containedInStack = stack.some((el) => el.contains(media))
        return coversPoint && containedInStack
      }),
      { numRuns: 300 },
    )
  })

  it('P3 movement falsifies hold: a cloaked, armed media stops holding once the pointer or the stack moves', () => {
    fc.assert(
      fc.property(sceneArb, (spec) => {
        document.body.innerHTML = ''
        const { media, stack, target, point } = buildScene(spec)
        const resolved = resolveHoverMedia(target, stack, point.x, point.y)
        if (resolved !== media || spec.pointerEvents !== 'none') return true // premise false

        // (a) the pointer moves off the media's rect entirely.
        const outsideX = spec.mediaRect.left + spec.mediaRect.width + 1000
        const outsideY = spec.mediaRect.top + spec.mediaRect.height + 1000
        const movedAway = mediaStillUnderPointer(media, stack, outsideX, outsideY)

        // (b) the stack no longer has any element that contains the media
        // (e.g. the wrapper chain re-rendered out from under it).
        const strippedStack = stack.filter((el) => !el.contains(media))
        const detached = mediaStillUnderPointer(media, strippedStack, point.x, point.y)

        return movedAway === false && detached === false
      }),
      { numRuns: 300 },
    )
  })

  it('P4 occlusion: XMD-OVERLAY and a non-containing dialog veto; a containing dialog does not', () => {
    fc.assert(
      fc.property(occlusionArb, (spec) => {
        document.body.innerHTML = ''
        const { stack, point } = buildScene(spec)
        const found = mediaAtPoint(stack, point.x, point.y)
        return spec.occluderKind === 'dialog-containing' ? found !== null : found === null
      }),
      { numRuns: 300 },
    )
  })

  it('P5 key stability: re-creating the media node with the same src at the same rect yields the same key', () => {
    fc.assert(
      fc.property(sceneArb, (spec) => {
        document.body.innerHTML = ''
        const a = createMediaElement(spec)
        document.body.appendChild(a)
        const keyA = previewKeyFromMedia(fakeAdapter, a, '/post/123')

        document.body.innerHTML = ''
        const b = createMediaElement(spec)
        document.body.appendChild(b)
        const keyB = previewKeyFromMedia(fakeAdapter, b, '/post/123')

        return keyA === keyB
      }),
      { numRuns: 300 },
    )
  })
})

// Structural: buildScene/mediaSrc are exercised transitively by every
// property above; this just pins the fake adapter's own contract so a typo
// in it can't silently make every property vacuous.
describe('fakeAdapter sanity', () => {
  it('resolves a cdninstagram basename and rejects everything else', () => {
    expect(fakeAdapter.mediaKeyFromUrl('https://scontent.cdninstagram.com/v/abc.jpg')).toBe(
      'photo:abc.jpg',
    )
    expect(fakeAdapter.mediaKeyFromUrl('blob:unusable')).toBeNull()
    expect(fakeAdapter.postKeyFromVideoElement?.(document.createElement('video'), '/x')).toBe(
      'post:/x',
    )
  })
})
