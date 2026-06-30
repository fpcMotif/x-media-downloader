/**
 * Whole-list clear: auto-scroll a Likes/Bookmarks list top-to-bottom, clicking
 * every mounted post's clear control on each pass, until the list is empty and the
 * bottom is reached. The sibling of `scroll-drain` — which clears a KNOWN set of
 * not-mounted ids — but this one owns no queue: it clears WHATEVER mounts for the
 * page scope, then stops when a run of passes both clear nothing and can't scroll.
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
  /** Live pathname, read once at run start — a non-list page ends before any scroll. */
  readonly path: () => string
  /** Click the clear control on every mounted clearable post for the page's scope,
   *  paced one at a time; returns how many were clicked this pass. */
  readonly clearVisibleForPage: () => Promise<number>
  /** Progress trace sink (start / end). */
  readonly report: (stage: string, detail: string) => void
}

export interface ListClearResult {
  readonly cleared: number
  readonly reason?: 'not-list-page'
}

export interface ListClear {
  readonly run: () => Promise<ListClearResult>
}

export function makeListClear(deps: ListClearDeps): ListClear {
  const run = async (): Promise<ListClearResult> => {
    // Only Likes/Bookmarks have a clear scope — For You / profiles / search have no
    // membership to remove, and the sweep must never hijack scrolling there.
    if (Option.isNone(pageScope(deps.path()))) {
      deps.report('clear-list-skip', 'not a Likes/Bookmarks list')
      return { cleared: 0, reason: 'not-list-page' }
    }
    const startY = deps.scroll.position()
    let cleared = 0
    let noProgress = 0
    deps.report('clear-list-start', 'scanning the list from the top')
    try {
      deps.scroll.to(0)
      await deps.clock.sleep(SETTLE_MS)
      // oxlint-disable no-await-in-loop -- a paced scroll pass, one viewport at a time
      for (let step = 0; step < MAX_STEPS; step++) {
        const clearedThisStep = await deps.clearVisibleForPage()
        cleared += clearedThisStep
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
    return { cleared }
  }
  return { run }
}
