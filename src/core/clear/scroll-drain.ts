/**
 * Auto-scroll drain for not-mounted clears — the effectful orchestration that
 * pairs with the pure bookkeeping in `./drain`.
 *
 * X virtualizes the timeline (only a small window of articles sits in the DOM at
 * once; a post scrolled past is removed entirely), so a Clear that fires seconds
 * after its download settles usually can't find its post mounted. Rather than drop
 * those, `queue` collects them and the drain scrolls the Likes/Bookmarks list to
 * surface each one — clearing it as it mounts — then restores the user's scroll
 * position. Bounded by a step cap + a bottom-reached guard so it can never spin.
 *
 * The DOM, the timers, the messaging and the actual clear all arrive as injected
 * ports, so the bounded-step / stall-detection / empty-pass-retry loop is testable
 * with a fake scroller and fake timers — the behaviour that was previously trapped
 * in the overlay closure.
 */
import { Option } from 'effect'
import type { ClearScope } from '../schema'
import { pageScope } from './clearer'
import { addPending, makeDrainQueue, readyToClear, type DrainQueue } from './drain'

const DRAIN_DEBOUNCE_MS = 1200
const DRAIN_SCROLL_SETTLE_MS = 600
const DRAIN_MAX_STEPS = 60
const DRAIN_VIEWPORT_FRACTION = 0.9
// A drain pass that clears nothing is NOT proof the work is gone: jumping to the top
// of a deeply-scrolled virtualized feed makes X re-render lazily, so the pending posts
// often haven't mounted yet when the scan reaches where they'll land. Retry a bounded
// number of empty passes (with a longer backoff so the feed can catch up) before
// giving up — otherwise the tail of a batch is stranded whenever its final pass
// happens to surface nothing.
const DRAIN_RETRY_BACKOFF_MS = 2500
const DRAIN_MAX_EMPTY_PASSES = 4
// Consecutive no-progress scroll steps that count as "reached the bottom". A slow
// virtualized re-render after the jump-to-top can stall a step or two before the feed
// extends, so a single stall must not end the scan.
const DRAIN_BOTTOM_STALLS = 3

/** The window-scroll seam: live position + viewport reads, absolute/relative moves. */
export interface ScrollPort {
  /** Current vertical scroll offset (window.scrollY). */
  readonly position: () => number
  /** Scroll to an absolute vertical offset. */
  readonly to: (y: number) => void
  /** Scroll by a relative delta. */
  readonly by: (dy: number) => void
  /** Viewport height (window.innerHeight). */
  readonly viewport: () => number
}

/** The timer seam: a settle-wait inside the loop and a (cancellable) scheduled wake. */
export interface Clock {
  readonly sleep: (ms: number) => Promise<void>
  /** Run `fn` after `ms`; returns a cancel for the pending wake. */
  readonly after: (ms: number, fn: () => void) => () => void
}

/** One scope's clear outcome — the structural shape the drain reports on (a subset of
 *  the overlay's ClearResult, kept here so `core` never imports the entrypoint). */
export interface ClearOutcome {
  readonly scope: ClearScope
  readonly ok: boolean
  readonly noop?: boolean
}

export interface ScrollDrainDeps {
  readonly scroll: ScrollPort
  readonly clock: Clock
  /** Live pathname, read each pass — a mid-batch navigation away ends the drain. */
  readonly path: () => string
  /** Numeric tweetIds of every tweet article mounted right now. */
  readonly liveMountedIds: () => string[]
  /** Clear one mounted tweet across its queued scopes; returns each scope's outcome. */
  readonly clearMounted: (
    tweetId: string,
    scopes: ReadonlyArray<ClearScope>,
    allLists: boolean,
  ) => Promise<ReadonlyArray<ClearOutcome>>
  /** Progress trace sink (drain-start / cleared / drain-end). */
  readonly report: (stage: string, detail: string, tweetId?: string) => void
}

export interface ScrollDrain {
  /** Queue (or re-queue) a not-mounted clear and (re)arm the debounced scroll pass. */
  readonly queue: (tweetId: string, scopes: ClearScope[], allLists: boolean) => void
}

