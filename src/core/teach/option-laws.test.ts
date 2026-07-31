/**
 * TEACHING ARTIFACT — Lesson 3 ("Make it stick"): the functor & monad laws as
 * property-based tests, over hundreds of random inputs, on the Option monad and
 * on YOUR real Kleisli arrows. Safe to delete (rm -r src/core/teach) once the
 * laws are in your bones. See docs/teach/lessons/0003-laws-as-property-tests.html.
 *
 * Run: bunx vitest run src/core/teach/option-laws.test.ts
 */
import { describe, it } from 'vitest'
import * as fc from 'fast-check'
import { Option } from 'effect'
import { convexOriginPattern } from '@/packages/sync/convex'
import { aria2OriginPattern } from '@/packages/download/aria2'
import { pickVideoVariant } from '@/packages/resolver'

/** Structural equality of two Options (None==None, or Some(x)==Some(y) when x===y). */
const eqOption = <A>(x: Option.Option<A>, y: Option.Option<A>): boolean =>
  Option.isNone(x) ? Option.isNone(y) : Option.isSome(y) && Object.is(x.value, y.value)

// Two arbitrary Kleisli arrows to plug into the laws (A -> Option<B>).
const f = (s: string): Option.Option<number> =>
  s.length > 2 ? Option.some(s.length) : Option.none()
const g = (n: number): Option.Option<string> =>
  n % 2 === 0 ? Option.some(`even:${n}`) : Option.none()

// A generator of arbitrary Option<string> values (mix of Some and None).
const anyOption = fc.oneof(fc.string().map(Option.some), fc.constant(Option.none<string>()))

// Composable pure functions for the functor-composition law (k then h).
const k = (s: string): number => s.length
const h = (n: number): string => `#${n}`

describe('Option — functor laws', () => {
  it('identity:  map(m, x => x) === m', () => {
    fc.assert(
      fc.property(anyOption, (m) =>
        eqOption(
          Option.map(m, (x) => x),
          m,
        ),
      ),
    )
  })

  it('composition:  map(m, h∘k) === map(map(m, k), h)', () => {
    fc.assert(
      fc.property(anyOption, (m) =>
        eqOption(
          Option.map(m, (s) => h(k(s))),
          Option.map(Option.map(m, k), h),
        ),
      ),
    )
  })
})

describe('Option — monad laws', () => {
  it('left identity:  flatMap(some(a), f) === f(a)', () => {
    fc.assert(fc.property(fc.string(), (a) => eqOption(Option.flatMap(Option.some(a), f), f(a))))
  })

  it('right identity:  flatMap(m, some) === m', () => {
    fc.assert(fc.property(anyOption, (m) => eqOption(Option.flatMap(m, Option.some), m)))
  })

  it('associativity:  flatMap(flatMap(m, f), g) === flatMap(m, x => flatMap(f(x), g))', () => {
    fc.assert(
      fc.property(fc.string().map(Option.some), (m) =>
        eqOption(
          Option.flatMap(Option.flatMap(m, f), g),
          Option.flatMap(m, (x) => Option.flatMap(f(x), g)),
        ),
      ),
    )
  })
})

describe('Your functions are lawful Kleisli arrows', () => {
  // Left identity proves a real arrow plugs into the monad correctly.
  it('convexOriginPattern obeys left identity', () => {
    fc.assert(
      fc.property(fc.webUrl(), (u) =>
        eqOption(Option.flatMap(Option.some(u), convexOriginPattern), convexOriginPattern(u)),
      ),
    )
  })

  // Domain property: a parseable URL yields Some(host-only pattern); junk yields None.
  it('aria2OriginPattern: Some for a URL, None for junk', () => {
    fc.assert(fc.property(fc.webUrl(), (u) => Option.isSome(aria2OriginPattern(u))))
    fc.assert(
      fc.property(fc.constantFrom('not a url', '', '???', '/relative/only'), (s) =>
        Option.isNone(aria2OriginPattern(s)),
      ),
    )
  })

  // Domain property: picks the max-bitrate mp4, or None when there is no mp4.
  it('pickVideoVariant selects the highest-bitrate mp4', () => {
    const variantArb = fc.array(
      fc.record({
        content_type: fc.constantFrom('video/mp4', 'application/x-mpegURL', 'video/webm'),
        url: fc.string(),
        bitrate: fc.option(fc.nat(), { nil: undefined }),
      }),
    )
    fc.assert(
      fc.property(variantArb, (arr) => {
        const r = pickVideoVariant(arr as Parameters<typeof pickVideoVariant>[0])
        const mp4 = arr.filter((v) => v.content_type === 'video/mp4')
        if (mp4.length === 0) return Option.isNone(r)
        if (!Option.isSome(r)) return false
        const max = Math.max(...mp4.map((v) => v.bitrate ?? 0))
        return (r.value.bitrate ?? 0) === max
      }),
    )
  })
})
