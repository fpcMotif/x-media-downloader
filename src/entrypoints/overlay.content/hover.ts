/**
 * Quick Grab hover seam — the fire-time guard (`holdsKey`, `liveGrabTarget`)
 * and the hover-focus transition the content script closed over until
 * 2026-08-23. Deps-injected named functions in the `handlers.ts` idiom: the
 * DOM reads arrive through {@link HoverProbe}, so the guard matrix (OV-N6 in
 * docs/testing/2026-06-12-unit-test-design.md) and the re-arm rule are unit-
 * testable while `index.tsx` stays thin wiring.
 *
 * Why this exists: the Threads `pointer-events:none` regression (#92) lived
 * entirely in these closures — ARM found a cloaked `<img>` through its
 * wrapper, FIRE then asked `stack.includes(img)` and dropped every dwell —
 * and no test could reach them.
 */
import type { PlatformAdapter } from '../../core/adapters/types'
import {
  previewKeyFromMedia,
  resolveHoverMedia,
  staleWhy,
  type HoverMediaElement,
  type StaleWhy,
} from '../../core/adapters/hover-resolve'

/** The three DOM reads the fire-time guard needs, injected. */
export interface HoverProbe {
  readonly adapter: PlatformAdapter
  readonly pathname: () => string
  /** The last pointer position (`lastX`/`lastY`). */
  readonly point: () => { readonly x: number; readonly y: number }
  /** `document.elementsFromPoint`, top-most first. */
  readonly stackAt: (x: number, y: number) => readonly Element[]
}

/**
 * Whether `m` is still the armed media at fire-time: attached, the same key,
 * and under the pointer. A hidden X `<video>` is matched via its player
 * container, and a Threads `pointer-events:none` `<img>` via its wrapper + own
 * rect, both inside {@link staleWhy}.
 */
export function holdsKey(probe: HoverProbe, m: HoverMediaElement, key: string): boolean {
  return holdVerdict(probe, m, key) === null
}

/** Why a fired dwell grabbed nothing — the `grab-target-stale` detail
 *  vocabulary (#92). {@link StaleWhy} names which under-pointer rule failed;
 *  `key-drift` is the recycled node now showing different content (the wrong
 *  picture must never download, but the log should say that's WHY it didn't). */
export type GrabMissWhy = StaleWhy | 'key-drift'

/** Attached + same-key + under-pointer, in one place for both the boolean
 *  guard and the miss reason: the two can never drift apart. */
function holdVerdict(probe: HoverProbe, m: HoverMediaElement, key: string): GrabMissWhy | null {
  if (previewKeyFromMedia(probe.adapter, m, probe.pathname()) !== key) return 'key-drift'
  const { x, y } = probe.point()
  return staleWhy(m, probe.stackAt(x, y), x, y)
}

/** The media to grab once the dwell elapses, or why nothing qualified. Prefer
 * the armed node, but X's timeline is virtualized: it can recycle that exact
 * node out from under the pointer mid-dwell. So if the armed node went stale,
 * re-resolve the LIVE media at the pointer once — a fresh node showing the same
 * image at the same spot is still the grab the user asked for — and accept it
 * only if its key still matches. `target: null` ⇒ the media truly moved on;
 * drop the grab, tracing `why`. */
export type LiveGrabTarget =
  | { readonly target: HoverMediaElement; readonly why: null }
  | { readonly target: null; readonly why: GrabMissWhy }

export function liveGrabTarget(
  probe: HoverProbe,
  armed: HoverMediaElement,
  key: string,
): LiveGrabTarget {
  let why = holdVerdict(probe, armed, key)
  if (why === null) return { target: armed, why: null }
  const { x, y } = probe.point()
  const stack = probe.stackAt(x, y)
  const live = resolveHoverMedia(stack[0] ?? null, stack, x, y)
  if (live && live !== armed) {
    const liveWhy = holdVerdict(probe, live, key)
    if (liveWhy === null) return { target: live, why: null }
    why = liveWhy
  }
  return { target: null, why }
}

/** The media/key pair the Quick Grab hover currently focuses (either may be null). */
export interface HoverFocus {
  readonly media: HoverMediaElement | null
  readonly key: string | null
}

export const noHoverFocus: HoverFocus = { media: null, key: null }

/**
 * What `focusHover` must do for a hover sample:
 * - `unchanged`: same media AND same key as the current focus — nothing to do
 *   (this dedup is what keeps a stationary cursor from re-arming every frame);
 * - `arm`: grab mode is active and the sample carries both a media and a key;
 * - `clear`: anything else (no media, media without key, or grab inactive).
 */
export type FocusVerdict = 'unchanged' | 'arm' | 'clear'

export function focusTransition(current: HoverFocus, next: HoverFocus, grabActive: boolean) {
  if (next.key === current.key && next.media === current.media)
    return { focus: current, verdict: 'unchanged' } satisfies {
      readonly focus: HoverFocus
      readonly verdict: FocusVerdict
    }
  const verdict: FocusVerdict = grabActive && next.media && next.key ? 'arm' : 'clear'
  return { focus: next, verdict } satisfies {
    readonly focus: HoverFocus
    readonly verdict: FocusVerdict
  }
}

/**
 * The focus to hold right after grab mode is (re)activated from pointer flags.
 * `releaseAll` (keyup, window blur) keeps the last focus identity so X's `d d`
 * can still target it, which means a fresh press over the SAME media would
 * read as `unchanged` and never re-arm (LIVE-VERIFIED 2026-08-23 on Threads: a
 * window blur during the dwell left the grab silent until the cursor moved to
 * a different image). Forgetting the focus on activation makes the next
 * sample an `arm` — the pointer twin of the keydown path, which overwrites
 * the focus from the live pointer.
 */
export function focusAfterActivation(): HoverFocus {
  return noHoverFocus
}