export function makeScrollDrain(deps: ScrollDrainDeps): ScrollDrain {
  const pendingClears: DrainQueue = makeDrainQueue()
  let draining = false
  let cancelDrain: (() => void) | null = null
  let emptyDrainPasses = 0

  async function drainPendingClears(): Promise<void> {
    if (draining || pendingClears.size === 0) return
    // Only auto-scroll on a Likes/Bookmarks list page — the drain is meaningless on the
    // For You feed (NI has no membership to revisit) and must never hijack scrolling
    // elsewhere. A page switch mid-batch just leaves the rest pending (re-seeded on a
    // future download).
    if (Option.isNone(pageScope(deps.path()))) return
    draining = true
    const startY = deps.scroll.position()
    let clearedThisPass = 0
    deps.report('drain-start', `${pendingClears.size} post(s) pending — scanning the list`)
    try {
      // Scan from the TOP: a "download this page" batch is detected as you scroll DOWN,
      // so the cleared posts sit ABOVE wherever you ended up — a down-only scan from the
      // current position would miss most of them.
      deps.scroll.to(0)
      await deps.clock.sleep(DRAIN_SCROLL_SETTLE_MS)
      let noProgress = 0
      // oxlint-disable no-await-in-loop -- a paced scroll pass, one viewport at a time
      for (let step = 0; step < DRAIN_MAX_STEPS && pendingClears.size > 0; step++) {
        for (const id of readyToClear(pendingClears, deps.liveMountedIds())) {
          const p = pendingClears.get(id)
          /* v8 ignore next -- readyToClear only yields ids still in the queue */
          if (p === undefined) continue
          pendingClears.delete(id)
          const results = await deps.clearMounted(id, p.scopes, p.allLists)
          clearedThisPass += 1
          deps.report(
            'cleared',
            results.map((r) => `${r.scope}:${r.ok ? (r.noop ? 'noop' : 'ok') : 'fail'}`).join(' '),
            id,
          )
        }
        if (pendingClears.size === 0) break
        const before = deps.scroll.position()
        deps.scroll.by(Math.round(deps.scroll.viewport() * DRAIN_VIEWPORT_FRACTION))
        await deps.clock.sleep(DRAIN_SCROLL_SETTLE_MS)
        // Scroll didn't advance: either the true bottom, or X hasn't extended the
        // virtualized feed yet (a lazy re-render after the jump to top). Only a run of
        // stalls counts as the bottom, so a slow extension doesn't end the scan before
        // the pending posts mount in.
        if (deps.scroll.position() <= before) {
          noProgress += 1
          if (noProgress >= DRAIN_BOTTOM_STALLS) break
        } else {
          noProgress = 0
        }
      }
      // oxlint-enable no-await-in-loop
    } finally {
      deps.scroll.to(startY) // put the user back where they were
      draining = false
      deps.report('drain-end', `cleared ${clearedThisPass}, ${pendingClears.size} still pending`)
      // Keep going while work remains. A pass that cleared something resets the empty
      // budget and re-runs promptly (more posts settle mid-scroll); a pass that cleared
      // nothing spends one retry of a bounded budget — a longer backoff lets a lazily
      // re-rendering feed catch up — before the drain finally gives up. This stops the
      // tail of a batch being abandoned just because one pass surfaced nothing, without
      // ever spinning forever on posts that genuinely aren't on this list.
      if (pendingClears.size > 0) {
        if (clearedThisPass > 0) {
          emptyDrainPasses = 0
          scheduleDrain()
        } else if (emptyDrainPasses < DRAIN_MAX_EMPTY_PASSES) {
          emptyDrainPasses += 1
          scheduleDrain(DRAIN_RETRY_BACKOFF_MS)
        }
      }
    }
  }

  /** Debounced so a whole batch's not-mounted clears accumulate into ONE scroll pass.
   *  Empty-pass retries pass a longer `delayMs` so the feed can settle before re-scanning. */
  function scheduleDrain(delayMs: number = DRAIN_DEBOUNCE_MS): void {
    if (cancelDrain !== null) cancelDrain()
    cancelDrain = deps.clock.after(delayMs, () => {
      cancelDrain = null
      void drainPendingClears()
    })
  }

  const queue = (tweetId: string, scopes: ClearScope[], allLists: boolean): void => {
    addPending(pendingClears, tweetId, scopes, allLists)
    // Fresh work arrived — restore the full retry budget so earlier empty passes don't
    // count against surfacing these posts.
    emptyDrainPasses = 0
    scheduleDrain()
  }

  return { queue }
}
