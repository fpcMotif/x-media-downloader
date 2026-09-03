import { afterEach, describe, expect, it } from 'vitest'
import type { PlatformAdapter } from '../../core/adapters/types'
import {
  focusAfterActivation,
  focusTransition,
  holdsKey,
  liveGrabTarget,
  noHoverFocus,
  type HoverProbe,
} from './hover'

// Stub for getBoundingClientRect (happy-dom computes no layout) — the
// hover-resolve.test.ts idiom: every DOMRect member present, so this is a
// real DOMRect and needs no cast.
const rect = (left: number, top: number, width: number, height: number) => (): DOMRect => ({
  x: left,
  y: top,
  top,
  left,
  right: left + width,
  bottom: top + height,
  width,
  height,
  toJSON: () => ({}),
})

// holdsKey only touches mediaKeyFromUrl; the rest are inert stubs so this
// builds a real, fully-typed PlatformAdapter with no cast (hover-resolve.test.ts idiom).
const adapter: PlatformAdapter = {
  platform: 'threads',
  hostMatch: [],
  cdnHosts: [],
  matchesUrl: () => false,
  mediaKeyFromUrl: (url: string) => {
    const m = /\/([^/?#]+)\.(?:jpg|webp|png)(?:\?|$)/.exec(url)
    return m ? m[1]! : null
  },
  isTrackedResponseUrl: () => false,
  detectFromResponse: () => [],
  detectRenderedMedia: () => [],
  resolveHoverItem: () => null,
  canResolveHoverItem: () => false,
}

afterEach(() => {
  document.body.innerHTML = ''
})

/** A Threads-shaped photo: `<div><div><img></div></div>`, img cloaked or not. */
function threadsPhoto(opts: { cloaked: boolean; name?: string }) {
  const outer = document.createElement('div')
  const inner = document.createElement('div')
  const img = document.createElement('img')
  img.src = `https://scontent.cdninstagram.com/v/t51.82787-15/${opts.name ?? 'photo_1'}.jpg?x=1`
  if (opts.cloaked) {
    img.style.pointerEvents = 'none'
    img.style.position = 'absolute'
  }
  inner.appendChild(img)
  outer.appendChild(inner)
  document.body.appendChild(outer)
  for (const el of [outer, inner, img]) el.getBoundingClientRect = rect(0, 0, 200, 200)
  return { outer, inner, img }
}

/** The hit-test stack the browser would produce for that photo at a point inside it. */
const stackFor = (p: ReturnType<typeof threadsPhoto>, cloaked: boolean): Element[] =>
  cloaked ? [p.inner, p.outer] : [p.img, p.inner, p.outer]

const probe = (stack: readonly Element[], point = { x: 100, y: 100 }): HoverProbe => ({
  adapter,
  pathname: () => '/',
  point: () => point,
  stackAt: () => stack,
})

describe('holdsKey — the fire-time guard matrix (OV-N6, corrected)', () => {
  it('holds an interactive img that is still in the stack', () => {
    const p = threadsPhoto({ cloaked: false })
    expect(holdsKey(probe(stackFor(p, false)), p.img, 'photo_1')).toBe(true)
  })

  it('holds a cloaked (pointer-events:none) img reached through its wrapper — the #92 regression', () => {
    const p = threadsPhoto({ cloaked: true })
    expect(holdsKey(probe(stackFor(p, true)), p.img, 'photo_1')).toBe(true)
  })

  it('refuses a detached node', () => {
    const p = threadsPhoto({ cloaked: true })
    const stack = stackFor(p, true)
    p.img.remove()
    expect(holdsKey(probe(stack), p.img, 'photo_1')).toBe(false)
  })

  it('refuses when the src was swapped (key mismatch)', () => {
    const p = threadsPhoto({ cloaked: true })
    p.img.src = 'https://scontent.cdninstagram.com/v/t51.82787-15/other_2.jpg?x=1'
    expect(holdsKey(probe(stackFor(p, true)), p.img, 'photo_1')).toBe(false)
  })

  it('refuses when the pointer left the media (cloaked: rect no longer covers the point)', () => {
    const p = threadsPhoto({ cloaked: true })
    expect(holdsKey(probe(stackFor(p, true), { x: 300, y: 300 }), p.img, 'photo_1')).toBe(false)
  })

  it('refuses when nothing in the stack contains the media any more (scrolled away)', () => {
    const p = threadsPhoto({ cloaked: true })
    const unrelated = document.createElement('div')
    document.body.appendChild(unrelated)
    expect(holdsKey(probe([unrelated]), p.img, 'photo_1')).toBe(false)
  })
})

describe('liveGrabTarget — stale armed node, fresh node with the same key', () => {
  it('returns the armed node while it still holds', () => {
    const p = threadsPhoto({ cloaked: true })
    expect(liveGrabTarget(probe(stackFor(p, true)), p.img, 'photo_1').target).toBe(p.img)
  })

  it('re-resolves to a recycled node showing the same image at the same spot', () => {
    const old = threadsPhoto({ cloaked: true })
    old.outer.remove() // Threads recycled the slide
    const fresh = threadsPhoto({ cloaked: true })
    expect(liveGrabTarget(probe(stackFor(fresh, true)), old.img, 'photo_1').target).toBe(fresh.img)
  })

  it("misses with why 'key-drift' when the fresh node shows a different image", () => {
    const old = threadsPhoto({ cloaked: true })
    old.outer.remove()
    const fresh = threadsPhoto({ cloaked: true, name: 'different_9' })
    const miss = liveGrabTarget(probe(stackFor(fresh, true)), old.img, 'photo_1')
    expect(miss.target).toBeNull()
    expect(miss.why).toBe('key-drift')
  })

  it("misses with why 'detached' when nothing resolves under the pointer", () => {
    const old = threadsPhoto({ cloaked: true })
    old.outer.remove()
    const miss = liveGrabTarget(probe([]), old.img, 'photo_1')
    expect(miss.target).toBeNull()
    expect(miss.why).toBe('detached')
  })
})

// The `grab-target-stale` detail (#92): the SW log names which rule failed.
describe('liveGrabTarget miss vocabulary', () => {
  it("reports 'rect-miss' when the pointer left a still-mounted cloaked img", () => {
    const p = threadsPhoto({ cloaked: true })
    const miss = liveGrabTarget(probe([], { x: 300, y: 300 }), p.img, 'photo_1')
    expect(miss.target).toBeNull()
    expect(miss.why).toBe('rect-miss')
  })

  it("reports 'not-in-stack' for an interactive img the stack does not reach", () => {
    const p = threadsPhoto({ cloaked: false })
    const unrelated = document.createElement('div')
    document.body.appendChild(unrelated)
    const miss = liveGrabTarget(probe([unrelated]), p.img, 'photo_1')
    expect(miss.target).toBeNull()
    expect(miss.why).toBe('not-in-stack')
  })
})

const img = () => document.createElement('img')

describe('focusTransition / focusAfterActivation — re-arm after a transient release', () => {
  it('arms a new media while grab mode is active', () => {
    const a = img()
    expect(focusTransition(noHoverFocus, { media: a, key: 'k' }, true).verdict).toBe('arm')
  })

  it('is unchanged for the same media+key (a stationary cursor never re-arms per frame)', () => {
    const a = img()
    const f = { media: a, key: 'k' }
    expect(focusTransition(f, { media: a, key: 'k' }, true)).toEqual({
      focus: f,
      verdict: 'unchanged',
    })
  })

  it('clears when the media has no key, or grab mode is inactive', () => {
    const a = img()
    expect(focusTransition(noHoverFocus, { media: a, key: null }, true).verdict).toBe('clear')
    expect(focusTransition(noHoverFocus, { media: a, key: 'k' }, false).verdict).toBe('clear')
  })

  // LIVE-VERIFIED 2026-08-23 (threads.com): a window blur mid-dwell released the
  // grab; the next modifier-held mousemove over the SAME image re-activated grab
  // mode, but the focus still remembered that image, so the sample read as
  // `unchanged` and nothing ever re-armed until the cursor moved to another image.
  it('re-arms the same media after release → activation when the focus is forgotten first', () => {
    const a = img()
    const armed = focusTransition(noHoverFocus, { media: a, key: 'k' }, true)
    expect(armed.verdict).toBe('arm')
    // releaseAll keeps the focus identity (X's `d d` still targets it) …
    const kept = armed.focus
    // … so WITHOUT forgetting, the same sample after re-activation is a silent no-op:
    expect(focusTransition(kept, { media: a, key: 'k' }, true).verdict).toBe('unchanged')
    // and WITH it, the sample arms again:
    expect(focusTransition(focusAfterActivation(), { media: a, key: 'k' }, true).verdict).toBe(
      'arm',
    )
  })
})
