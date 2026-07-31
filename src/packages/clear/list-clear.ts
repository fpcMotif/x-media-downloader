/**
 * Whole-list clear: auto-scroll a Likes/Bookmarks list top-to-bottom, clicking
 * every mounted post's clear control on each pass, until the list is empty and the
 * bottom is reached. The sibling of `scroll-drain` — which clears a KNOWN set of
 * not-mounted ids — but this one owns no queue: it clears WHATEVER mounts for the
 * page scope, then stops when a run of passes both clear nothing and can't scroll.
 *
 * The run is PINNED to the scope it started on: it is authorized for the one list
 * the user pressed the button on, so a mid-run navigation — off every list, or onto
 * the OTHER list — aborts it (see the `startScope` invariant in `run`).
 *
 * Same injected `ScrollPort` + `Clock` seams as the drain, so the bounded-step /
 * stall-detection / restore-position loop is testable with a fake scroller + fake
 * timers, never the real DOM.
 */
import { Option } from 'effect'
import { pageScope } from './clearer'
import type { Clock, ScrollPort } from './scroll-drain'

const SETTLE_MS = 600
const VIEWPORT_FRACTION = 0.9
const MAX_STEPS = 400
const BOTTOM_STALLS = 3

export interface ListClearDeps {
  readonly scroll: ScrollPort
  readonly clock: Clock
  /** Live pathname, read each pass — a mid-sweep navigation off the list, or onto the
   *  OTHER list, ends the run. */
  readonly path: () => string
  /** Click the clear control on every mounted clearable post for the page's scope,
   *  paced one at a time; returns how many were clicked this pass. */
  readonly clearVisibleForPage: () => Promise<number>
  /** Progress trace sink (start / pass / abort / end). */
  readonly report: (stage: string, detail: string) => void
}

export interface ListClearResult {
  readonly cleared: number
  /** Why the run stopped short. `not-list-page`: it never started — the page had no
   *  clear scope at all. `scope-changed`: it started on one list and the live page
   *  scope moved (off every list, or onto the other one) before the scan finished, so
   *  `cleared` is a PARTIAL count and must not be read as a finished list. */
  readonly reason?: 'not-list-page' | 'scope-changed'
}

export interface ListClear {
  readonly run: () => Promise<ListClearResult>
}

export function makeListClear(deps: ListClearDeps): ListClear {
  const run = async (): Promise<ListClearResult> => {
    // Only Likes/Bookmarks have a clear scope — For You / profiles / search have no
    // membership to remove, and the sweep must never hijack scrolling there.
    const start = pageScope(deps.path())
    if (Option.isNone(start)) {
      deps.report('clear-list-skip', 'not a Likes/Bookmarks list')
      return { cleared: 0, reason: 'not-list-page' }
    }
    // The ONE scope this run is authorized for, pinned before the first pass. Every
    // later pass is checked against it, never merely against "is there any scope":
    // this loop runs up to MAX_STEPS × ~1.8s, so a Likes→Bookmarks navigation used to
    // satisfy the old is-there-a-scope bail and keep un-liking posts while the user
    // looked at Bookmarks. Same hazard clear-session.ts:435-437 names on the sweep-seed
    // path ("a Likes sweep could later un-bookmark on navigation") — a scope earned on
    // one list is never inherited by another.
    const startScope = start.value
    const startY = deps.scroll.position()
    let cleared = 0
    let noProgress = 0
    let scopeChanged = false
    deps.report('clear-list-start', 'scanning the list from the top')
    try {
      deps.scroll.to(0)
      await deps.clock.sleep(SETTLE_MS)
      // oxlint-disable no-await-in-loop -- a paced scroll pass, one viewport at a time
      for (let step = 0; step < MAX_STEPS; step++) {
        // Bail the moment the page stops being the list this run started on, whether
        // the user left every list ('none') or switched to the other one. Reported as
        // its own terminal-cause stage: an abort is a PARTIAL run, and the plain
        // `clear-list-end` count below can't distinguish it from a finished list.
        const live = Option.getOrElse(pageScope(deps.path()), () => 'none')
        if (live !== startScope) {
          deps.report(
            'clear-list-abort',
            `reason=${live === 'none' ? 'off-list' : 'scope-switched'} start=${startScope} now=${live} cleared=${cleared}`,
          )
          scopeChanged = true
          break
        }
        const clearedThisStep = await deps.clearVisibleForPage()
        cleared += clearedThisStep
        // Per-pass progress, but only for passes that cleared something — a long
        // scroll over an already-empty list would otherwise flood the bounded
        // trace ring with hundreds of no-op lines.
        if (clearedThisStep > 0)
          deps.report('clear-list-pass', `cleared ${clearedThisStep} this pass`)
        await deps.clock.sleep(SETTLE_MS)
        const before = deps.scroll.position()
        deps.scroll.by(Math.round(deps.scroll.viewport() * VIEWPORT_FRACTION))
        await deps.clock.sleep(SETTLE_MS)
        const advanced = deps.scroll.position() > before
        // The bottom is "nothing cleared AND scroll can't advance", sustained over a
        // run of passes so a lazy virtualized re-render doesn't end the scan early.
        if (clearedThisStep === 0 && !advanced) {
          noProgress += 1
          if (noProgress >= BOTTOM_STALLS) break
        } else {
          noProgress = 0
        }
      }
      // oxlint-enable no-await-in-loop
    } finally {
      deps.scroll.to(startY) // put the user back where they were
      deps.report('clear-list-end', `cleared ${cleared}`)
    }
    return scopeChanged ? { cleared, reason: 'scope-changed' } : { cleared }
  }
  return { run }
}
